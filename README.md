# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/agoes1908/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/agoes1908/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a zero-dependency Node.js command-line tool that applies the edits AI models write — unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls — to a tree of text files. It finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, fully trim-insensitive, with re-indentation at the loosest tier), and it writes every change or none at all, printing what changed or why each edit failed.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

The patch is read from the named file, or from standard input when the argument is absent or `-`. `SPEC.md` in this repository is the full specification the tool is built to. `check.ts` runs the public practice checks against it.

---
<sub>Entered on [make.fun](https://make.fun/?ref=qkk6zyc8&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
