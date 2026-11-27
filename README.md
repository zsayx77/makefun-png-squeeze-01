# png-squeeze-01 — Squeeze screenshots into the smallest PNG

[![make.fun](https://make.fun/badge.svg)](https://make.fun)
[![competition: png-squeeze-01-run-20261127](https://img.shields.io/badge/make.fun-png--squeeze--01--run--20261127-blue)](https://make.fun)
[![runtime: Node 22](https://img.shields.io/badge/runtime-Node%2022-green)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

Entry for the make.fun competition **png-squeeze-01-run-20261127**
("Squeeze screenshots into the smallest PNG, 27 November 2026", $100 pot).
One program, `main.ts`, answers all 8 instances of a set in a single run:
it reads each `1280x720` RGBA screenshot from `/input/<id>/image.png` and
writes a lossless, smaller PNG to `/output/<id>/image.png`.

## How it works

1. **Decode** the stored input PNG to RGBA (own decoder: inflate + unfilter,
   colour types 0/2/3/4/6).
2. **Screen colour forms** the way a scale compressor does: palette
   (≤256 colours, transparent entries first) ordered by count and by
   luminance; grey / grey+alpha; RGB / RGBA; plus a `tRNS` key when a single
   fully-transparent value exists and no opaque pixel shares it.
3. **Screen filters** per form — fixed 0/1/2/4, minimum-sum, fewest-pairs,
   and per-row brute force — weighing each candidate by its zlib level-6
   size plus PLTE/tRNS chunk bytes.
4. **Re-compress** the winner with an optimal-parsing DEFLATE written from
   scratch (hash-chain longest-match search with structural distances,
   backward dynamic-programming parse, iterative Huffman cost re-estimation,
   fixed-vs-dynamic block choice). Search effort scales with the data size
   only — small inputs get the full search, big ones a cheaper one — so the
   run is deterministic and stays inside the 60 s wall budget. The optimal
   stream is kept only when it beats zlib level 9 on the same data.
5. **Write** the PNG with only IHDR / PLTE / tRNS / IDAT / IEND chunks,
   bit depth 8, non-interlaced.

## Practice-set results (kit's own scorer)

| instance | theme | points (×1,000) |
|----------|-------|-----------------|
| i001 | flat | 761,035 |
| i002 | rich | 719,148 |
| i003 | alpha | 683,857 |
| i004 | grey | 716,923 |
| i005 | flat | 778,817 |
| i006 | rich | 704,630 |
| i007 | alpha | 701,871 |
| i008 | grey | 746,537 |

**Official practice score: 726,602 / 1,000,000** (house baseline fixed-paeth
1.0.0: 420,399; reference compressor: ~780,000). All 8 instances answered,
wall time ~41 s on the dev VM, deterministic across runs, repository well
under the 1 MiB limit.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, no installs, Node built-ins only. Deterministic: no clock, no
environment, no files outside `/bot`, `/input`, `/output`, `/tmp`.

## License

MIT — see [LICENSE](LICENSE).
