# Launcher interaction matrix (#12179)

The canonical catalog of every home ↔ launcher interaction, mapped to the lane
that exercises it. This is the §D matrix from the issue, made executable: each
row is a scripted deterministic case (**[S]**), part of the randomized loop's
action alphabet (**[L]**), a loop invariant checked after every action
(**[I]**), or some combination.

The frozen test-id / AX contract every lane keys off (do not rename — design
decision D5): `home-launcher-surface`, `data-page`, `home-launcher-page-probe`,
`home-launcher-rail`, `home-launcher-{home,launcher}-page`, `launcher`,
`launcher-page-window`, `launcher-tile-<id>`, `home-screen`,
`home-notification-pull-zone`, `rail-pager-edge-{prev,next}`.

## Lanes

| Lane | Kind | Where | Drives |
|---|---|---|---|
| **jsdom** | component / composed unit | `HomeLauncherSurface{,.composed}.test.tsx`, `Launcher.test.tsx`, `LauncherSurface.test.tsx`, `launcher-curation.test.ts`, `useHorizontalPager`/`use-notification-pull` tests | React Testing Library + user-event |
| **home-e2e** | scripted CDP touch | `__e2e__/run-home-screen-e2e.mjs` | real touch on the composed fixture |
| **launcher-e2e** | scripted CDP touch | `components/pages/__e2e__/run-launcher-e2e.mjs` | real touch on the launcher grid |
| **loop-model** | seeded model self-check (jsdom) | `src/testing/launcher-loop/launcher-loop.test.ts` | the `#12373` engine's model + invariants against an in-memory `FakeDriver` |
| **loop-android** | seeded model loop, device | `packages/app/test/android/launcher-gesture-loop.android.spec.ts` | `AndroidInput` real gestures, ≥200 actions (shipped by #12373) |
| **loop-ios** | seeded model loop, simulator | `packages/app-core/platforms/ios/App/AppUITests/LauncherGestureLoopUITests.swift` | XCUIElement swipes/taps, AX-probe asserts |
| **gesture-matrix** | scripted, real app | `packages/app/test/ui-smoke/gesture-matrix.spec.ts` | tap-vs-long-press, edge cases |
| **desktop-smoke** | packaged Electrobun | `packages/app/test/electrobun-packaged/desktop-launcher-smoke.e2e.spec.ts` | bridge `eval` drives the store + screenshot (no CDP gestures) |
| **loop-web** (pending) | seeded model loop, real browser | — | ≥500 CDP-touch actions against the fixture — blocked on the engine's real-browser driver (see Status) |

The seeded loop engine (`packages/ui/src/testing/launcher-loop/`, merged from
#12373 via #12443/#12451) is shared by every `loop-*` lane: one pure model
(`model.ts`), the `[I]` invariants (`invariants.ts`), and the abstract command
budget (`commands.ts`) run against a per-platform `Driver` (`cdp-gestures.ts`
`CdpTouchDriver` for web/desktop-renderer; `AndroidInput` for android;
XCUIElement for iOS). Seed comes from `ELIZA_LOOP_SEED` (default random, always
printed) and a failure throws with the seed + shrunk command path for replay.

## Rail (home ↔ launcher — `HomeLauncherSurface` + `useHorizontalPager`)

| # | Tags | Interaction | Lanes |
|---|---|---|---|
| 1 | [S][L] | Fast left flick home→launcher commits; `data-page`+AX probe update | jsdom, home-e2e, loop-* |
| 2 | [S][L] | Slow left drag: <50% springs back, >50% commits | jsdom, loop-* |
| 3 | [S][L] | Right flick/drag launcher→home tracks finger 1:1 | launcher-e2e, loop-* |
| 4 | [S][L] | Right drag on home = edge rubber-band, no page change | jsdom, loop-* (rubber-band dir) |
| 5 | [S][L] | Left drag on launcher (last page) rubber-bands, settles back | jsdom (composed), loop-* |
| 6 | [S][L] | Vertical scroll never flips the rail (axis lock) | jsdom, loop-* (gridScroll) |
| 7 | [S] | Diagonal drags at the axis boundary — commit/reject per dominance | jsdom |
| 8 | [S] | Drag then flick back before release — release-velocity window decides | jsdom |
| 9 | [S][L] | Chained swipes: grab mid-settle, no teleport (`liveRailOffset`) | jsdom, loop-* (back-to-back swipes) |
| 10 | [S][L][**I**] | Committed swipe swallows the synthesized click — **no ghost launch** | jsdom, loop-* (telemetry invariant) |
| 11 | [S] | Non-committed drag released over a tile: tile NOT launched | jsdom |
| 12 | [S][L] | Tile tap launches: pushState/popstate + telemetry `launch` | launcher-e2e, gesture-matrix, loop-* (tileTap) |
| 13 | [S] | Second simultaneous touch ignored (`isPrimary === false`) | jsdom |
| 14 | [S][L] | Mouse drag paging (desktop); pen | jsdom, loop-model, desktop-smoke |
| 15 | [S] | Right/middle mouse never starts a drag | jsdom |
| 16 | [S] | Mouse released off-surface → stale-drag abandon on next hover | jsdom |
| 17 | [S][L] | `pointercancel` mid-drag → settle back, no page change | jsdom, loop-* (settle invariant) |
| 18 | [S] | `lostpointercapture` on bound element aborts; on a child must NOT | jsdom |
| 19 | [S][L] | Viewport resize/rotation mid-drag + at rest — rail never mis-parked | jsdom, loop-* (rotate + transform-at-rest) |
| 20 | [S][L] | Edge buttons: coarse-hidden, fine-visible, one page/click, Enter/Space | jsdom, home-e2e |
| 21 | [S][**I**] | Offscreen half is `inert`; focus never lands inside `[inert]` | jsdom, loop-* (`activeElementInert` invariant) |
| 22 | [S] | `prefers-reduced-motion`: settle jumps (no inline transition) | jsdom, loop-* (reducedMotion action) |
| 23 | [**I**] | Every action: `data-page` ∈ {home,launcher}; AX probe matches; transform = −page·width; exactly one half `aria-hidden=false` | loop-* (invariants) |
| 24 | [S] | Deep-link initial page: `/apps`→launcher, `/chat`→home; swipe not clobbered | jsdom (real router covered by loop-android / gesture-matrix) |
| 25 | [S][L] | Store convergence: `ViewHeader` back, composer swipe, `navigateHome` all flip one rail | jsdom |

## Home screen (`HomeScreen` + `use-notification-pull` + `usePullGesture`)

| # | Tags | Interaction | Lanes |
|---|---|---|---|
| 26 | [S][L] | Notification pull: engages after 8px slop, tracks finger, ≥60px/≥0.5px·ms⁻¹ opens; short retracts | jsdom, gesture-matrix, loop-* (notificationPull) |
| 27 | [S][L] | Scrolled-down list: downward drag scrolls, never pulls | jsdom, loop-* |
| 28 | [S] | Upward drag = native scroll | jsdom |
| 29 | [S] | Horizontal-dominant drag = rail, not pull | jsdom |
| 30 | [S][L] | Tap on a widget is a tap, not a pull | jsdom, loop-* |
| 31 | [S] | `touchcancel` mid-pull retracts (no stuck sheet) | jsdom |
| 32 | [S] | Top-edge button: click/keyboard opens; upward drag does NOT open via stray click | gesture-matrix |
| 33 | [S][L] | Widget list vertical scroll + `overscroll-y-contain` | jsdom, loop-* (gridScroll) |
| 34 | [S] | Entrance fade plays exactly once (#9304) | jsdom |
| 35 | [S] | AOSP tiles: hidden off-AOSP, 4 on AOSP | jsdom |
| 36 | [**I**] | CLS stays within budget across the loop | loop-* (`cls` invariant) |

## Launcher grid (`Launcher` + curation)

| # | Tags | Interaction | Lanes |
|---|---|---|---|
| 37 | [S][L] | Vertical scroll of an overflowing grid; tiles remain tappable after scroll | launcher-e2e, loop-* (gridScroll→tileTap) |
| 38 | [S][L] | Long-press on a tile: no edit mode, no ghost launch | launcher-e2e, gesture-matrix |
| 39 | [S] | Dev/Preview badges; skeleton on `loading`; empty-state grid without crash | jsdom |
| 40 | [S] | Curation invariants: dedup, AOSP gating, dev/preview toggles, cloud gating (#10725), alias `path` | jsdom (`LauncherSurface.test.tsx`, `launcher-curation.test.ts`) |
| 41 | [**I**] | Brand: no blue hues sampled; tile hover neutral-white wash, never blue/black | loop-* (`sawBlue` invariant) |

## Chat-overlay interplay (owned by the continuous-chat gesture lane, #12188)

| # | Tags | Interaction | Lanes |
|---|---|---|---|
| 42 | [S][L] | Composer horizontal swipe: sheet closed flips rail, sheet open must not | jsdom, chat gesture lane |
| 43 | [S] | Composer keeps focus through rail flips; rail gestures never steal composer focus | jsdom, chat gesture lane |

Rows 42–43 sit at the chat ↔ launcher boundary; the composer swipe is not part
of this launcher loop's alphabet (the fixture mounts no live composer). They are
listed here for completeness and are covered by the continuous-chat gesture
coverage (#12188), not by `launcher-loop/`.

## Loop invariants ([I] rows → `invariants.ts`)

Every `loop-*` lane checks these after each command (`checkInvariants` against a
`LauncherObservation`); a violation throws with the seed + shrunk command path.

| Row | Invariant |
|---|---|
| 23a | `data-page` is `home`\|`launcher` and equals the model page |
| 23b | AX probe text `home-launcher-page:<page>` matches the model |
| 23c/d | exactly one half exposed; at rest the rail transform equals `−page · width` |
| 21 | `document.activeElement` is never inside an `[inert]` subtree (see the a11y fix in `HomeLauncherSurface.tsx`) |
| 10 | telemetry launch count equals real taps only (no ghost launch, no dropped launch) |
| — | zero console / page errors across the loop |
| 36 | cumulative layout shift stays within the CLS budget |
| 41 | no blue hue sampled in computed styles |

## Platform notes

- **Desktop gesture loops run in the Chromium renderer lane**, not against the
  packaged binary: Electrobun ships this exact renderer bundle, and its system
  WebView (WKWebView / WebKitGTK) exposes no CDP surface for trusted touch
  synthesis (issue prior-art §5). The packaged lane gets a thin
  `desktop-launcher-smoke` — bridge `eval` drives the shell-surface store
  (`goLauncher()`/`goHome()`), asserts `data-page` + AX probe, screenshots both
  halves — no gesture synthesis.
- **Mobile-native loops** drive real device gestures: android via
  `AndroidInput`/`adb input` with logcat + chunked `screenrecord`, iOS via
  XCUIElement swipes/taps asserting the `home-launcher-page-probe` AX text between
  rounds. They port the [L]/[I] subset reachable through the AX tree (page state,
  transition stability, app-alive).

## Status

- Rows 21 (focus-out-of-inert) is enforced by the `HomeLauncherSurface` blur-on-
  flip fix shipped alongside this doc; the a11y focus trap it closes is exactly
  what the engine's `activeElementInInert` invariant asserts.
- **`loop-web` is pending.** The #12373 engine's `CdpTouchDriver` had no
  real-browser consumer before this work (its self-check runs in jsdom against a
  `FakeDriver`), and a real-browser web runner surfaced driver/model gaps that
  must be fixed in the engine before the web lane is green — committing rail
  swipes coalesce at `stepDelayMs: 2` (Chromium drops the flick), the driver's
  and `observe()`'s notification-open selectors don't match the real
  `notification-sheet[data-open]`, and a rail swipe fired over an open
  notification hits the overlay instead of the rail while the model expects it to
  navigate. Tracked as a #12373 engine follow-up.
