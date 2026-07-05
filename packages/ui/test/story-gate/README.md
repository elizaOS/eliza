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
| **New** console error (vs baseline) | Playwright `console` | yes |
| **New** serious/critical a11y violation (vs baseline) | injected `axe-core` | yes |
| Screenshot | Playwright | captured always |

Console errors and a11y violations are tracked against committed **baselines**
(`baseline/console-baseline.json`, `baseline/a11y-baseline.json`) using the
eslint-baseline pattern: the pre-existing backlog is recorded so it is visible
and burn-down-able, while any *new* regression fails the build immediately.

## Determinism

Before any story code runs, `determinism-shim.mjs` is injected to pin the clock
(`Date`/`Date.now`), seed `Math.random`/`crypto.randomUUID`, force `Intl` +
`toLocale*` to `en-US`/UTC, freeze `performance.now`, and disable CSS
animations/transitions. Combined with a fixed viewport and `reducedMotion`, every
screenshot is byte-stable across machines and runs, which is what makes the
artifacts diffable and the a11y results reproducible. The frozen instant matches
the unit-test helper in `../determinism.ts`.

`audit:ui-determinism` (`packages/scripts/audit-ui-determinism.mjs`) statically
prevents new render-time nondeterminism from entering components in the first
place.

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

Useful flags: `--concurrency N`, `--limit N`, `--no-screenshots`, `--no-a11y`,
`--update-baseline` (regenerate the console + a11y baselines after an
intentional change).

## Outputs (`test/story-gate/output/`)

- `report.json` — machine-readable per-story verdicts + `failures[]` +
  `totals.playPrepared/playExpected`.
- `contact-sheet.html` — gallery; broken=red, warn=orange border.
- `screenshots/<storyId>.png` — deterministic per-story captures.

## Reusable pieces

- `determinism-shim.mjs` — browser-side determinism, usable by any
  Playwright/esbuild harness (the `__e2e__` runners can adopt it).
- `log-capture.mjs` — structured frontend console/network/error capture that
  writes a durable JSON artifact matching the `PR_EVIDENCE.md` convention. The
  gate wires it per story; the aggregated capture (including failed/erroring
  network responses + request failures) lands in `output/frontend-logs.json`.
