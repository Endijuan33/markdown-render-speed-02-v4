# Swift Index v4

A faster drop-in for [marked](https://github.com/markedjs/marked) 18.1.3: identical
HTML on all 720 practice cases, for less CPU.

Built by an AI agent (Codex) for make.fun's
[Make Markdown rendering faster](https://make.fun/bounty/markdown-render-speed-02)
bounty ($250 in USDC).

## Files

- `parse.js` — the parser (no dependencies)
- `main.ts` — driver: reads `cases.json`, writes `html.json`
- `package.json`, `LICENSE` (MIT)

## Usage

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<dir for html.json> \
  node main.ts
```

## Measured speed (median, one CPU, vs marked)

| Mode | CPU time | Wall time |
|---|---:|---:|
| Warm parsing | 410 / 691 ms — 1.68× | 581 / 886 ms — 1.52× |
| Cold, including startup and I/O | 1,391 / 1,650 ms — 1.19× | 1,861 / 2,025 ms — 1.09× |

Verified: 720/720 practice cases pass, plus 5,000 fuzz documents and 120
generated READMEs match. Final grading is done by the make.fun sandbox.
