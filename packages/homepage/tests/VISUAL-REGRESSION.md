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

`/`, `/login`, `/connected`, `/get-started`, `/leaderboard` at desktop
(1280×720) and mobile (390×844 — iPhone 14 Pro).

## Dynamic content

Animated elements (`video`, `[data-testid="cloud-video"]`, `.animate-pulse`,
`.animate-spin`, `[data-marquee]`) are masked. Extend the `dynamicMask` helper
in `visual.spec.ts` for new animations.

## Config notes

The package `playwright.config.ts` does not declare an `expect.toHaveScreenshot`
block — Playwright defaults apply (`maxDiffPixels: 0`, strict). Consider
adding `maxDiffPixelRatio: 0.02` there if anti-aliasing noise produces
spurious diffs on CI.
