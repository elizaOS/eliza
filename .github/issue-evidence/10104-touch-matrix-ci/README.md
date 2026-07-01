# #10104 Tier-2 — wire the real-touch Playwright device matrix into CI

## What was dark

`packages/app/playwright.ui-smoke.config.ts` has long defined touch-enabled
projects — Pixel 7 `mobile-chromium` (`hasTouch`, real CDP touch specs) and the
`dashboard-*` device matrix (mobile-portrait 390×844, mobile-landscape 844×390,
iPad portrait 820×1180, desktop 1440×900) — but **no workflow ever invoked
them**: every ui-smoke CI job pins `--project=chromium`. The issue's "dead
touch matrix" finding, confirmed.

The `mobile-chromium` testMatch also still referenced `backgrounds.spec.ts`,
deleted 2026-06-03 in b499f06e9e7 — a dead pattern fragment silently matching
nothing.

## First full local re-run (2026-07-01, all five projects, one invocation)

```
15 failed   — ALL in [mobile-chromium] (Pixel 7)
 4 skipped  — character-editor live-stack gate (as on desktop chromium)
13 passed   — the entire dashboard-* device matrix
(51.6m wall clock, loaded machine)
```

- **`dashboard-*` matrix: GREEN.** browser-workspace, wallet-inventory,
  workflow-editor pass on every touch viewport; character-editor skips exactly
  as it does on the desktop lane (live-stack gate).
- **`mobile-chromium`: ROTTED — 15/16 red.** The unwatched lane decayed while
  the same specs stayed green on desktop chromium. Representative root cause
  (todos decomposed view): the page snapshot shows the todo lanes fully
  rendered ("Today (1) … Upcoming (1) … Someday (1)") but the spec asserts a
  desktop-only `Todos` heading that the mobile layout replaces with a
  "Go back" button. Desktop-only assertions, not (so far) mobile product bugs.

## What this change does

- `scenario-pr.yml`: adds `app-browser-touch-dashboard` running the four
  `dashboard-*` projects (verified green above).
- `scenario-pr.yml`: adds `app-browser-touch-mobile` running `mobile-chromium`
  (added together with the spec repairs that make it green — see the sibling
  commits in this PR).
- `playwright.ui-smoke.config.ts`: drops the dead `backgrounds` testMatch
  fragment.

The exact rot this run surfaced is the argument for the wiring: an unexecuted
test project is worse than none — it reads as coverage while decaying.
