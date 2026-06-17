# Continuous-chat pull-sheet e2e — manual review

Run: `bun run --cwd packages/ui test:chat-sheet-e2e` (real headless chromium, no
app server — esbuild bundles `chat-sheet-fixture.tsx`, Playwright drives real
pointer-drag gestures). Screenshots land in `output/`; the browser console is
captured and the run fails on any page error.

## Verdict: **good**

The harness mounts the real `ContinuousChatOverlay` over a fake "Workspace" view
and exercises every state of the pull-up chat sheet with **real drag gestures**,
asserting each transition (25 assertions) and screenshotting every interaction
for visual review.

What the run proves, in a real browser:

- **closed peek** (`01-closed.png`) whispers the LATEST line at the bottom (the
  ResizeObserver re-pins across the animated collapse — not the oldest line).
- **pull-up** (`02-pull-up-mid-drag.png` → `03-open.png`) springs the sheet open
  via a real grabber drag; the transcript is pinned to the newest line.
- **click-out is a no-op** (`04-open-after-scrim-click.png`) — clicking the scrim
  leaves the sheet open (it has no click handler by design).
- **scroll history** (`05-open-scrolled-history.png`) reveals earlier turns;
  scrolling never closes the sheet.
- **pull-down** (`06-pull-down-mid-drag.png` → `07-closed-after-pulldown.png`)
  closes it, and the closed peek re-pins to the latest line even when closed
  from scrolled-up history.
- **keyboard a11y** (`08`/`09`) — the grabber's ArrowUp/ArrowDown open/close.
- **type-to-open** (`10-open-via-typing.png`) — typing in the composer pulls the
  sheet up.
- **send → responding → reply** (`11-open-responding.png` with typing-dots →
  `12-open-after-reply.png`) — the sent line and the reply both view, latest
  pinned to the bottom near the composer.
- **Escape** (`13-closed-after-escape.png`) closes the sheet.
- **empty thread** (`14-empty-no-thread.png`) renders no sheet — just the
  composer + resting suggestion strip.
- **reduced-motion** (`15-reduced-motion-open.png`) still opens (cross-fade, no
  spring).
- **desktop** (`16`/`17`) — the sheet is centered with a max-width and the closed
  peek shows the latest line there too.

Console is asserted clean (no page errors, no error-level logs) and the fixture's
send / phase-transition log flow is verified.
