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
- **`mobile-chromium`: ROTTED — 15/16 red.** The unwatched lane surfaced the
  decay first, but the repair pass proved the deeper truth: **the 9
  decomposed-view failures were not viewport-specific.** The decomposed
  personal-assistant views were unified into author-once spatial views
  (`CalendarView`→`CalendarSpatialView`, `TodosView`→`TodosSpatialView`, …),
  which removed the per-view `<h1>` headings, `lifeops-calendar-section`
  testid, `/relationships` `data-graph-container`, and `aria-pressed` chips
  the specs asserted — on **both** desktop and Pixel 7 (identical DOM). The
  same 9 specs reproduce red on desktop `chromium` against a freshly rebuilt
  stub stack; the historical desktop green rode stale pre-unification
  `dist/views/bundle.js` artifacts.

## Repair outcome (same branch)

The specs were rewritten to per-view **semantic** assertions (populated
agenda/lanes/threads + a driven filter/mode interaction each, asserting the
server-query narrowing — never "no page error"), the real CDP pinch was
retargeted to the actual zoom surface (`/apps/relationships`) with the
gesture anchored to the visible container∩viewport intersection, and the
diagnostics guard gained a narrow, endpoint-scoped allowlist for the
expected-negative avatar/background existence probes. Verified:
`--project=mobile-chromium` **16/16 green** and the same specs on desktop
`--project=chromium` **16/16 green**, both against an isolated stub stack.

Two REAL product bugs surfaced by the repair (worked around in-spec with
`KNOWN BUG` markers, filed separately, not papered over):

1. `ShellBackButton` (fixed `left-3 top-3 z-[60]`) **occludes the first
   filter chip** of the unified spatial views on desktop AND mobile —
   `document.elementFromPoint` at the chip centers returns the back button;
   users cannot tap those chips.
2. `[data-graph-container]` at `/apps/relationships` tracks the zoomed SVG
   instead of clipping to its parent — an 1188px-wide box on a 412px
   viewport blows out horizontal layout on Pixel 7.

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
