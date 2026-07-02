# L3 — Gesture matrix audit (drag / swipe / long-press / flick / short-press / click / click-through / drag-through)

Branch: `feat/ui-interaction-launcher-epic` @ develop `8e396f4702e`.
Scope: every pointer/touch/gesture handler in the app shell (`packages/ui/src/components/shell/**`,
`packages/ui/src/components/pages/Launcher.tsx` gesture handlers, `packages/ui/src/hooks/` gesture hooks,
`packages/ui/src/components/apps/**` window drag), the layer/stacking model, plus real-gesture e2e in
`packages/app/test/ui-smoke/`.

## 1. Gesture inventory (surface × gesture × handler × verdict)

| # | Surface | Gesture(s) | Handler (file:line at audit time) | Verdict |
|---|---------|-----------|-----------------------------------|---------|
| 1 | `usePullGesture` (shared shell gesture engine) | vertical pull/flick, horizontal swipe/flick, tap, settle-free, cancel, lost-capture | `packages/ui/src/components/shell/use-pull-gesture.ts` (whole file) | **GOOD** — axis lock (8px commit, 0.8 dominance cone), rAF-coalesced drag, deferred capture on swipe-only surfaces, commit-on-cancel for Android touch (#9943), descendant `lostpointercapture` bubble filter. No defect found. |
| 2 | `useHorizontalPager` (home↔launcher rail + launcher grid pager) | horizontal drag, flick (velocity 0.45 px/ms), edge rubber-band, edge-swipe-right | `packages/ui/src/hooks/useHorizontalPager.ts` (whole file) | **GOOD** — nested-pager pointer-claim registry (innermost movable pager wins, evicts others), touch capture deliberately skipped (Android WebView pointercancel), mouse/pen capture on axis commit, velocity-aware momentum settle. No defect found. |
| 3 | Home↔launcher rail | swipe home↔launcher; ghost-click after committed flick | `packages/ui/src/components/shell/HomeLauncherSurface.tsx:46-76,108-128` | **GOOD** — `suppressClickRef` + `onClickCapture` swallows the synthesized click of a committed flick; `touch-pan-y` on both halves; `select-none` on the rail. |
| 4 | Launcher tile (IconTile) | short press (launch), long press (edit-mode toggle), move-slop cancel | `packages/ui/src/components/pages/Launcher.tsx:126-192` | **DEFECT (fixed)** — long-press had **no click suppression**: the browser synthesizes a `click` from the same press after the 450 ms timer fires. Entering edit mode was saved only by re-render timing (`!editing` guard), but a long-press **while in edit mode** toggles edit OFF and the trailing click then passed `!editing` → the tile **ghost-launched**. Fixed with a `longPressFiredRef` that swallows exactly the click of a fired long-press. |
| 5 | Launcher grid pager | page swipe/flick, edge buttons, touch no-capture guard, edit-mode gate | `packages/ui/src/components/pages/Launcher.tsx:493-544` + hook #2 | **GOOD** — `touch-action: pan-y`, paging disabled in edit mode (never fights Reorder drag), mouse click-through prevented structurally (capture retargets the click to the viewport). |
| 6 | Launcher edit-mode reorder | long-press → drag reorder (framer `Reorder.Group`) | `packages/ui/src/components/pages/Launcher.tsx:581-605` | **GOOD** — `drag`/`dragListener` gated on `editing`; pager disabled while editing. |
| 7 | Home screen notification pull zone | pull-down (open center), tap, keyboard | `packages/ui/src/components/shell/HomeScreen.tsx:184-215` | **DEFECT (fixed)** — the strip is a `<button>` whose `onClick` unconditionally opened the center. Every pointer release beyond tap slop **also** synthesizes a click on the button (usePullGesture captures the pointer to it), so the direction gate was decorative in a real browser: an **upward** drag or a sub-threshold wander still opened the center via the trailing click. (The existing jsdom test passed only because `fireEvent.pointerUp` does not synthesize the click a real browser does.) Fixed: pointer-derived clicks only open when the press was a genuine tap (≤ `PULL_GESTURE_TAP_SLOP`); keyboard clicks (`detail === 0`, no preceding press) always open. |
| 8 | Kiosk floating view window | title-bar drag (dragging layers) | `packages/ui/src/components/shell/KioskViewCanvas.tsx:40-99` | **DEFECT (fixed)** — window drag was missing: (a) `onPointerCancel`/`onLostPointerCapture` — after a touch-scroll/OS takeover cancels the pointer, `dragState` stayed set and the window **ghost-dragged under a hover with no button pressed**; (b) `touch-action: none` on the handle — touch drags were hijacked by scroll → `pointercancel` → (a); (c) pointer-id tracking — a second finger re-based the drag origin mid-drag; (d) clamping — the window could be dragged fully off-canvas and become **irrecoverable** (nothing left to grab); (e) `setPointerCapture`/`releasePointerCapture` unguarded (throws on detached/cancelled pointers). All fixed. |
| 9 | Chat sheet (ContinuousChatOverlay) | pull sheet detents/flick, conversation h-swipe, PTT press, tap-vs-drag click suppression | `packages/ui/src/components/shell/ContinuousChatOverlay.tsx:1447,3409,4051` (L2-owned file) | **GOOD (inventory only — L2 owns the file)** — dedicated suppression refs (`suppressNextClickRef` :1690, `suppressNextOutsideClickRef` :1589, `suppressExpandOnFocusRef` :1726), live-text-selection guard before conversation switch, swipe-jank telemetry (#9954). No gesture defect found in review; no diff needed from L3. |
| 10 | Topic group header/pill | tap toggle, pull-up/down collapse/expand, ghost-click suppression | `packages/ui/src/components/shell/TopicGroup.tsx:60-142` | **GOOD** — the reference implementation of gesture-click suppression (`suppressClickRef` + `onClickCapture`), `touch-none` on both buttons, keyboard `onClick` preserved. |
| 11 | Shell header controls | press-through prevention into the sheet drag | `packages/ui/src/components/shell/ShellHeaderControls.tsx:159,186,211,270` | **GOOD** — `onPointerDown` `stopPropagation()` on every control so pressing a header button never starts the sheet pull underneath (drag-through prevention done right); `touchAction: "manipulation"`. |
| 12 | Glass composer icon buttons (mic/send/vision) | press (PTT via onPointerDown/Up/Cancel), mousedown fast-path, synthetic-click dedupe | `packages/ui/src/components/shell/glass-composer.tsx:40-115` | **GOOD** — `pointerActivatedRef` dedupes mousedown-activation vs the trailing click; PTT surfaces pass pointer handlers instead (fast-path self-disables). Deliberate latency optimization; left as-is. |
| 13 | Pager edge buttons | click (fine-pointer only) | `packages/ui/src/components/shell/PagerEdgeButtons.tsx` | **GOOD** — media-query gated `(hover:hover) and (pointer:fine)`; a click inside the pager viewport is tap-classified by the pager (no page advance), so button + pager never double-fire. |
| 14 | Home screen scroller | vertical scroll vs rail swipe arbitration | `packages/ui/src/components/shell/HomeScreen.tsx:231` | **GOOD** — `touch-pan-y` on the scroller (documented fix: `overflow-y-auto` defaults to `touch-action: auto` which ate horizontal drags as scroll attempts → pointercancel). |
| 15 | Notification center sheet | backdrop tap dismiss, Escape, close button | `packages/ui/src/components/shell/NotificationCenter.tsx:431-465` | **DEFECT (fixed) — found BY the new e2e, live on the real app** — the sheet + backdrop use `position: fixed`, but they mount inside the home half of the home↔launcher rail, whose `translate3d` transform makes the rail their containing block. On the shipped app the "centered" sheet actually centered itself within the 200%-wide rail and painted **half-clipped off the right viewport edge** (desktop; mostly off-screen on mobile), and the backdrop missed the shell's top padding band so taps there hit the layer beneath. Invisible to the isolated home-screen fixture (no rail transform there) — a textbook integration-only layer bug. Fixed by portaling the sheet variant to `document.body`. |
| 16 | SlashCommandMenu items | pointerdown select | `packages/ui/src/components/shell/SlashCommandMenu.tsx:274-276` | **GOOD** — `preventDefault` on pointerdown keeps composer focus (standard menu pattern). |
| 17 | HomePill | tap toggle | `packages/ui/src/components/shell/HomePill.tsx` | **GOOD** — plain button, `Z_SHELL_OVERLAY`, disabled while booting. |
| 18 | App window renderer / overlay apps | (no pointer-drag surfaces) | `packages/ui/src/components/apps/AppWindowRenderer.tsx` | **N/A** — no drag/gesture handlers; overlay apps render full-bleed. The only window drag in the shell is #8. |

## 2. Layer/stacking audit (click-through & drag-through)

Canonical z scale: `packages/ui/src/lib/floating-layers.ts` ("every z-index in the app must come
from this file"): base 0 → dropdown 10 → sticky 20 → modal 50/100 → dialog 160/170 → overlay 200 →
tooltip 300 → shell overlay 9000 → first-run 9400 → tutorial 9500 → system banner 9998/9999 →
emote 11000 → config-select 12000.

- **Chat overlay above home/launcher**: overlay at `Z_SHELL_OVERLAY`; header controls stopPropagation
  on pointerdown (#11) so overlay-control presses never start the sheet drag; sheet drag captures the
  pointer so movement never scrolls the home scroller beneath (verified by e2e below).
- **Home half vs launcher half**: `aria-hidden` + the inactive launcher pages get `inert` +
  `pointer-events-none` (`Launcher.tsx:574-578`) — off-screen pages can't swallow or receive events.
- **Notification sheet above home**: full backdrop intercepts; verified backdrop tap does not
  activate home widgets beneath (e2e below).
- **Kiosk floating window above iframe view**: drag uses pointer capture so moves over the iframe
  don't get eaten mid-drag; after the fix, cancel/lost-capture end the drag instead of ghost-dragging.

## 3. Defects fixed (before → after)

1. **Launcher tile ghost-launch after long-press** (`Launcher.tsx`)
   - Before: long-press in edit mode → edit OFF + trailing click **launches the tile**.
   - After: `longPressFiredRef` swallows exactly the click synthesized from a fired long-press.
   - Test: `Launcher.gestures.test.tsx` → "long-press ghost-click suppression" (2 cases; the
     edit-exit case FAILS on the before-code).
2. **Notification pull-zone ghost open** (`HomeScreen.tsx`)
   - Before: upward or sub-threshold drags opened the center via the synthesized click (direction
     gate defeated in real browsers).
   - After: pointer clicks open only when the press stayed within `PULL_GESTURE_TAP_SLOP` (shared
     constant exported from `use-pull-gesture.ts`); keyboard activation (no preceding press) unchanged.
   - Test: `HomeScreen.test.tsx` → new ghost-click cases (upward-drag + trailing click stays closed;
     tap + click opens; keyboard opens).
3. **Kiosk floating-window drag hardening** (`KioskViewCanvas.tsx`)
   - Before: ghost drag after `pointercancel`; touch drags cancelled by scroll takeover; multi-touch
     re-based origin; window could leave the canvas irrecoverably; unguarded capture calls.
   - After: pointer-id-tracked drag state, `onPointerCancel`/`onLostPointerCapture` end the drag,
     `touch-action: none` on the handle, position clamped so the title bar stays reachable,
     guarded capture/release.
   - Test: new `KioskViewCanvas.gestures.test.tsx` (5 cases; ghost-drag case FAILS on before-code).
4. **Notification sheet fixed-position defeat by the rail transform** (`NotificationCenter.tsx`)
   - Before: on the REAL app the pull-down sheet rendered half-clipped at the right viewport edge
     (its `fixed inset-x-0 mx-auto` resolved against the `translate3d`-transformed, 200%-wide
     home↔launcher rail, not the viewport) and the backdrop missed the shell's top padding band —
     taps there went to the layer beneath. Found live by the new gesture-matrix e2e
     (`test-failed-1.png` of the first run shows the clipped sheet); the isolated home-screen
     fixture could never catch it because it mounts HomeScreen without the transformed rail.
   - After: the sheet variant (backdrop + panel) portals to `document.body`, restoring true
     viewport-fixed behavior. e2e now proves centered paint + backdrop click-through containment.

## 4. e2e (real gestures, real app)

`packages/app/test/ui-smoke/gesture-matrix.spec.ts` — auto-discovered by the directory-driven PR
lane (`scripts/ui-smoke-pr-specs.mjs`; NOT deny-listed) and added to the `mobile-chromium`
(Pixel 7, hasTouch + CDP) project for the real-touch legs. Covers:
- short press vs long press discrimination on launcher tiles (tap launches; long-press enters edit
  without launching; long-press again exits edit **without ghost-launching** — the fixed defect),
- chat sheet flick open/close via velocity-based detent snap (grabber drag),
- drag-through prevention: dragging the sheet must NOT scroll the home scroller beneath,
- click-through prevention: overlay/header controls + notification-sheet backdrop taps must not
  activate elements beneath,
- ghost-click suppression: a committed home→launcher rail flick must not tap-launch the tile under
  the finger (real CDP touch),
- notification pull-zone: pull-down opens, upward drag + trailing click stays closed (real mouse).

Run logs + screenshots in this directory: `e2e-run-chromium.log` (3/3 desktop legs green, touch leg
correctly skipped), `e2e-run-mobile-chromium.log` (Pixel 7 hasTouch + CDP touch),
`BEFORE-notification-sheet-clipped-by-rail-transform.png` (defect #4 caught live by run 1), and the
per-step `*.png` captures written by the spec itself.

## 5. Recommendations NOT implemented (medium/low confidence)

- **Flick-velocity constants** — `usePullGesture` (0.5 vertical / 0.4 horizontal px/ms) vs
  `useHorizontalPager` (`FLICK_VELOCITY` 0.45 + `MIN_FLICK_DISTANCE` 48). These are different
  gesture families (detent sheet vs paging rail with distance-OR-velocity semantics and rubber-band
  edges); unifying them would couple unlike surfaces for zero complexity win. Left separate on purpose.
- **glass-composer mousedown fast-path** (`handleMouseDown` activating `onClick` on mousedown when
  no pointer handlers are supplied) — a deliberate latency optimization with correct synthetic-click
  dedupe; changing it risks the PTT/voice press paths (L2 territory). Left as-is.
- **Mouse vertical-drag-release-over-tile fires a click** (browser-native compat-click behavior;
  the pager only captures on a *horizontal* axis commit). A mouse user dragging vertically 50px and
  releasing on the same tile launches it. Extremely narrow (mouse + vertical drag on a grid that
  doesn't vertically pan), matches native browser behavior everywhere else; suppressing it would
  need a movement tracker on every tile. Documented, not fixed.
- **`ContinuousChatOverlay`** — no gesture defect found in the sections reviewed; any future fix
  belongs to L2 (file ownership).
