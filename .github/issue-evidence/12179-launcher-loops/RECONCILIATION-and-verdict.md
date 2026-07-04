# #12179 Phases 2–4 — reconciliation against the merged #12373 engine

While this branch built the launcher gesture-loop engine + lanes for #12179
Phase 2–4, a parallel effort (#12373, merged via PRs #12443 + #12451) landed the
**same** shared launcher-loop engine on `develop`, and `develop` also
independently did the Phase-1 launcher cleanup. This branch was rebuilt on
`origin/develop`: the duplicated work was dropped, only the genuinely-additive
pieces were kept, adapted to develop's engine API.

## Dropped as duplicate (already on develop)

- The whole loop engine — `packages/ui/src/testing/launcher-loop/{model,invariants,cdp-gestures,index,commands,launcher-loop.test}.ts`. develop's #12373 version is canonical.
- `packages/app/test/android/launcher-gesture-loop.android.spec.ts` — #12373 shipped its own.
- Phase-1 (WI-1..4): single-page launcher, deleted nested-pager pointer-claim registry, deleted `view-recents.ts`. All already on develop via other PRs (verified: develop's `Launcher.tsx` has 0 multi-page markers, `useHorizontalPager.ts` has 0 claim-registry refs, `view-recents.ts` is gone).

## Kept as additive (this PR)

- **a11y focus-blur on rail flip** — `HomeLauncherSurface.tsx` + test. develop uses `inert` on the offscreen half but never blurs a focused descendant, so keyboard focus is trapped in the offscreen, non-interactive half. This is exactly the focus trap the #12373 engine's `activeElementInInert` invariant asserts against — the component was violating an invariant no lane had exercised in a real browser yet.
- **iOS XCUITest loop** — `AppUITests/LauncherGestureLoopUITests.swift` + `project.pbxproj` wiring. #12373 shipped no iOS lane. (The pbxproj is now safe to edit — #12295/ElizaWidgets is merged to develop and already in the base.)
- **Desktop packaged smoke** — `desktop-launcher-smoke.e2e.spec.ts`. #12373 shipped no desktop lane. Drives the shell-surface store via bridge `eval` (no CDP — WKWebView has none).
- **Interaction matrix doc** — `LAUNCHER_INTERACTION_MATRIX.md` (§D catalog → lane mapping, adapted to develop's engine + a Status section on the open engine gaps).
- **Launcher-fixture bundling fix** — `home-screen-fixture.views-stub.ts` now exports `fetchAvailableViews`. The launcher's `catalog-loader` imports it; the stub replaces that whole module, so any fixture that bundles the launcher (`run-home-screen-e2e`, `run-launcher-e2e`, a web loop runner) fails to esbuild without it.

## Failure-batch verdict (the loop caught a REAL bug — it was a HARNESS bug)

Before the reconciliation, this branch's loop caught + shrank two failures
(seeds `424242` / `387289096`, both the telemetry-launch invariant — see the
`caught-failure-batch-*.json` replays). **Verdict: harness / driver bug, NOT a
launcher product bug.** `launcher-page-window` is `overflow-y-auto`; a tile
scrolled off-window by a prior `gridScroll` still reports a nonzero
`getBoundingClientRect`, so a center-tap on it lands off-window and launches
nothing. Direct `[tapdiag]` evidence (formerly-failing tap, seed 424242): the
first boxed tile `settings` had center `Y=-69` above the window top, and
`document.elementFromPoint` returned `null`. The launcher is correct — a real
user never taps a tile scrolled out of view.

**This class of bug is latent in develop's merged engine too:** develop's
`CdpTouchDriver.tapTile(id)` is a plain center `touchTap` with no
scroll-into-view / hit-test. Recommended follow-up: `scrollIntoViewIfNeeded`
before the tap (or a hit-test) in the #12373 driver.

## New finding — develop's #12373 CdpTouchDriver is unvalidated in a real browser

The #12373 engine's self-check (`launcher-loop.test.ts`) runs in jsdom against an
in-memory `FakeDriver`; there was **no real-browser web runner**, so the
`CdpTouchDriver` had never actually driven the fixture. Standing up a real web
runner surfaced multiple real-browser gaps (each reproduced + root-caused; the
runner + a proven partial-fix diff are attached for the #12373 follow-up):

1. **Committing rail swipes are dropped.** `railSwipe` uses `stepDelayMs: 2`; at that rate Chromium coalesces the touchMove burst into one frame, the pager's velocity tracker sees one tiny jump, and the flick never commits (rail transform stays parked). `run-home-screen-e2e` uses `stepDelayMs: 16` and commits reliably.
2. **Notification-open selector is wrong** in both the driver's dismiss check and `observe()`: they look for `[data-notification-open="true"]` / `notification-center[data-open="true"]`, but the real open sheet is `[data-testid="notification-sheet"][data-open]`.
3. **Rail swipe over an open notification** hits the modal overlay (closes it, rail stays) while the model expects the swipe to navigate — a model-vs-reality divergence. Dismiss the notification in the driver before rail-swiping (with the correct selector) to match the model.

`web-runner-adapted.mjs` + `engine-fixes-proven.diff` (in the scratch dir, not
committed) implement 1–3 and get individual gestures green; a full ≥500 loop
needs these fixes merged into the #12373 engine (canonical) — out of scope for
this additive reconciliation. The `loop-web` lane lands once the engine's
real-browser path is fixed.
