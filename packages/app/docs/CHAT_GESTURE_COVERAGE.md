# Chat / touch / gesture coverage matrix (#12188)

Checked-in inventory of every **chat/touch/gesture interaction** in the app and
its multi-level test coverage. This doc is the human-readable companion to the
enforced gate
[`packages/app/test/chat-gesture-coverage.test.ts`](../test/chat-gesture-coverage.test.ts).

**The gate is what keeps this honest.** Adding a new **gesture-handler site** to
`packages/ui/src` (a pointer-capture drag, a custom touch handler, or a
gesture-engine hook) without a matrix row **fails CI**. This doc is a table a
reviewer can read; the gate is the assertion a CI run enforces. Keep them in
sync — the gate's "stable roster" test pins the exact site set, so a drift in
either surface is caught.

## What "gesture-handler site" means

A file under `packages/ui/src` is a gesture-handler site when it registers a real
pointer/touch gesture — identified by three low-false-positive markers (see
`GESTURE_MARKERS` in the gate):

1. `setPointerCapture(` — you only capture a pointer to run a drag/pan gesture.
2. a custom touch registration — `onTouchStart` / `addEventListener("touchstart"`
   / `.on("touchstart"` (a hand-rolled touch gesture, not a click).
3. a named gesture-engine hook — `usePullGesture` / `useHorizontalPager` /
   `useNotificationPull` / `useConversationSwipeJank` (definition or consumer).

A plain `onClick` / `onPointerDown` button is intentionally **not** a gesture
site. `*.test.*` / `*.fuzz.*` specs, `__e2e__` fixtures, and `testing/`
scaffolding are excluded. The current roster is 15 files (pinned in the gate).

**Out of scope of this matrix:** HTML5 native drag-and-drop reorder
(`CharacterEditorPanels.tsx`, `draggable`/`onDragStart`) is a distinct input
model, not a synthesized touch/pointer gesture, and is not a gesture-handler
site.

## Test levels

Each bug class has one home ([the practical test pyramid](https://martinfowler.com/articles/practical-test-pyramid.html)):

- **L1** — pure recognizer / layout math (node / jsdom).
- **L2** — component handler wiring (jsdom; honest about its limits).
- **L3** — real CDP touch + video: a `__e2e__` fixture runner
  (`packages/ui/src/components/shell/__e2e__/run-*.mjs`) or a ui-smoke spec
  (`gesture-matrix.spec.ts`) on the shipped app.
- **L4** — platform walkthrough + video: web ui-smoke (`E2E_RECORD`), desktop
  bridge recorder, Android `adb screenrecord`, iOS XCUITest + `simctl`.

The L3 `__e2e__` runners all compose the shared runner toolkit
([`packages/ui/src/testing/e2e-runner/`](../../ui/src/testing/e2e-runner/index.ts))
and record a stable-named `.webm` (Design decision 8).

## Two evidence lanes

| Lane | Produced by | Enforced by the gate? |
| --- | --- | --- |
| **Automated (L1–L3)** | jsdom unit/component tests, the `run-*-e2e.mjs` CDP-touch runners (real gestures + video), and `gesture-matrix.spec.ts` on the shipped app | ✅ Existence of every referenced test/runner file is asserted; running them is a CI lane, not this vitest gate. |
| **Platform / manual (L4)** | `bun run --cwd packages/app audit:app`, `capture:ios-sim` / `capture:android-emu` / desktop, video walkthroughs | ❌ No — needs a booted renderer / device; tracked here, produced per [`PR_EVIDENCE.md`](../../../PR_EVIDENCE.md). |

The vitest gate is deliberately **boot-free** (file reads + set diffs), like its
sibling [`launcher-view-coverage.test.ts`](../test/launcher-view-coverage.test.ts),
so it runs on every PR in the cheap `test:client` lane.

## Interaction matrix

`Sites` = the `packages/ui/src` gesture-handler file(s) the row governs (the
gate's `sites`). `Coverage` = the levels with a real test today.

| # | Interaction | Surface | Sites | Coverage |
| --- | --- | --- | --- | --- |
| 1 | Sheet drag detents (pill↔input↔full), flick vs slow | overlay grabber | `use-pull-gesture.ts`, `ContinuousChatOverlay.tsx` | L1 `chat-panel-layout.test.ts` + `use-pull-gesture.test.ts`; L3 `run-chat-sheet-e2e.mjs` (video) + `gesture-matrix.spec.ts` |
| 2 | Conversation edge-swipe L/R (+ jank telemetry) | overlay transcript | `ContinuousChatOverlay.tsx`, `useConversationSwipeJank.ts`, `use-pull-gesture.ts` | L1 `useConversationSwipeJank.test.ts`; L3 `run-conversation-swipe-e2e.mjs` (video) |
| 3 | Long-press copy on message (420 ms, move-cancel) | overlay row | `ContinuousChatOverlay.tsx` | L3 `run-chat-sheet-e2e.mjs` |
| 4 | Tap-reveal action row (touch) / hover rail (desktop) | chat-message | `chat-message.tsx` | L2 `chat-message.tap-reveal.test.tsx` |
| 5 | Long-press conversation item → context menu (450 ms) | chat-conversation-item | `usePressAndHold.ts` (spread by `chat-conversation-item.tsx`) | L2 `chat-conversation-item.test.tsx`, `gestures.test.ts` |
| 6 | Push-to-talk hold (composer + overlay mic) | composer + overlay mic | `usePushToTalk.ts` (pointer-capture hold) | L2 `chat-composer.test.tsx`, `usePushToTalk.test.tsx` |
| 7 | Tap-outside collapse; drag-vs-tap slop; scrim click-through | overlay | `ContinuousChatOverlay.tsx` | L3 `gesture-matrix.spec.ts` |
| 8 | Notification pull / pull-to-refresh; ghost-click gate | home top edge | `use-notification-pull.ts`, `HomeScreen.tsx` | L1 `use-notification-pull.test.ts`; L3 `gesture-matrix.spec.ts`; L4 Android `touch-gesture.android.spec.ts` |
| 9 | Home↔launcher pager swipe, nested-pager arbitration (#12179) | pager | `useHorizontalPager.ts`, `HomeLauncherSurface.tsx`, `HomeScreen.tsx` | L1 `useHorizontalPager.test.ts`; L3 `gesture-matrix.spec.ts` + `run-home-screen-e2e.mjs` (video) + `HomeLauncherSurface.test.tsx`; L4 Android |
| 10 | Topic group flick collapse/expand | TopicGroup | `TopicGroup.tsx` | L3 `run-chatux-gesture-e2e.mjs` (video) |
| 11 | Send/stop/edit/delete/retry; streaming render; typing phases | chat thread | `ContinuousChatOverlay.tsx` | L3 `run-chat-sheet-e2e.mjs` (video) |
| 12 | Attachments: add/paste/remove outbound; open/lightbox inbound | composer + thread | _not a gesture (see note)_ | L2 `MessageAttachments.test.tsx` |
| 13 | Keyboard avoidance (visualViewport vs native lift) | overlay layout | _layout math_ | L1 `chat-panel-layout.test.ts` |
| 14 | Auto-scroll at bottom vs reading-scrollback | thread | `ContinuousChatOverlay.tsx` | L3 `run-chat-sheet-e2e.mjs` (video) |
| 15 | Kiosk window drag; sidebar/panel resize drags | shell surfaces | `KioskViewCanvas.tsx`, `TasksEventsPanel.tsx`, `sidebar-root.tsx` | L2 `KioskViewCanvas.gestures.test.tsx` |
| 16 | Graph pan/pinch/wheel-zoom | RelationshipsGraphPanel | `RelationshipsGraphPanel.tsx` | **gap** — L3 planned (app-side `touchPinch`/`touchPan`) |
| 17 | Slash menu open/dismiss (incl. outside pointerdown) | composer | _composer_ | L2 `ContinuousChatOverlay.slash.test.tsx` + `MessageContent.slash-command.test.tsx` |
| 18 | Pinch/dblclick on chat surface (should NOT zoom/break layout) | overlay | `ContinuousChatOverlay.tsx` | **gap** — L3 negative test planned |

## Coverage gaps

Every one of the 15 discovered gesture-handler sites is in a matrix row (the
gate proves it). Two rows are honest **gaps** with no automated test yet:

- **Row 16 (graph pan/pinch/wheel-zoom)** — `RelationshipsGraphPanel.tsx` has no
  L3 spec; planned via the app-side `touchPinch`/`touchPan` helpers
  (`packages/app/test/ui-smoke/helpers/real-touch-gestures.ts`).
- **Row 18 (pinch/dblclick negative test)** — no test asserts the chat surface
  refuses to zoom; planned as an L3 negative case.

These gaps are visible on purpose. A new gesture site can never land **silently**
without a row — the gate's "every gesture-handler site is covered" assertion
fails for it.

## How to add coverage for a new gesture

When you add a gesture-handler site to `packages/ui/src` (the gate tells you if
one appeared), do all three:

1. Add the file to the `sites` of the matrix row whose interaction it implements
   — or add a new row — in
   [`packages/app/test/chat-gesture-coverage.test.ts`](../test/chat-gesture-coverage.test.ts),
   and update `PINNED_GESTURE_SITES`.
2. Add a real test at the right level (L1 recognizer math, L2 handler wiring, L3
   CDP-touch runner or `gesture-matrix.spec.ts` section) and reference it in the
   row's `tests`.
3. Add a row to the matrix table above.

Then capture the L4 platform evidence (`audit:app`, Android/iOS/desktop where
relevant) for the PR per `PR_EVIDENCE.md`.

## Scope boundary vs #12179

The gesture **engines** (`use-pull-gesture.ts`, `useHorizontalPager.ts`,
`use-notification-pull.ts`, `useConversationSwipeJank.ts`) and the shared runner
toolkit are owned here (#12188). Row 9's launcher-surface files
(`Launcher.tsx`, `HomeLauncherSurface.tsx`) and their long-loop interaction
tests are owned by **#12179**; this matrix references those tests but does not
edit the launcher internals.
