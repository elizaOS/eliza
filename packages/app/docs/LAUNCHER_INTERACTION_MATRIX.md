# Launcher interaction matrix (#12378, #12179 WI-9)

The app-level, per-platform coverage matrix for every home ↔ launcher
interaction: each row maps one interaction to the concrete unit, fixture-e2e,
ui-smoke, desktop-packaged, Android, and iOS spec that exercises it. This is the
executable §D matrix from #12179, and it is the **enforced twin** of
`packages/app/test/launcher-interaction-matrix.test.ts` — that gate parses this
file, fails when any cited spec path does not exist on disk, and fails when a
known launcher gesture-handler source site is not mapped here.

Two sibling docs cover adjacent surfaces; this one is the launcher-specific,
per-platform roll-up:

- `packages/ui/src/components/shell/__e2e__/LAUNCHER_INTERACTION_MATRIX.md` — the
  fine-grained (43-row) rail/home/grid interaction catalog and loop-engine
  design (test-id contract, `[S]`/`[L]`/`[I]` tags, invariant list). Read it for
  the per-gesture detail behind the rows below.
- `packages/app/docs/CHAT_GESTURE_COVERAGE.md` — the chat/touch gesture roster;
  the home↔launcher pager (row 8) there is the same handler pair mapped below,
  from the gesture-site angle.

## Lane legend

| Lane | Kind | Harness reality |
|---|---|---|
| **unit** | jsdom component / pure model | React Testing Library + user-event, or the pure loop model against an in-memory driver. Deterministic, boot-free. |
| **fixture-e2e** | real-browser CDP touch, composed fixture | Playwright/CDP `Input.dispatchTouchEvent` on an esbuild fixture bundle of the real component — real pointer/touch, no app boot. |
| **ui-smoke** | real-browser CDP touch, **booted app** | Playwright against the production-wired app on `chromium` + `mobile-chromium` (Pixel 7); real gestures through production wiring. |
| **desktop** | packaged Electrobun binary | Bridge `eval` drives the shell-surface store; no CDP touch (WKWebView/WebKitGTK expose no trusted-touch surface). Asserts `data-page` + AX probe + non-blank screenshot. |
| **android** | real device / emulator | `adb input` / Playwright-Android real gestures + logcat + chunked `screenrecord`. |
| **ios** | real simulator / device | XCUITest native touch → WKWebView pointer events, asserting the `home-launcher-page:<page>` AX probe between rounds. |

The seeded loop engine (`packages/ui/src/testing/launcher-loop`) is shared by
every loop lane: one pure model (`packages/ui/src/testing/launcher-loop/model.ts`),
the invariants (`packages/ui/src/testing/launcher-loop/invariants.ts`), the
command budget (`packages/ui/src/testing/launcher-loop/commands.ts`), and a
per-platform driver (`packages/ui/src/testing/launcher-loop/cdp-gestures.ts` for
web/desktop-renderer; `packages/app/test/android/launcher-loop-model.ts` for
android parity; the Swift port for iOS). Failures throw with the
`ELIZA_LOOP_SEED` + shrunk command path for byte-exact replay.

## Interaction matrix

Each cell cites the real spec that exercises the row on that lane. `N/A` cells
carry a reason. Every backticked path in this file must exist on disk (enforced).

### Rail — home ↔ launcher pager

| # | Interaction | unit | fixture-e2e | ui-smoke | desktop | android | ios |
|---|---|---|---|---|---|---|---|
| 1 | Left flick home→launcher commits (`data-page` + AX probe flip) | `packages/ui/src/components/shell/HomeLauncherSurface.test.tsx` | `packages/ui/src/components/shell/__e2e__/run-home-screen-e2e.mjs` | `packages/app/test/ui-smoke/launcher-gesture-loop.spec.ts` | `packages/app/test/electrobun-packaged/desktop-launcher-smoke.e2e.spec.ts` | `packages/app/test/android/touch-gesture.android.spec.ts` | `packages/app-core/platforms/ios/App/AppUITests/LauncherGestureLoopUITests.swift` |
| 2 | Slow drag: <50% springs back, ≥50% commits | `packages/ui/src/components/shell/HomeLauncherSurface.test.tsx` | `packages/ui/src/components/shell/__e2e__/run-launcher-loop-e2e.mjs` | `packages/app/test/ui-smoke/launcher-gesture-loop.spec.ts` | N/A — bridge-store lane synthesizes no partial drag | `packages/app/test/android/launcher-gesture-loop.android.spec.ts` | `packages/app-core/platforms/ios/App/AppUITests/GestureSemanticsUITests.swift` |
| 3 | Right flick launcher→home rides the rail | `packages/ui/src/components/shell/HomeLauncherSurface.test.tsx` | `packages/ui/src/components/shell/__e2e__/run-launcher-loop-e2e.mjs` | `packages/app/test/ui-smoke/launcher-gesture-loop.spec.ts` | `packages/app/test/electrobun-packaged/desktop-launcher-smoke.e2e.spec.ts` | `packages/app/test/android/touch-gesture.android.spec.ts` | `packages/app-core/platforms/ios/App/AppUITests/LauncherGestureLoopUITests.swift` |
| 4 | Committed swipe swallows the synthesized click — no ghost launch | `packages/ui/src/hooks/useHorizontalPager.test.tsx` | `packages/ui/src/components/shell/__e2e__/run-launcher-loop-e2e.mjs` | `packages/app/test/ui-smoke/gesture-matrix.spec.ts` | N/A — no touch synthesis on packaged WebView | `packages/app/test/android/launcher-gesture-loop.android.spec.ts` | `packages/app-core/platforms/ios/App/AppUITests/LauncherGestureLoopUITests.swift` |
| 5 | Vertical scroll never flips the rail (axis lock) | `packages/ui/src/components/shell/HomeLauncherSurface.test.tsx` | `packages/ui/src/components/shell/__e2e__/run-launcher-loop-e2e.mjs` | `packages/app/test/ui-smoke/launcher-gesture-loop.spec.ts` | N/A — bridge lane drives no axis-ambiguous drag | `packages/app/test/android/launcher-gesture-loop.android.spec.ts` | N/A — the iOS loop drives horizontal rail swipes only; axis arbitration owned by the web + android lanes |
| 6 | Non-primary / second touch ignored | `packages/ui/src/components/shell/HomeLauncherSurface.test.tsx` | N/A — single CDP pointer stream | N/A — single CDP pointer stream | N/A | N/A — single `adb input` pointer | N/A — single XCUITest touch |
| 7 | `pointercancel`/`touchcancel` mid-drag settles back, no page change | `packages/ui/src/hooks/useHorizontalPager.test.tsx` | `packages/ui/src/components/shell/__e2e__/run-launcher-loop-e2e.mjs` | `packages/app/test/ui-smoke/launcher-gesture-loop.spec.ts` | N/A | `packages/app/test/android/launcher-gesture-loop.android.spec.ts` | N/A — the iOS loop synthesizes no OS pointer-cancel |
| 8 | Chained/back-to-back swipes: no teleport (`liveRailOffset`) | `packages/ui/src/components/shell/HomeLauncherSurface.composed.test.tsx` + `packages/ui/src/testing/launcher-loop/launcher-loop.test.ts` | `packages/ui/src/components/shell/__e2e__/run-launcher-loop-e2e.mjs` | `packages/app/test/ui-smoke/launcher-gesture-loop.spec.ts` | N/A | `packages/app/test/android/launcher-gesture-loop.android.spec.ts` | `packages/app-core/platforms/ios/App/AppUITests/LauncherGestureLoopUITests.swift` |

### Edge buttons (desktop / fine-pointer)

| # | Interaction | unit | fixture-e2e | ui-smoke | desktop | android | ios |
|---|---|---|---|---|---|---|---|
| 9 | Edge chevrons coarse-hidden, fine-visible, one page/click | `packages/ui/src/components/shell/HomeLauncherSurface.test.tsx` | `packages/ui/src/components/shell/__e2e__/run-home-screen-e2e.mjs` (coarse-hidden half) | N/A — mobile-chromium hides chevrons; fine-visible + one-page-per-click unit-owned | N/A — bridge-store lane flips via `goLauncher()`/`goHome()`, no chevron click | N/A — coarse pointer hides chevrons | N/A — coarse pointer hides chevrons |
| 10 | Edge button keyboard (Enter/Space) activation | `packages/ui/src/components/shell/HomeLauncherSurface.test.tsx` | N/A — the fixture drives touch/click only; keyboard activation unit-owned | N/A | N/A — bridge-store lane, no key events | N/A | N/A |

### Tap-to-launch (launcher grid)

| # | Interaction | unit | fixture-e2e | ui-smoke | desktop | android | ios |
|---|---|---|---|---|---|---|---|
| 11 | Tile tap launches (pushState/popstate + `launch` telemetry) | `packages/ui/src/components/pages/Launcher.test.tsx` | `packages/ui/src/components/pages/__e2e__/run-launcher-e2e.mjs` | `packages/app/test/ui-smoke/gesture-matrix.spec.ts` | N/A — bridge lane drives store, not tile tap | N/A — pending: no emulator tile-launch leg; the seeded loop's taps guard ghost launches only | N/A — pending: no native tile-launch leg; ghost launches guarded indirectly by the loop's page probe |
| 12 | Long-press on a tile: no edit mode, no ghost launch | `packages/ui/src/components/shell/HomeLauncherSurface.composed.test.tsx` | `packages/ui/src/components/pages/__e2e__/run-launcher-e2e.mjs` | `packages/app/test/ui-smoke/gesture-matrix.spec.ts` | N/A | N/A — pending: the emulator long-press leg presses a chat message, not a launcher tile | N/A — pending: the native long-press leg presses the home surface (callout suppression + no-nav), not a tile |
| 13 | Grid vertical scroll; tiles stay tappable after scroll | `packages/ui/src/testing/launcher-loop/launcher-loop.test.ts` | `packages/ui/src/components/shell/__e2e__/run-launcher-loop-e2e.mjs` | `packages/app/test/ui-smoke/launcher-gesture-loop.spec.ts` | N/A | `packages/app/test/android/launcher-gesture-loop.android.spec.ts` | N/A — page-stability loop scopes out grid scroll |

### Notification center (home dashboard widget)

Notifications live in `NotificationsHomeCenter`, a widget pinned on the home
dashboard below the time/weather base (not behind a pull gesture). It carries
no gesture recognizer (rows are plain buttons; the list is a plain capped
scroll container), so no gesture-handler source site maps to these rows — but
its interactions still share the home surface with the rail pager and are
covered per-lane here.

| # | Interaction | unit | fixture-e2e | ui-smoke | desktop | android | ios |
|---|---|---|---|---|---|---|---|
| 14 | Row tap marks read in place — order ignores read state, so the row never moves under the finger | `packages/ui/src/components/shell/NotificationsHomeCenter.test.tsx` + `packages/ui/src/components/shell/HomeScreen.test.tsx` (widget pinned below the base; no pull affordance) | N/A — plain click path, no recognizer to drive | `packages/app/test/ui-smoke/gesture-matrix.spec.ts` | N/A | N/A — web lanes own the widget; no gesture recognizer to regress natively | N/A |
| 15 | Per-row dismiss X and clear-all remove rows; the card self-hides once the inbox empties | `packages/ui/src/components/shell/NotificationsHomeCenter.test.tsx` | N/A — plain click path | `packages/app/test/ui-smoke/gesture-matrix.spec.ts` | N/A | N/A | N/A |
| 16 | Vertical pan inside the capped list scrolls the LIST — never flips the rail, never ghost-taps a row | N/A — jsdom has no real scroll geometry; web lanes own it | `packages/ui/src/components/shell/__e2e__/run-launcher-loop-e2e.mjs` (the home-half widget-scroll command covers the pinned card) | `packages/app/test/ui-smoke/gesture-matrix.spec.ts` + `packages/app/test/ui-smoke/launcher-gesture-loop.spec.ts` | N/A | N/A | N/A |

### Focus / a11y / brand invariants

| # | Interaction | unit | fixture-e2e | ui-smoke | desktop | android | ios |
|---|---|---|---|---|---|---|---|
| 17 | Offscreen half is `inert`; focus never lands inside `[inert]` | `packages/ui/src/components/shell/HomeLauncherSurface.test.tsx` | `packages/ui/src/components/shell/__e2e__/run-launcher-loop-e2e.mjs` | `packages/app/test/ui-smoke/launcher-gesture-loop.spec.ts` | N/A | N/A — AX loop asserts page probe, not focus subtree | N/A |
| 18 | Tab focus reaches only the live half | `packages/ui/src/testing/launcher-loop/launcher-loop.test.ts` | `packages/ui/src/components/shell/__e2e__/run-launcher-loop-e2e.mjs` | `packages/app/test/ui-smoke/launcher-gesture-loop.spec.ts` | N/A | N/A | N/A |
| 19 | No blue hue sampled; tile hover neutral wash (brand) | N/A — pixel-hue sampling needs a real browser; jsdom cannot sample (invariant plumbing unit-proven in `packages/ui/src/testing/launcher-loop/launcher-loop.test.ts`) | `packages/ui/src/components/shell/__e2e__/run-launcher-loop-e2e.mjs` | `packages/app/test/ui-smoke/launcher-gesture-loop.spec.ts` | N/A | N/A | N/A |
| 20 | Every action: page/probe/transform agree (loop invariant) | `packages/ui/src/testing/launcher-loop/launcher-loop.test.ts` | `packages/ui/src/components/shell/__e2e__/run-launcher-loop-e2e.mjs` | `packages/app/test/ui-smoke/launcher-gesture-loop.spec.ts` | `packages/app/test/electrobun-packaged/desktop-launcher-smoke.e2e.spec.ts` | `packages/app/test/android/launcher-gesture-loop.android.spec.ts` | `packages/app-core/platforms/ios/App/AppUITests/LauncherGestureLoopUITests.swift` |

### Curation — cloud-gated tiles, empty catalog, loading, dev/preview

| # | Interaction | unit | fixture-e2e | ui-smoke | desktop | android | ios |
|---|---|---|---|---|---|---|---|
| 21 | Cloud-only tiles gated behind an active Eliza Cloud connection (#10725) | `packages/ui/src/components/pages/launcher-curation.test.ts` | N/A — pure curation, no gesture | N/A — curation is deterministic, unit-owned | N/A | N/A | N/A |
| 22 | AOSP-native tiles gated to the AOSP fork | `packages/ui/src/components/pages/launcher-curation.test.ts` | N/A | N/A | N/A | N/A | N/A |
| 23 | Dev/Preview tiles hidden by default, shown on toggle; dedup + alias re-point | `packages/ui/src/components/pages/launcher-curation.test.ts` | N/A | N/A | N/A | N/A | N/A |
| 24 | Empty-catalog grid renders without crash; skeleton on `loading` | `packages/ui/src/components/pages/Launcher.test.tsx` | N/A — the fixture renders a populated catalog only; empty/loading are deterministic and unit-owned | N/A — empty/loading are deterministic, unit-owned | N/A | N/A | N/A |

## Gesture-handler source sites

Every home↔launcher gesture originates in one of these two `packages/ui/src`
handlers. The enforcement gate requires each to be mapped here — a new launcher
gesture handler must land with its row.

| Source site | Drives | Rows |
|---|---|---|
| `packages/ui/src/hooks/useHorizontalPager.ts` | The rail pager pointer-capture drag/flick engine | 1–8 |
| `packages/ui/src/components/shell/HomeLauncherSurface.tsx` | Rail composition, inert/focus management, edge buttons | 1–10, 17–20 |

Tap-to-launch (rows 11–13) is a plain `onClick` on the launcher grid
(`packages/ui/src/components/pages/Launcher.tsx`), not a pointer/touch gesture,
so it is covered by the tap-vs-long-press lanes rather than a gesture recognizer.
The notification center rows (14–16) likewise have no recognizer: the widget's
rows are buttons and its list is a native scroll container.

## Loop replay

Every loop lane is seeded and reproducible:

- **fixture-e2e (≥500 actions):** `bun run --cwd packages/ui test:launcher-loop-e2e`
  (`packages/ui/src/components/shell/__e2e__/run-launcher-loop-e2e.mjs`). CI pins
  seed `12375` in `.github/workflows/chat-shell-gestures.yml`; a failing batch
  writes `failure-batch-<n>.json` with the run seed + fast-check shrunk command
  list. Replay with the printed `ELIZA_LOOP_SEED`, or
  `ELIZA_LOOP_ONLY_BATCH=<n>` for just that batch.
- **ui-smoke (booted app):** seed pinned in
  `packages/app/test/ui-smoke/launcher-gesture-loop.spec.ts`; override
  `ELIZA_LOOP_SEED` to fuzz, `ELIZA_LOOP_ACTIONS` to lengthen.
- **android (≥200 actions):**
  `packages/app/test/android/launcher-gesture-loop.android.spec.ts`, seed-parity
  with the web engine via `packages/app/test/android/launcher-loop-model.test.ts`.
- **ios:** `packages/app-core/platforms/ios/App/AppUITests/LauncherGestureLoopUITests.swift`,
  N seeded rounds asserting the `home-launcher-page:<page>` AX probe.

## Scoped-out cells (documented, not gaps)

- **desktop-packaged gestures** — the packaged Electrobun WebView exposes no CDP
  trusted-touch surface (#12179 prior-art §5), so the desktop lane is a
  bridge-`eval` store smoke (`goLauncher()`/`goHome()` → `data-page` + AX probe +
  non-blank screenshot). The identical renderer bundle gets full gesture coverage
  in the `chromium` ui-smoke lane.
- **android/ios loop scope** — the native loops port the `[L]`/`[I]` subset
  reachable through the AX tree (page state, transition stability, app-alive).
  Focus-subtree, CLS, and blue-hue invariants stay on the web lanes where the DOM
  is directly observable. The scripted iOS `GestureSemanticsUITests` legs cover
  the 50% pager threshold and the home-surface long-press
  (callout-suppression + no-navigation) semantics; native tile-tap-launch and
  tile-long-press legs are **pending** on both Android and iOS (rows 11–12 mark
  them `N/A — pending`) — those semantics are owned by the web lanes, and a
  native regression that navigates the rail is still caught indirectly by the
  loop's page probe. The notification center rows (14–16) are web-lane-owned by
  design: the widget has no gesture recognizer to regress natively.
- **curation rows (21–24)** — pure deterministic functions
  (`curateLauncherPages`), fully owned by the jsdom unit lane; there is no gesture
  to drive on-device.
