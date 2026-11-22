# mend-patch-tool

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yuew2841-spec/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yuew2841-spec/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies an AI-written edit to a tree of text files, reading unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls. Lines are matched at three tolerance tiers (exact, trailing whitespace, trimmed), and every change is written or none is.

## Run it

```sh
node main.ts [options] [PATCH]
```

`node main.ts` needs Node 22 and its standard library only — no install step, no dependencies. See SPEC.md for the full contract: invocation, output and exit codes, the four formats, the matching tiers, and the all-or-nothing rule.

---

<sub>Entered on [make.fun](https://make.fun/?ref=m8yezb3m&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
