# #10713 — per-message chat actions evidence

`ondevice-copy-conversation-removed.png` — rendered on a connected Android
instance (emulator-5556, via the device's own Chrome + `adb reverse`): the chat
header goes from 3 controls (maximize, **copy-conversation**, more) to 2
(maximize, more) — the stray copy-conversation button is gone.

This is the button-removal acceptance criterion of #10713. `grep -rn
"copy conversation" packages/ui/src` returns no live UI button; all dead wiring
(handlers, state, timers, unused imports) removed from both the overlay header
and the legacy ChatView. The pure `conversationTranscriptText` serializer + its
test are kept per the issue. The per-message Copy/Play/Edit action row is a
separate, larger follow-up.

## Browser app smoke — desktop + mobile

Command:

```bash
E2E_RECORD=1 ELIZA_TTS_DEBUG=1 ELIZA_UI_SMOKE_PORT=2170 ELIZA_UI_SMOKE_API_PORT=31370 ELIZA_API_PORT=31370 bunx playwright test --config packages/app/playwright.ui-smoke.config.ts packages/app/test/ui-smoke/chat-message-actions.spec.ts --project=chromium
```

Result: 2 passed.

What the smoke drives in the real app shell:

- Desktop and mobile viewport launch at `/chat` with seeded conversation history.
- Assistant message click reveals the action row: Copy + Play audio.
- Copy flips the row button to `Copied`.
- Play invokes the visible Play control while `ELIZA_TTS_DEBUG=1` is enabled for renderer TTS traces.
- User message click reveals Copy + Edit.
- Edit opens the inline editor, saves `draft me a polished action row`, and the spec asserts the real chat send stream POST includes the edited text.
- The removed top-menu `copy conversation` button is asserted absent.

Screenshots:

- `desktop-chat-open.png`
- `desktop-assistant-actions.png`
- `desktop-assistant-copied.png`
- `desktop-assistant-play.png`
- `desktop-user-actions.png`
- `desktop-user-editing.png`
- `mobile-chat-open.png`
- `mobile-assistant-actions.png`
- `mobile-assistant-copied.png`
- `mobile-assistant-play.png`
- `mobile-user-actions.png`
- `mobile-user-editing.png`

Screen recordings:

- `desktop-message-actions.mp4`
- `mobile-message-actions.mp4`

Manual review notes:

- Desktop assistant and user rows render beneath their bubbles with compact icon-only controls, orange active state, and no old copy-conversation top-menu button.
- Mobile rows fit within the sheet without text/button overlap; the inline editor remains readable and its Cancel/Send controls fit.
- Moving from one revealed message row to another currently takes a dismissing tap plus a reveal tap; this smoke accounts for that current behavior.

N/A:

- Real-LLM trajectory: presentation-layer affordance, no prompt/model behavior.
- Backend synthesis logs/audio capture: this browser smoke verifies the Play control and renderer TTS path; a live audio-output capture would require an OS audio recorder/device lane.
