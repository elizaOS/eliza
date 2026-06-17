# Continuous-chat pull-sheet e2e — manual review

Run: `bun run --cwd packages/ui test:chat-sheet-e2e` (real headless chromium, no
app server — esbuild bundles `chat-sheet-fixture.tsx`, Playwright drives real
pointer gestures). Screenshots land in `output/`; the browser console is
captured and the run fails on any page error or error-level log.

## Verdict: **good**

The harness mounts the real `ContinuousChatOverlay` over a fake "Workspace" view
and exhaustively exercises the iOS-style **three-detent** sheet (PEEK 76px → HALF
46vh → FULL 72vh) with **real drag gestures**, on **both input types**, plus
every control and state. 52 assertions; the detent is asserted via the semantic
`data-detent` attribute and corroborated by the measured pixel height.

### Gestures — run for MOUSE (desktop 1180×820) and TOUCH (mobile 402×874)
Files prefixed `desktop-*` (real Playwright mouse, pointerType=mouse) and
`mobile-*` (dispatched PointerEvents, pointerType=touch):

- **peek** — rest at 76px (`*-peek`).
- **slow pull-up → HALF** (`*-half`) — distance-threshold step, height ≈ 46vh.
- **slow pull-up → FULL** (`*-full`) — second step, height ≈ 72vh.
- **drag BEYOND full, held** (`*-beyond-full-rubberband`) — a 260px overshoot
  resolves to only a small rubber-banded delta over FULL (not 1:1), then springs
  back to FULL on release.
- **mid-drag hold** (`*-mid-drag-hold`) — the sheet tracks the finger 1:1 at an
  arbitrary height between detents.
- **pull-down stepping** (`*-back-to-peek`) — FULL→HALF→PEEK.
- **flick** (`*-flick-open`) — a 48px, <56px-travel but fast gesture opens via the
  velocity threshold (proves flick ≠ distance).
- **sub-threshold nudge** (`*-nudge-snapback`) — a small, slow gesture crosses
  neither threshold and snaps back with no detent change.

### Controls + input states (deterministic fixture loads + interactions)
- `state-empty` — no sheet; suggestion strip + composer (+ attach, mic).
- `state-booting` — composer placeholder "connecting…", attach + mic disabled.
- `state-recording-listening` — mic active (aria-pressed), warm grabber glow,
  italic interim transcript.
- `state-speaking` / `state-muted` — assistant-voice control appears and toggles
  label/icon (speaker ↔ speaker-muted).
- `state-responding` — typing-dots inside the opened sheet.
- `state-typing-send` — typing morphs mic→send and pulls the sheet open.
- `state-image-attached` — a real PNG through the hidden file input renders a
  pending thumbnail + per-image remove (×); remove clears it.
- `state-mic-clicked-recording` — clicking the mic toggles recording on/off.
- `state-suggestions` — tapping a suggestion sends and opens the sheet.
- `state-reduced-motion-open` — opens under `prefers-reduced-motion`.

Console is asserted clean (no page errors / error-level logs) and the fixture's
recording-interaction log flow is verified.
