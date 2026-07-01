# #10713 (slice) — stray "copy conversation" button removed: on-device before/after

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
