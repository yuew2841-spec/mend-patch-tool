// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Section 5: matching lines, and the file line model (section 3).    */
/* ------------------------------------------------------------------ */

/** A file's lines under its own line break, plus whether it ends with one. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
function trimEndWS(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimWS(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trimEndWS(line);
  return trimWS(line);
}

/** Positions where O matches lines at one tier, at or after `from`; with eofOnly, only occurrences ending at the file's last line. */
function occurrencesAt(lines: string[], O: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const start = Math.max(0, from);
  for (let i = start; i + O.length <= lines.length; i++) {
    if (eofOnly && i + O.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== tierKey(O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

/** The first tier (0, then 1, then 2; 0 only with --strict) at which O occurs at least once. */
function findTier(lines: string[], O: string[], strict: boolean, from: number, eofOnly: boolean): TierHit | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrencesAt(lines, O, t, from, eofOnly);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: `ctx >= 0` means a context line, the file's own matched line at O index ctx; -1 means an added line. */
interface NLine {
  text: string;
  ctx: number;
}

/** The lines that replace a matched block: context lines are the file's own, other lines re-indented at tier 2. */
function buildReplacement(fileLines: string[], at: number, O: string[], N: NLine[], tier: number): string[] {
  if (O.length === 0) return N.map((n) => n.text);
  const F = leadWS(fileLines[at] ?? '');
  const P = leadWS(O[0]!);
  return N.map((n) => {
    if (n.ctx >= 0) return fileLines[at + n.ctx]!;
    if (tier === 2) {
      const t = n.text;
      if (t.trim() !== '' && t.startsWith(P)) return F + t.slice(P.length);
    }
    return n.text;
  });
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs.                                         */
/* ------------------------------------------------------------------ */

interface UHunk {
  A: number;
  O: string[];
  N: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  lastCtxPlusBs: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusBs: boolean;
  hasPlus: boolean;
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNewFile: boolean;
  isDeletedFile: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseDiffPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
  if (m === null) return null;
  return [m[1]!, m[2]!];
}

/** The path on a `--- ` / `+++ ` line: text after the four characters, up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  return (tab >= 0 ? t.slice(0, tab) : t).trim();
}

/** `/dev/null` becomes null; a leading `a/` or `b/` is removed. */
function stripPrefix(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

type BodyLine = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };

function parseHunkBody(lines: string[], start: number, A: number): { hunk: UHunk; next: number } {
  const body: BodyLine[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      j += 1;
    } else if (l.startsWith(' ')) {
      body.push({ kind: 'ctx', text: l.slice(1) });
      j += 1;
    } else if (l.startsWith('-')) {
      body.push({ kind: 'old', text: l.slice(1) });
      j += 1;
    } else if (l.startsWith('+')) {
      body.push({ kind: 'new', text: l.slice(1) });
      j += 1;
    } else if (l.startsWith('\\')) {
      body.push({ kind: 'bs', text: l.slice(1) });
      j += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === 'old') O.push(b.text);
    else if (b.kind === 'new') N.push({ text: b.text, ctx: -1 });
  }
  let lastCtxPlusBs = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') {
      lastCtxPlusBs = body[k + 1] !== undefined && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  let lastPlusBs = false;
  let hasPlus = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'new') {
      hasPlus = true;
      lastPlusBs = body[k + 1] !== undefined && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  return { hunk: { A, O, N, lastCtxPlusBs, lastPlusBs, hasPlus }, next: j };
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let hasPair = false;
  let state: 'none' | 'header' | 'after' = 'none';
  const startSection = (oldP: string | null, newP: string | null): void => {
    cur = { diffOld: oldP, diffNew: newP, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, isNewFile: false, isDeletedFile: false, hunks: [] };
    sections.push(cur);
    hasPair = false;
    state = 'header';
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const paths = parseDiffPaths(line);
      if (paths === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(stripPrefix(paths[0]), stripPrefix(paths[1]));
      i += 1;
      continue;
    }
    if (state === 'none') {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(stripPrefix(headerPath(line)), stripPrefix(headerPath(lines[i + 1]!)));
        cur!.pairOld = cur!.diffOld;
        cur!.pairNew = cur!.diffNew;
        hasPair = true;
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'header' && !hasPair) {
        cur!.pairOld = stripPrefix(headerPath(line));
        cur!.pairNew = stripPrefix(headerPath(lines[i + 1]!));
        hasPair = true;
        i += 2;
        continue;
      }
      startSection(stripPrefix(headerPath(line)), stripPrefix(headerPath(lines[i + 1]!)));
      cur!.pairOld = cur!.diffOld;
      cur!.pairNew = cur!.diffNew;
      hasPair = true;
      i += 2;
      continue;
    }
    if (state === 'header' && line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunkBody(lines, i + 1, Number(m[1]));
      cur!.hunks.push(parsed.hunk);
      i = parsed.next;
      state = 'after';
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('rename from ')) cur!.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur!.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur!.isNewFile = true;
      else if (line.startsWith('deleted file mode')) cur!.isDeletedFile = true;
    }
    i += 1;
  }
  return sections;
}

/** Apply one unified hunk to a file's lines; `d` is the shift from this section's earlier hunks. */
function applyUnifiedHunk(fs: FileState, h: UHunk, d: number, strict: boolean, path: string): void {
  if (h.O.length === 0) {
    let idx = h.A + d;
    if (idx < 0) idx = 0;
    if (idx > fs.lines.length) idx = fs.lines.length;
    const atEnd = idx === fs.lines.length;
    const ins = h.N.map((n) => n.text);
    fs.lines.splice(idx, 0, ...ins);
    if (atEnd) fs.final = !h.lastCtxPlusBs;
    return;
  }
  const found = findTier(fs.lines, h.O, strict, 0, false);
  if (found === null) throw new Fail('no-match', path);
  const target = h.A - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const atEnd = best + h.O.length === fs.lines.length;
  const rep = buildReplacement(fs.lines, best, h.O, h.N, found.tier);
  fs.lines.splice(best, h.O.length, ...rep);
  if (atEnd) fs.final = !h.lastCtxPlusBs;
}

function unifiedEdits(sections: USection[], strict: boolean): Edit[] {
  return sections.map((sec) => {
    const oldP = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
    const newP = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
    const isCreate = oldP === null || sec.isNewFile;
    const isDelete = newP === null || sec.isDeletedFile;
    if (isCreate) {
      const p = newP ?? '';
      const plusLines: string[] = [];
      let lastPlusBs = false;
      for (const h of sec.hunks) {
        if (h.hasPlus) lastPlusBs = h.lastPlusBs;
        for (const n of h.N) if (n.ctx === -1) plusLines.push(n.text);
      }
      const text = plusLines.length === 0 ? '' : plusLines.join('\n') + (lastPlusBs ? '' : '\n');
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      };
    }
    if (isDelete) {
      const p = oldP ?? '';
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const isMove = oldP !== newP;
    const oldPath = oldP ?? '';
    const newPath = newP ?? '';
    const hunks = sec.hunks;
    return (tree: Tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const fs = splitFile(before);
      let d = 0;
      for (const h of hunks) {
        applyUnifiedHunk(fs, h, d, strict, oldPath);
        d += h.N.length - h.O.length;
      }
      const out = joinFile(fs);
      if (isMove) {
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        tree.moves.push({ old: oldPath, new: newPath });
      } else {
        tree.now.set(oldPath, out);
      }
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks.                                 */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

function srEdits(blocks: SRBlock[], strict: boolean): Edit[] {
  return blocks.map((b) => {
    const p = b.path;
    const oldLines = b.oldLines;
    const newLines = b.newLines;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const fs = splitFile(before);
      const found = findTier(fs.lines, oldLines, strict, 0, false);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const at = found.occ[0]!;
      const rep = buildReplacement(fs.lines, at, oldLines, newLines.map((t) => ({ text: t, ctx: -1 })), found.tier);
      fs.lines.splice(at, oldLines.length, ...rep);
      tree.now.set(p, joinFile(fs));
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches.                                           */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  O: string[];
  N: NLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

const V_SECTION_RE = /^\*\*\* (Add File|Delete File|Update File):(.*)$/;

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const m = V_SECTION_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'delete' : 'update';
    const path = m[2]!.trim();
    const rawStart = i + 1;
    const raw: string[] = [];
    let j = rawStart;
    while (j < last) {
      const l = lines[j]!;
      if (!blank(l) && V_SECTION_RE.test(l)) break;
      raw.push(l);
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const lineNo = (k: number): number => rawStart + k + 1;
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${lineNo(k)}`);
      }
      sections.push({ kind, path, lines: fileLines, moveTo: null, chunks: [] });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${lineNo(0)}`);
      sections.push({ kind, path, lines: [], moveTo: null, chunks: [] });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to:')) {
        moveTo = raw[0]!.slice('*** Move to:'.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const close = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (k < raw.length) {
        const l = raw[k]!;
        if (l.startsWith('@@')) {
          close();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, O: [], N: [], eof: false };
          k += 1;
          continue;
        }
        if (l.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo(k)}`);
          cur.eof = true;
          close();
          k += 1;
          continue;
        }
        if (l.startsWith('*** Move to:')) throw new Exit2(`error: parse ${lineNo(k)}`);
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) cur = { anchor: null, O: [], N: [], eof: false };
          if (l === '') {
            cur.O.push('');
            cur.N.push({ text: '', ctx: cur.O.length - 1 });
          } else if (l.startsWith(' ')) {
            const t = l.slice(1);
            cur.O.push(t);
            cur.N.push({ text: t, ctx: cur.O.length - 1 });
          } else if (l.startsWith('-')) cur.O.push(l.slice(1));
          else cur.N.push({ text: l.slice(1), ctx: -1 });
          k += 1;
          continue;
        }
        throw new Exit2(`error: parse ${lineNo(k)}`);
      }
      close();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      sections.push({ kind, path, lines: [], moveTo, chunks });
    }
    i = j;
  }
  return sections;
}

function v4aEdits(sections: VSection[], strict: boolean): Edit[] {
  return sections.map((sec) => {
    const p = sec.path;
    if (sec.kind === 'add') {
      const text = sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n';
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      };
    }
    if (sec.kind === 'delete') {
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const moveTo = sec.moveTo;
    const chunks = sec.chunks;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const fs = splitFile(before);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const hit = findTier(fs.lines, [ch.anchor], strict, cursor, false);
          if (hit === null) throw new Fail('no-match', p);
          cursor = hit.occ[0]! + 1;
        }
        if (ch.O.length === 0) {
          const idx = ch.eof ? fs.lines.length : cursor;
          const ins = ch.N.map((n) => n.text);
          fs.lines.splice(idx, 0, ...ins);
          cursor = idx + ins.length;
        } else {
          const found = findTier(fs.lines, ch.O, strict, cursor, ch.eof);
          if (found === null) throw new Fail('no-match', p);
          const at = found.occ[0]!;
          const rep = buildReplacement(fs.lines, at, ch.O, ch.N, found.tier);
          fs.lines.splice(at, ch.O.length, ...rep);
          cursor = at + rep.length;
        }
      }
      const out = joinFile(fs);
      if (moveTo !== null) {
        tree.now.set(p, null);
        tree.now.set(moveTo, out);
        tree.moves.push({ old: p, new: moveTo });
      } else {
        tree.now.set(p, out);
      }
    };
  });
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(parseUnified(lines), strict);
    else if (kind === 'search-replace') edits = srEdits(parseSearchReplace(lines), strict);
    else edits = v4aEdits(parseV4a(lines), strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const coveredOld = new Set<string>();
  const coveredNew = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const wasNew = tree.original(m.new);
    if (wasOld !== null && tree.get(m.old) === null && wasNew === null && tree.get(m.new) !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      coveredOld.add(m.old);
      coveredNew.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (coveredOld.has(p) || coveredNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const texts = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
