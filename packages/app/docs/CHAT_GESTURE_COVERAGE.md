# Chat / touch / gesture coverage matrix (#12188)

Checked-in inventory of every **gesture-handler site** — a shell component that
wires a real touch/pointer gesture primitive (`usePullGesture`,
`useNotificationPull`, `useHorizontalPager`, `useConversationSwipeJank`) — and
the test that covers each interaction it exposes, per level and per platform.
This doc is the human-readable companion to the enforced gate
[`packages/app/test/chat-gesture-coverage.test.ts`](../test/chat-gesture-coverage.test.ts).

**The gate is what keeps this honest.** Wiring a new gesture primitive into a
shell component (a new handler site) without a matrix row **fails CI**. The gate
discovers handler sites straight from the source — it greps the shell component
tree for hook-call sites of the four gesture primitives — so the map cannot drift
from what actually ships. This doc is a table a reviewer reads; the gate is the
assertion a CI run enforces. Keep them in sync — the gate's
`covers a stable, non-empty set of gesture-handler sites` test pins the exact
roster below, so drift in either surface is caught.

## What "gesture-handler site" means

A shell component under
[`packages/ui/src/components/shell/`](../../ui/src/components/shell/) that calls
one of the four real-gesture primitives:

| Primitive | Module | What it drives |
| --- | --- | --- |
| `usePullGesture` | [`use-pull-gesture.ts`](../../ui/src/components/shell/use-pull-gesture.ts) | Vertical pull → detent snap / collapse-expand, with a tap-slop gate. |
| `useNotificationPull` | [`use-notification-pull.ts`](../../ui/src/components/shell/use-notification-pull.ts) | Downward home pull → reveal the notification center. |
| `useHorizontalPager` | [`useHorizontalPager.ts`](../../ui/src/hooks/useHorizontalPager.ts) | Horizontal swipe → page between rail / launcher pages. |
| `useConversationSwipeJank` | [`useConversationSwipeJank.ts`](../../ui/src/hooks/useConversationSwipeJank.ts) | Frame-budget telemetry sampled during a real conversation swipe. |

The primitive-hook modules themselves, their unit tests, and the `__e2e__`
fixtures are **not** handler sites — only the components that consume a primitive
to bind a real gesture to a shipped surface are.

## Four coverage levels

Each interaction is covered at the levels below. A handler site's matrix row
names the tests that cover it; the gate asserts every named runner/spec file
exists on disk.

| Level | What it proves | Produced by | Real input |
| --- | --- | --- | --- |
| **L1 — primitive unit** | The pull/pager/jank math (thresholds, direction gates, index resolution, frame sampling) in isolation. | `*.test.ts` beside each primitive. | none (pure functions / hook harness) |
| **L2 — component fixture e2e (hasTouch fixtures)** | The **real component**, mounted in an esbuild fixture in headless Chromium, driven by a real CDP touch/pointer gesture through the shared [`packages/ui/src/testing/real-touch-gestures.ts`](../../ui/src/testing/real-touch-gestures.ts) helper. Emits video + screenshots. | `run-*-e2e.mjs` runners (the shared e2e-runner). | CDP `Input.dispatchTouchEvent`, `page.mouse` |
| **L3 — app CDP-emulation e2e** | The **shipped app** (real router + shell), gesture matrix under CDP touch emulation, including the browser's genuine compat-click synthesis that jsdom can never produce. | [`gesture-matrix.spec.ts`](../test/ui-smoke/gesture-matrix.spec.ts) via the app's own [`helpers/gesture-inputs.ts`](../test/ui-smoke/helpers/gesture-inputs.ts) / [`helpers/real-touch-gestures.ts`](../test/ui-smoke/helpers/real-touch-gestures.ts). | CDP touch emulation, `page.mouse` |
| **Platform — real device** | The same gestures on a **real Android surface** (adb-driven touch, logcat, screen record). | [`touch-gesture.android.spec.ts`](../test/android/touch-gesture.android.spec.ts). | adb `input`/`sendevent` real touch |

### The two real-touch helper contracts are split — on purpose

L2 and L3 keep **separate** real-touch helpers, and the gate asserts they are
two distinct files:

- **hasTouch fixtures (L2):** [`packages/ui/src/testing/real-touch-gestures.ts`](../../ui/src/testing/real-touch-gestures.ts)
  — drives a fixture-mounted component in a fresh `hasTouch` Chromium context.
- **CDP-emulation app specs (L3):** [`packages/app/test/ui-smoke/helpers/real-touch-gestures.ts`](../test/ui-smoke/helpers/real-touch-gestures.ts)
  and [`helpers/gesture-inputs.ts`](../test/ui-smoke/helpers/gesture-inputs.ts)
  — drives the full shipped app under the ui-smoke Playwright config's touch
  emulation, and additionally records cross-layer event leaks (compat-click /
  drag-through / click-through regressions).

They look similar but sit at different boundaries (isolated component vs. shipped
app + router + compat-click synthesis). Do **not** merge them.

## Inventory

Every gesture-handler site, the primitives it wires, the interactions it exposes,
and the tests that cover each interaction per level.

| Handler site | Primitives | Interactions | L1 unit | L2 fixture e2e | L3 app matrix | Platform (Android) |
| --- | --- | --- | --- | --- | --- | --- |
| [`ContinuousChatOverlay.tsx`](../../ui/src/components/shell/ContinuousChatOverlay.tsx) | `usePullGesture`, `useConversationSwipeJank` | Chat-sheet detent drag / flick / sub-threshold nudge / drag-and-hold / overscroll; conversation swipe-back/forward interleaving; swipe-jank telemetry. | `use-pull-gesture.test.ts`, `useConversationSwipeJank.test.ts` | `run-chat-sheet-e2e.mjs`, `run-conversation-swipe-e2e.mjs` | `gesture-matrix.spec.ts` (chat-sheet flick/drag; drag-through) | `touch-gesture.android.spec.ts` |
| [`HomeLauncherSurface.tsx`](../../ui/src/components/shell/HomeLauncherSurface.tsx) | `useHorizontalPager` | Home↔launcher rail paging; inner launcher pager; boundary rubber-band. | `useHorizontalPager.test.ts`, `useHorizontalPager.test.tsx` | `run-home-screen-e2e.mjs` | `gesture-matrix.spec.ts` (rail flick home→launcher, no ghost-launch) | `touch-gesture.android.spec.ts` |
| [`HomeScreen.tsx`](../../ui/src/components/shell/HomeScreen.tsx) | `usePullGesture`, `useNotificationPull` | Home edge pull; notification pull-down reveal; upward-drag / compat-click direction gate. | `use-pull-gesture.test.ts`, `use-notification-pull.test.ts` | `run-home-screen-e2e.mjs` | `gesture-matrix.spec.ts` (notification pull; click-through prevention) | `touch-gesture.android.spec.ts` |
| [`TopicGroup.tsx`](../../ui/src/components/shell/TopicGroup.tsx) | `usePullGesture` | Flick-up collapse header→pill; flick-down expand pill→header. | `use-pull-gesture.test.ts` | `run-chatux-gesture-e2e.mjs` | smoke-only | smoke-only |

### Coverage gaps

- **`TopicGroup` L3 / platform:** the topic collapse/expand pill has L1 (pull
  math) + L2 (the `run-chatux-gesture-e2e.mjs` real-touch fixture that flicks the
  real `TopicGroup`), but no dedicated row in the app-level CDP matrix or the
  Android device spec — the topic pill is an in-thread affordance, not a
  top-level shell gesture, so it rides the app-level chat-sheet smoke rather than
  a dedicated matrix leg. Tracked here; not a regression risk the L1+L2 lanes
  miss.

Every other handler site is covered at all four levels.

## How to add coverage for a new gesture-handler site

When you wire one of the four gesture primitives into a new shell component (the
gate tells you it is now an uncovered handler site), do all three:

1. Add the real interaction coverage: a dedicated `run-*-e2e.mjs` fixture runner
   (L2) driving the real component via
   [`packages/ui/src/testing/real-touch-gestures.ts`](../../ui/src/testing/real-touch-gestures.ts),
   and a leg in [`gesture-matrix.spec.ts`](../test/ui-smoke/gesture-matrix.spec.ts)
   (L3) if the gesture is reachable in the shipped app.
2. Add a `CHAT_GESTURE_MATRIX` entry in
   [`packages/app/test/chat-gesture-coverage.test.ts`](../test/chat-gesture-coverage.test.ts)
   and update the pinned roster in its "stable set" test.
3. Add a row to the inventory table above.

Then capture the manual-lane evidence (`audit:app`, on-device where relevant) for
the PR per [`PR_EVIDENCE.md`](../../../PR_EVIDENCE.md).
