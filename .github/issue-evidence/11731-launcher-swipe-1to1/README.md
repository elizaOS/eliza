# PR #11731 — launcher swipe-right 1:1 (outer-rail-owned back-swipe)

Change: the home↔launcher rail owns the horizontal gesture on BOTH halves; the
inner launcher's damped `onEdgeSwipeRight` delegate (EDGE_RESISTANCE 0.35 — the
"only swipes half way, doesn't track my thumb" symptom) is removed, and the
edge-swipe feature is deleted from `useHorizontalPager`. Both directions follow
the same iOS rules: 1:1 tracking, commit past 50% of width or on a flick,
velocity-aware momentum settle.

## Real-browser e2e (headless Chromium, real pointer/touch input)

- `bun run --cwd packages/ui test:launcher-e2e` — mounts the REAL
  HomeLauncherSurface composition; asserts **mid-drag 1:1 tracking**
  (`rail m41 = -281 vs expected ≈ -281` for a +109px drag at width 390) and the
  release commits `data-page=home`. Video + screenshots in
  `packages/ui/src/components/pages/__e2e__/output-launcher/`
  (`e2e-mobile-after-swipe-home.png` here is the post-commit frame).
- `bun run --cwd packages/ui test:home-screen-e2e` — CDP **touch** swipe-back
  returns HOME; left-swipe rubber-bands on the single page; **rail-swipe FPS
  gate** over 3 measured round-trips through the shared frame-budget
  detectors: `fps=120.0 p95=9.1ms worst=9.4ms dropped=0/305 (0%) long=0`.

## Unit (vitest)

- `useHorizontalPager` 15/15 — incl. new "right drag at page 0 rubber-bands and
  never commits" and "right drag at page>0 pages BACK with 1:1 tracking".
- `HomeLauncherSurface` 10/10 + composed 9/9 — outer rail owns the back-swipe;
  left drag on the single-page launcher rubber-bands the OUTER rail (iOS
  last-page overscroll) while the inner rail stays parked.

## On-device (MoonCycles, iPhone 16 Pro Max, iOS 26 — real hardware)

- `device-mooncycles/boot-000s.png` / `boot-final-home-fresh-build.png` —
  XCUITest boot capture of the freshly built+signed+installed bundle
  (`ios:device:deploy`, staged App.app verified to contain the new pager code:
  `edgeSwipeRight` absent, onboarding-notifications chunk present, model pill
  testid absent). `TEST EXECUTE SUCCEEDED`; boot reaches the home surface.
- `device-mooncycles/gesture-*` — `GestureSemanticsUITests
  .testLauncherPagerFiftyPercentSwipeThreshold` run against the new build:
  sub-threshold left drag snaps back, past-50% left drag commits to the
  launcher, sub-threshold **right** drag snaps back (the old reduced edge
  threshold is gone), past-50% right drag commits home — asserted through the
  `home-launcher-page:` accessibility probe on the physical touch pipeline.
