# #10715 — chat-open launcher pass-through + conversation swipe

## What Changed

- The chat backdrop is now visual-only (`pointer-events: none`) while open, so
  drags that begin outside the chat panel hit the real launcher/home surface.
- A document-level outside-tap detector preserves tap-to-collapse and
  keyboard-dismiss behavior without stealing horizontal background swipes or
  vertical background scroll.
- The existing real-browser conversation-swipe e2e fixture now renders a real
  `HomeLauncherSurface` behind the real `ContinuousChatOverlay` and asserts:
  background swipe home -> launcher while chat stays open, background tap
  collapses chat, and the existing conversation-swipe interleaving still passes.

## Evidence

- `background-swipe-passthrough.png` — chat remains open while the background
  swipe pages the underlying rail to Launcher.
- `background-tap-collapse.png` — a plain background tap collapses chat back to
  the input bar.
- `passthrough-and-conversation-swipe.webm` — recorded e2e walkthrough covering
  launcher pass-through, tap collapse, and the conversation-swipe interleaving.

## Validation

- `bun run --cwd packages/ui test:conversation-swipe-e2e` — PASS; 0 page errors,
  `conversation-swipe-jank` telemetry fired during real gestures.

Real-LLM trajectory and backend logs are N/A: this is a client-side
hit-testing/gesture change with no model or server path.
