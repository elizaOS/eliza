# #10717 — smooth mobile view-to-view swipe + web/desktop `< >` edge buttons

**Verdict: `good`.**

## What changed

`useHorizontalPager` (the single pager shared by the home↔launcher rail and the
launcher app-pages):

1. **Velocity-aware momentum settle.** The old settle used a fixed `SETTLE_MS`
   (360) / `SNAP_BACK_MS` (280) regardless of flick speed — the "jerky"
   constant-rate snap. Now the settle duration is derived from the release
   velocity (`momentumSettleMs(remainingPx, velocity)`, clamped to
   `[130, 440]ms`): a fast flick lands quick, a slow drag eases in. The
   drag-follow path stays rAF-driven. Because a committed swipe advances the
   controlled `page` (re-running the layout effect), the velocity-derived
   duration is parked in `pendingSettleMsRef` so the momentum survives the
   controlled-page update instead of being overwritten by the fixed rate.
2. **Edge-button surface.** New binding outputs `canPrev` / `canNext` /
   `goPrev()` / `goNext()` (one page each, reusing `clampPage` + the
   `onPageChange` path). New shared `PagerEdgeButtons` renders icon-only
   `ChevronLeft` / `ChevronRight` on the vertical center of the left/right edges,
   **fine-pointer gated** (`(hover: hover) and (pointer: fine)`) so they appear
   only on web/desktop and never on touch. Each arrow self-hides at the
   first/last page. Wired into `Launcher.tsx` (app pages, `idPrefix="launcher"`)
   and `HomeLauncherSurface.tsx` (rail, `idPrefix="rail"`, shown only while the
   rail owns the gesture so the two arrow sets never stack on one edge).

## Tests (all green)

- `useHorizontalPager.test.tsx` — drives **real** React pointer events through
  the hook (mocked `performance.now` for deterministic velocity) and reads the
  transition the hook writes: proves a fast flick settles quicker than a slow
  drag over the same distance, sub-threshold nudge snaps back, and
  `goPrev`/`goNext`/`canPrev`/`canNext` page exactly one view.
- `PagerEdgeButtons.test.tsx` — fine-pointer gate (nothing on coarse pointers),
  both arrows on fine pointers, click → goPrev/goNext, self-hide at first/last
  page, neutral color with no card chrome / blue.
- `run-home-screen-e2e.mjs` — real headless-chromium render of both surfaces;
  added a fine-pointer capture (headless defaults to coarse, so the arrows are
  correctly hidden in the normal captures). Asserts `>` present on home, no `<`
  on home, `<` (→ home) present on the launcher. `0` page errors.

## Evidence

- `desktop-edge-home.png` — home view, fine-pointer: `>` (→ launcher) on the
  right edge, no `<` (home is the first view).
- `desktop-edge-launcher.png` — launcher view, fine-pointer: the rail's `<`
  (→ home) on the **left** and the inner launcher's `>` (next app page) on the
  **right** — the two pagers coexist on opposite edges (no stacking).
- `mobile-no-arrows.png` / `mobile-launcher-no-arrows.png` — the same views on a
  coarse-pointer mobile viewport: **no arrows** (swipe is the sole navigation).

The momentum smoothness itself is a timing behavior best seen in the unit test's
fast-vs-slow assertion (a headless screenshot can't show settle velocity).

- Real-LLM trajectory / backend logs — **N/A**: pure client-side gesture/UI
  change, no model or server path.
- Native iOS/Android capture — deferred to the device lanes; the touch behavior
  (finger-follow + momentum, arrows absent) is covered by the coarse-pointer
  mobile captures + the unit tests here.
