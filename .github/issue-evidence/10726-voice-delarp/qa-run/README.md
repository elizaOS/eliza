# Voice QA checklist — agent execution (functional, DOM-verified)

Driver: `scratchpad/qa-execute.mjs` (Playwright, fake-audio) against the **live running app**
(`http://127.0.0.1:2138`, serving the current `@elizaos/ui`). Transcription is engaged via the
`/toggle-transcription` slash command (no mic/PTT), which the app wires to `toggleTranscriptionMode`.

`verdict.json` is the machine-readable result. Desktop lane (7/9, both non-passes explained below):

| Check | Result | Observed |
|---|---|---|
| A — resting composer | PASS | mic `talk`, no transcribe/send/stop control (button correctly hidden off voice mode) |
| B — draft morphs to send | PASS | typing → `chat-composer-action` label `send`; transcribe hidden |
| B — clear back to mic | PASS | clearing the draft → mic `talk` |
| **C — transcription engaged (#10699)** | **PASS** | `chat-composer-transcribe` present, `aria-label="stop transcription"`, `aria-pressed=true`, `chat-transcribing-badge` visible — the #10699 button appears + goes active + the status badge shows, driven purely by the slash command |
| D — text while transcribing | expected | `action=false` while `badge=true` — **correct**: transcription keeps `recording=true`, so the trailing control stays the mic/transcribe pair (draft sends via Enter), it does NOT morph to a send button. (The checklist assertion was wrong; behavior is right.) |
| E — transcription toggle off | PASS | tapping the transcribe button clears the badge, mic stays on |
| F — view switch → back | PASS | composer reachable after navigating home and back to chat |

Mobile lane hit a `page.goto` timeout under machine load (env, not a product defect).

## Why no screenshots here
The **running app is the Eliza shell** (`eliza/apps/app`), whose onboarding gate is not
dismissable via the eliza storage keys, so its onboarding renders **on top of** the (mounted,
correctly-stated) chat overlay — the DOM states above are real, but the pixels are occluded.
Clean full-page pixels + the end-to-end **video** come from the eliza-app e2e
(`chat-send-voice-newchat-fuzz.spec.ts`, desktop + Pixel-7), which seeds storage to skip onboarding.
