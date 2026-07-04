# #12179 web loop lane — real-browser evidence

Completes #12179's "long interaction loops on **web**" DoD and repairs the
real-browser path of #12373's merged launcher-loop engine
(`packages/ui/src/testing/launcher-loop/`).

The engine shipped a jsdom self-check against an in-memory `FakeDriver` plus the
Android/iOS native lanes, but **no real-browser web runner** — so its
`CdpTouchDriver` had never actually driven a real DOM. Standing up the web lane
(`packages/ui/src/components/shell/__e2e__/run-launcher-gesture-loop-e2e.mjs`,
reusing `home-screen-fixture.tsx` via real CDP touch) surfaced the divergences
below. Each was reproduced in a real headless Chromium, root-caused, and fixed.

## Real-browser bugs (reproduced → fixed)

1. **Committed rail flicks dropped at `stepDelayMs: 2`.** At 2 ms/step Chromium
   coalesces the touchMove burst into one composited frame; the pager's
   velocity tracker sees a single tiny jump and the flick never commits (rail
   stays parked, `data-page` lags the model). Fix (`cdp-gestures.ts`): the
   proven 16 ms/10-step cadence (same as `run-home-screen-e2e`), a commit
   distance of 280 px (comfortably past the pager's 0.5·width ≈ 201 px commit
   line), a bounded re-dispatch for genuine compositor drops, and a `settle()`
   that waits for the rail to actually park at a page boundary before observing.

2. **notification-open selector never matched.** The driver's open-check and the
   page-side observation reader keyed off `[data-notification-open="true"]` /
   `notification-center[data-open="true"]` — neither exists. The real open sheet
   is `notification-sheet`/`notification-panel` with `[data-open]`. Fix: one
   `NOTIFICATION_OPEN_SELECTOR` constant, used in both places.

3. **Rail swipe over an open notification diverged.** An open notification is a
   modal overlay (backdrop + sheet, pointer-events auto) that intercepts the
   touch, so the swipe never reaches the rail and it stays parked — while the
   model's `commitPage` navigates AND closes the notification. Fix: dismiss the
   notification first (now that #2 lets the driver see it is open), so the swipe
   lands on the rail and the net state matches the model.

### Also fixed (found by the same real-browser lane)

4. **`railEdgeButton` was a no-op on the touch lane.** `PagerEdgeButtons` is
   fine-pointer-only, so the chevron isn't rendered on a coarse-pointer phone;
   the driver returned early while the model navigated → divergence. Fix: fall
   back to the equivalent committed rail flick when no chevron is present.

5. **Scrolled-off tile-tap launched nothing (the failure-batch root cause).**
   `launcher-page-window` is `overflow-y-auto`; a prior `gridScroll` pushes a
   tile off-window, where a center-tap resolves to `elementFromPoint(...) ===
   null` and no launch fires — the model still expects one, so `launchCount`
   diverges (a HARNESS/driver bug, not a launcher bug: a real user never taps a
   tile scrolled out of view). Fix: `scrollIntoViewIfNeeded` before the tap.

6. **Model over-specified long-press as inert.** The launcher's edit/jiggle mode
   was removed (#12179 slop item 11), so a tile is a plain `<Button onClick>`
   with no long-press handler — a stationary press+release synthesizes a click
   and launches once, exactly like a tap (verified: launch count 0→1 on a
   long-press). "No ghost launch" (§D item 38) holds as long as it launches
   once, not zero. Reconciled the model + the self-check fake to reality.

## 3-seed green run (the #12179 DoD)

`ELIZA_LOOP_ACTIONS=500` (batches of 50) × 3 consecutive **random** seeds, each
GREEN, in a real headless Chromium. Every seed printed + honored via
`ELIZA_LOOP_SEED`; replay any with `ELIZA_LOOP_SEED=<seed> bun run --cwd
packages/ui test:launcher-loop-e2e`.

Run on the rebased tree (`develop` @ #12530's merged additive lanes + this PR's
engine fixes):

| # | seed | actions | result | walkthrough |
|---|------|---------|--------|-------------|
| 1 | `622617603` | 500 | ✅ PASSED | `launcher-loop-seed622617603.webm` |
| 2 | `170480565` | 500 | ✅ PASSED | `launcher-loop-seed170480565.webm` |
| 3 | `574261831` | 500 | ✅ PASSED | `launcher-loop-seed574261831.webm` |

1500 real CDP-touch actions total, zero invariant violations. The engine
self-check (`bun run --cwd packages/ui test -- launcher-loop`) is green (9/9).

## Mutation check (the loop catches a real regression)

Removed a real launcher page-state update — `goLauncher()` in
`HomeLauncherSurface.onPageChange` — so a committed home→launcher flick no longer
navigates, then reverted. With the mutation in, the loop failed on the first
committed left flick with the exact invariant and a seeded, replayable command
path (`mutation-check-seed424242.txt`):

```
✗ batch 1 FAILED — launcher loop failed (seed=424242). Replay with ELIZA_LOOP_SEED=424242.
Property failed after 1 tests
Counterexample: [[notificationPull(commit),railSwipe(left,reject),railSwipe(left,reject),railSwipe(left,commit),…]]
Invariant: data-page="home" but model expects "launcher"
```

(The real-browser lane runs `fc.assert({ endOnFailure: true })` — it favors a
fast, fully-replayable seed+path over minimization; the engine's shrinking is
exercised by the injected-failure suite in `launcher-loop.test.ts`, which runs
`numRuns: 40` and reports a shrunk counterexample.) Reverted immediately; the
loop returns to green.

## CI wiring

Wired into `.github/workflows/chat-shell-gestures.yml` (the gesture lane that
already runs the adjacent `test:home-screen-e2e`): a fixed-seed 200-action smoke
as the regression guard; the full 500×3 above is the manual DoD.

## Adjacent lane note

`test:launcher-e2e` stays green. `test:home-screen-e2e` has a **pre-existing**
failure on `develop` unrelated to this PR — the `hyperliquid` tile is not
deduped/removed by launcher curation (`✗ "hyperliquid" is absent from the
launcher`). Reproduced with this branch's only home-screen change reverted, so
it is not introduced here; the curation path uses `useRoutableViews`, untouched
by this PR.
