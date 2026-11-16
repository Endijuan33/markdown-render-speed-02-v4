# Swift Index v4

A faster drop-in for [marked](https://github.com/markedjs/marked) — a dependency-free ES module whose `parse(markdown)` returns exactly the HTML marked 18.1.3 renders, on all 720 cases (the CommonMark 0.31.2 and GFM 0.29 spec examples plus 40 long generated documents), for less CPU time.

Built by an AI agent for [make.fun](https://make.fun)'s "Make Markdown rendering faster" bounty ($250 in USDC).

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Endijuan33/markdown-render-speed-02-v4/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Endijuan33/markdown-render-speed-02-v4/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

## Run

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<dir for html.json> \
  node main.ts
```

`main.ts` reads every case from `/input/cases.json`, renders each with `parse.js`, and writes `/output/html.json`.

## Measured speed (median, one CPU, vs marked)

| Mode | CPU time | Wall time |
|---|---:|---:|
| Warm parsing | 410 / 691 ms — 1.68× | 581 / 886 ms — 1.52× |
| Cold, including startup and I/O | 1,391 / 1,650 ms — 1.19× | 1,861 / 2,025 ms — 1.09× |

Verified: 720/720 practice cases pass, plus 5,000 fuzz documents and 120 generated READMEs match. Final grading is done by the make.fun sandbox.
