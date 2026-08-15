# Visual Regression — homepage

Baseline screenshots that catch unintended visual changes during redesign work.

## Generate baselines (first run, or after an intentional redesign)

```bash
bun --cwd packages/homepage run test:e2e -- --update-snapshots visual.spec.ts
```

PNGs land in `tests/e2e/visual.spec.ts-snapshots/`. Commit them.

## Run the diff

```bash
bun --cwd packages/homepage run test:e2e -- visual.spec.ts
```

Failure diffs go to `test-results/` (gitignored).

## When to regenerate

- Intentional redesign / restyle.
- Brand asset swap.
- Layout-affecting dependency upgrade.

## Routes covered

`tests/e2e/visual-routes.ts` is the single source of truth: `/`, `/downloads`,
`/login`, `/connected`, `/get-started`, `/leaderboard`, `/profile/edit`, and the
`*` catch-all
(exercised as `/this-page-does-not-exist`) at desktop (1280×720) and mobile
(390×844 — iPhone 14 Pro).

Adding a route there also extends the committed-baseline inventory. Commit the
Linux PNGs for the new route, then confirm with:

```bash
bun run --cwd packages/homepage check:snapshot-inventory
```

CI runs the same check before Playwright, so a route added without its
baselines fails with a file-anchored annotation instead of a screenshot diff.

## Dynamic content

Animated elements (`video`, `[data-testid="cloud-video"]`, `.animate-pulse`,
`.animate-spin`, `[data-marquee]`) are masked. Extend the `dynamicMask` helper
in `visual.spec.ts` for new animations.

## How a capture becomes a comparison

`visual.spec.ts` does not use `toHaveScreenshot`. Each test captures through
`captureScreenshotWithQualityRetry` (`tests/e2e/screenshot-quality.ts`) and
compares that exact buffer with `expect(screenshot).toMatchSnapshot(...)`
(`maxDiffPixelRatio: 0.02` at the call site — no config-level screenshot
block exists).

The capture gate guarantees two things before any pixel diff happens:

1. **Quality** — blank or effectively single-color frames are rejected
   (`ScreenshotQualityError`).
2. **Stability** — two consecutive captures must be visually stable:
   byte-identical, or differing in at most the same 2% pixel ratio the
   snapshot comparison allows. This replaces (and mirrors) the settling loop
   `toHaveScreenshot` provided internally, which also re-captured until two
   consecutive frames matched under the pixel tolerance — never under byte
   equality, since PNG compression turns a handful of changed pixels into a
   mostly rewritten byte stream. Without this gate a colorful mid-composite
   WebGL frame would be diffed once and fail. A page that never settles
   inside the attempt budget throws `ScreenshotUnstableError` naming the
   pixel and byte delta between the last two captures, a far better
   diagnostic than a bare pixel-ratio failure.

The artifact suites (`aesthetic-audit`, `contact-sheet-capture`,
`live-routes`) photograph deliberately live pages for human review and opt
out with `requireStable: false`; they keep the quality gate only.

The gate's loop behavior is unit-tested without a browser in
`tests/screenshot-stability.node.test.mjs` (part of `bun run test`).
