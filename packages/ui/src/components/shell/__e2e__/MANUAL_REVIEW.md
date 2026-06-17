# Continuous-chat pull-sheet e2e — manual review

Run: `bun run --cwd packages/ui test:chat-sheet-e2e` (real headless chromium, no
app server — esbuild bundles `chat-sheet-fixture.tsx`, Playwright drives real
pointer gestures). Screenshots land in `output/`; the browser console is
captured and the run fails on any page error or error-level log.

## Verdict: **good**

The harness mounts the real `ContinuousChatOverlay` over the flat orange `/chat`
backdrop. The chat is ONE connected panel — its base is the always-present input
and the history grows UP out of it — fully **collapsed** at rest (just the input
+ a grabber handle, no peek/whisper). Three detents: COLLAPSED (thread 0) → HALF
(46vh) → FULL (72vh), driven by **real drag gestures** on **both input types**,
plus every control and state. The detent is asserted via the semantic
`data-detent` (collapsed/half/full) and the measured `chat-thread` height.

### Gestures — run for MOUSE (desktop 1180×820) and TOUCH (mobile 402×874)
Files prefixed `desktop-*` (real Playwright mouse, pointerType=mouse) and
`mobile-*` (dispatched PointerEvents, pointerType=touch):

- **collapsed** — rest with the thread height 0; just the input (`*-collapsed`).
- **slow pull-up → HALF** (`*-half`) — distance-threshold step, thread ≈ 46vh.
- **slow pull-up → FULL** (`*-full`) — second step, thread ≈ 72vh.
- **drag BEYOND full, held** (`*-beyond-full-rubberband`) — a 260px overshoot
  resolves to only a small rubber-banded delta over FULL (not 1:1), then springs
  back to FULL on release.
- **mid-drag hold** (`*-mid-drag-hold`) — the thread tracks the finger 1:1 at an
  arbitrary height between detents.
- **pull-down stepping** (`*-back-to-collapsed`) — FULL→HALF→COLLAPSED.
- **click-out collapses** (`*-clicked-out-collapsed`) — opening then clicking the
  dimmed view behind collapses the chat back to the input.
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
