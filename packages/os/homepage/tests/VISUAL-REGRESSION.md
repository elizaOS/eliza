# Visual Regression — os-homepage

Baseline screenshots that catch unintended visual changes during redesign work.

## Generate baselines (first run, or after an intentional redesign)

```bash
bun --cwd packages/os/homepage run test:e2e -- --update-snapshots visual.spec.ts
```

(If no `test:e2e` script exists, run `bunx playwright test --update-snapshots visual.spec.ts`
from the package directory.)

PNGs land in `tests/visual.spec.ts-snapshots/`. Commit them.

## Run the diff

```bash
bun --cwd packages/os/homepage run test:e2e -- visual.spec.ts
```

Failure diffs go to `test-results/` (already gitignored).

## When to regenerate

- Intentional redesign / restyle.
- Hardware page imagery swap.
- Layout-affecting dependency upgrade.

## Routes covered

`/`, `/hardware/{usb,case,raspberry-pi,mini-pc,phone,box,chibi-usb}`,
`/checkout`, `/checkout/success`, `/checkout/cancel` at desktop (1280×720)
and mobile (390×844 — iPhone 14 Pro).

## Dynamic content

Animated elements are masked (`video`, `.animate-pulse`, `.animate-spin`,
`[data-marquee]`). Extend the `dynamicMask` helper in `visual.spec.ts` for new
animations.

## Config notes

`playwright.config.ts` runs against the production build via `vite preview`
(`bun run build && vite preview`). First run will be slow; subsequent runs
reuse the existing server when not on CI.

It does not declare an `expect.toHaveScreenshot` tolerance — consider adding
`maxDiffPixelRatio: 0.02` if anti-aliasing produces spurious diffs.
