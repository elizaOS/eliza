# #10722 — shared real-touch gesture helper + de-larp the conversation-swipe runner

De-larps a slice of the interaction-QA surface: replaces synthetic touch
(`el.dispatchEvent(new PointerEvent(...,{pointerType:"touch"}))` inside
`page.evaluate`, which bypasses hit-testing / `touch-action` / implicit capture)
with **genuine touch input** via CDP `Input.dispatchTouchEvent`.

## What changed
- **New `packages/ui/src/testing/real-touch-gestures.ts`** — a shared real-touch
  helper generalizing the inline CDP-touch drag from
  `chat-clear-swipe.spec.ts` / `onboarding-to-home.shared.ts`: `touchSwipe`
  (velocity/timing via `steps`/`stepDelayMs`, optional `holdMs` for
  long-press-then-drag), `touchTap`, `touchLongPress`, `touchPinch` (two-finger).
  Structural: works with any Playwright `Page` — the `__e2e__` runners' raw
  `playwright` page AND the ui-smoke specs' `@playwright/test` page.
- **`run-conversation-swipe-e2e.mjs`** — its `drag()` now drives real CDP touch
  through the helper instead of synthetic `PointerEvent` dispatch. The
  conversation swipe is now verified the way a finger drives it, through the real
  pointer pipeline.

## Proof (real touch commits the gesture)
`bun run --cwd packages/ui test:conversation-swipe-e2e` → **ALL PASSED** with the
real-touch driver (see `conversation-swipe-e2e.log`): the full interleaving
walk (new → swipe-forward → new → swipe-forward → swipe-back …) navigates
correctly under real touch, every nav invariant holds, the
`conversation-swipe-jank` telemetry fires during the real gestures (saw 4), and
`0` page errors.

- `conversation-swipe-realtouch-forward.png` / `-back.png` — states after a real
  touch swipe-forward / swipe-back.
- `conversation-swipe-realtouch.webm` — the recorded walkthrough.

## Finding (follow-up)
Converting `run-chatux-gesture-e2e.mjs` (TopicGroup flick-collapse) to real touch
surfaced that its fast vertical **flick does not commit** under real CDP touch
(the collapsed pill never appears) though it passes under synthetic
`PointerEvent`. That is either a real-touch velocity/timing gap or a
`touch-action` interaction worth its own investigation, so that runner is left on
its current driver pending a dedicated follow-up rather than shipped red.

## Scope (honest)
This is one concrete de-larp slice of #10722 (the shared helper + the first
synthetic-touch runner converted + proven). The remaining scope items — the
other synthetic runners, a WebKit project, XR hand/gaze + immersive-WebGL, TUI
interaction, the connected WS interact round-trip, native on-device drivers — are
follow-ups. Real-LLM trajectory / backend logs — N/A (client gesture test infra).
