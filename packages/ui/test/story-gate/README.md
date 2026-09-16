# Story Gate

Renders **every** Storybook story in headless Chromium and asserts it is
healthy — turning the 1,400+ story catalog from "manual review only" into a
deterministic gate CI can enforce.

It reuses Storybook's own static build (`build-storybook`), so the gate inherits
the full module-resolution graph from `.storybook/main.ts` (all the `@elizaos/*`
aliases and native/host stubs) — no parallel bundler config to drift.

## What it checks per story

| Check | Source | Fails build? |
|-------|--------|:---:|
| Story threw on render | Storybook `.sb-show-errordisplay` / `nopreview` | yes |
| Story `play` interaction did not finish | Storybook preview render phase | yes |
| Story tagged `play-fn` has no runtime `playFunction` | Storybook story store | yes |
| Uncaught `pageerror` | Playwright | yes |
| Blank / one-color render | `sharp` (downscaled distinct-color count) | yes |
| Actionable console error after static-harness filters | Playwright `console` | yes |
| Serious/critical a11y violation | injected `axe-core` | yes |
| Screenshot | Playwright | captured always |

The gate has no per-story allowlist or baseline. It filters the static catalog's
generic missing-public-asset error and the missing-`AppProvider` harness wrapper;
every remaining console error and every serious or critical axe violation fails.

## Determinism

Before any story code runs, `determinism-shim.mjs` is injected to pin the clock
(`Date`/`Date.now`), seed `Math.random`/`crypto.randomUUID`, force `Intl` +
`toLocale*` to `en-US`/UTC, freeze `performance.now`, and disable CSS
animations/transitions. Combined with a fixed viewport and `reducedMotion`, every
screenshot is byte-stable across machines and runs, which is what makes the
artifacts diffable and the a11y results reproducible. The frozen instant matches
the unit-test helper in `../determinism.ts`.

## Running

```bash
# 1. build the static catalog (once; CI caches it)
bun run --cwd packages/ui build-storybook --output-dir storybook-static

# 2. run the gate
bun run --cwd packages/ui audit:stories                 # full catalog
node test/story-gate/run-story-gate.mjs --section Primitives   # one section
node test/story-gate/run-story-gate.mjs --shard 1/4            # CI shard
node test/story-gate/run-story-gate.mjs --grep button --no-a11y
```

CI runs the catalog as eight deterministic shards. Each shard writes the same
`report.json` contract plus its screenshots and frontend logs. The aggregate
job reads `storybook-static/index.json`, requires all eight shard reports, and
fails closed when a shard is missing, a story is duplicated, a story is missing
from the union, or an unexpected story id appears. A shard's own failures are
preserved in the aggregate report before the aggregate job exits non-zero.

```bash
node test/story-gate/merge-story-gate.mjs \
  --catalog storybook-static/index.json \
  --input test/story-gate/shards \
  --out test/story-gate/output \
  --shards 8
```

Useful flags: `--concurrency N`, `--limit N`, `--no-screenshots`, and
`--no-a11y`.

## Outputs (`test/story-gate/output/`)

- `report.json` — machine-readable per-story verdicts + `failures[]` +
  `totals.playPrepared/playExpected`.
- `contact-sheet.html` — gallery; broken=red, warn=orange border.
- `screenshots/<storyId>.png` — deterministic per-story captures.

## Reusable pieces

- `determinism-shim.mjs` — browser-side determinism, usable by any
  Playwright/esbuild harness (the `__e2e__` runners can adopt it).
- `log-capture.mjs` — structured frontend console/network/error capture that
  writes a durable JSON artifact matching the `AGENTS.md` convention. The
  gate wires it per story; the aggregated capture (including failed/erroring
  network responses + request failures) lands in `output/frontend-logs.json`.
