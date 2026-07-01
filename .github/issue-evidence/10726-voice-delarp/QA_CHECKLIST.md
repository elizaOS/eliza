# elizaOS Voice + Chat — Definitive Manual QA Checklist

**Issue:** #10726 (voice de-larp)
**Surface under test:** live chat overlay `packages/ui/src/components/shell/ContinuousChatOverlay.tsx`, state machine `packages/ui/src/components/shell/useShellController.ts`, send queue `packages/ui/src/state/useChatSend.ts`, voice capture `packages/ui/src/voice/`.
**Execution model:** tap-by-tap. Every item has precise steps, an expected result, a PASS/FAIL/N-A checkbox, and the automated spec that covers it (or `GAP` where nothing does).

---

## How to run this checklist

1. **Build first.** `bun run build` then boot: web (`bun run dev`), desktop (`bun run dev:desktop`), or the on-device app. A screenshot of a stale bundle proves nothing (see root `PR_EVIDENCE.md`).
2. **Grant mic permission** before the acoustic sections; deny it once (row A-mic-perm) to exercise the denied path.
3. For every FAIL, capture: the composer screenshot, `GET /api/dev/console-log`, and the `/api/tts/cloud` + SSE network trace.
4. A row is **not** N-A unless the reason is written in-line.

### Canonical testIds / labels (verified in source)
- Mic control: `chat-composer-mic`. Label cycles: `talk` (idle) → `stop listening` (recording, push-to-talk off) → `end conversation` (hands-free) → `release to send` (PTT holding) → `stop transcription` (transcription mode). `active` when `recording || handsFree || transcriptionMode`.
- Transcribe control: `chat-composer-transcribe` (voice mode only, additive, beside mic). Label: `start transcription` / `stop transcription`. `active` when `transcriptionMode`. (#10699)
- Send control: `chat-composer-action`. Label: `send` / `send another` (while responding) / `send (agent stopped)` (disabled when `!canSend`).
- Stop-generating control: `chat-composer-stop`. Label: `stop generating`. Appears in the trailing slot while a reply streams and the composer is empty.
- Transcribing badge: `chat-transcribing-badge`.
- Trailing slot morphs IN PLACE between send / stop / mic (one persistent `<div>`, no remount).

### elizaOS voice semantics (do not confuse these)
- **Echo rejection** = `shouldRespondToVoiceTurn(turn, respondContext)` client pre-filter (drops agent-TTS echo / disfluency before a round-trip) **+** the server gate `core.voice_turn_signal`, which is the single authority on whether the agent replies. Client attaches `voiceTurnSignal` via `buildVoiceTurnSignal`.
- **Converse (hands-free)** routes finals through `TurnAggregator` (semantic end-of-turn); commits call `send(turn, {channelType:'VOICE_DM', metadata:{voiceSource, voiceTurnSignal}})`.
- **Transcription mode** = record-only, long-form, VERBATIM. The agent **never replies** to a transcribed turn. It is **additive**: mic stays on, composer keeps working; enabling it pauses the hands-free reply loop. Finalizing drops the transcript into the composer as an attachment.
- **The mic is the master control.** Transcribe-off (`toggleTranscriptionMode` off-path) leaves the mic ON. Only the **mic button** (`stopTranscriptionAndMic`) turns the mic — and therefore transcription — fully OFF.
- **Dictation (push-to-talk)** bypasses the aggregator: press-release is the turn boundary, fills the composer draft only.
- **THE RACE (#10700):** a shell `send()` enqueue resolves its `conversationId` LATE at drain time (`turn.conversationId ?? activeConversationIdRef.current ?? ""`). A `clearConversation` (new chat) between a voice/suggestion enqueue and its drain can reroute the turn to the NEW conversation. `handleChatSend` (typed sends) snapshots `conversationId` at enqueue and is NOT exposed. Cold-open double-send must create exactly ONE conversation.

---

# SECTION A — Button-state matrix (every control × every state)

For each row, drive the app into the STATE, read the control, and confirm LABEL + `active`/`aria-pressed` + enabled. Verify via the trailing-slot testId.

## A.1 Mic control (`chat-composer-mic`) label + active per state

- [ ] **A-mic-1 — Idle (mic off, no draft, not responding).** Steps: fresh chat, empty composer, no voice. Expect: mic glyph, label `talk`, `active=false`. Covers: `voice-selftest-e2e.spec.ts`.
- [ ] **A-mic-2 — Recording, PTT off (hands-free single-listen).** Steps: tap mic to start listening (not hands-free). Expect: label `stop listening`, `active=true`. Covers: `voice-workbench-voice-recognition.spec.ts`.
- [ ] **A-mic-3 — Hands-free engaged (always-on converse).** Steps: enable hands-free/continuous mode. Expect: label `end conversation`, `active=true`. Covers: `voice-workbench-respond-no-respond.spec.ts`.
- [ ] **A-mic-4 — Push-to-talk holding.** Steps: press-and-hold mic (`beginPushToTalkPress`), do not release. Expect: label `release to send`, `active=true`. Covers: `GAP` (no PTT-hold label spec) — NEW `voice-button-matrix.spec.ts`.
- [ ] **A-mic-5 — Transcription mode.** Steps: enter transcription (button/slash/phrase). Expect: mic label `stop transcription`, `active=true`. Covers: `voice-workbench-transcription-mode.spec.ts`.
- [ ] **A-mic-6 — Draft present (mic hidden → send shown).** Steps: type any text. Expect: trailing slot is SEND (`chat-composer-action`), mic not rendered in trailing slot. Covers: `full-walkthrough.spec.ts`.
- [ ] **A-mic-7 — Reply streaming, empty composer (mic → stop).** Steps: send, then while reply streams keep composer empty. Expect: trailing slot is STOP (`chat-composer-stop`), label `stop generating`. Covers: `GAP` — NEW `voice-button-matrix.spec.ts`.
- [ ] **A-mic-8 — Mic permission denied.** Steps: deny OS mic permission, tap mic. Expect: capture does not start, no stuck `recording=true`, a clear denied affordance (not a silent no-op that looks live). Covers: `GAP` — NEW `voice-permission-denied.spec.ts`.
- [ ] **A-mic-9 — `aria-pressed` mirrors `active`.** Steps: for each of A-mic-2/3/5, read `aria-pressed`. Expect: matches `active`. Covers: `GAP` — NEW `voice-button-matrix.spec.ts`.

## A.2 Transcribe control (`chat-composer-transcribe`, #10699)

- [ ] **A-tr-1 — Hidden outside voice mode.** Steps: text-only (no voice engaged). Expect: transcribe control NOT in DOM. Covers: `GAP` — NEW `voice-button-matrix.spec.ts`.
- [ ] **A-tr-2 — Visible in voice mode, resting.** Steps: engage voice/hands-free. Expect: transcribe control present beside mic, label `start transcription`, `active=false`. Covers: `voice-workbench-transcription-mode.spec.ts`.
- [ ] **A-tr-3 — Active while transcribing.** Steps: enter transcription. Expect: label `stop transcription`, `active=true`, `aria-pressed=true`. Covers: `voice-workbench-transcription-mode.spec.ts`.
- [ ] **A-tr-4 — Additive: mic still active when transcribe active.** Steps: enter transcription. Expect: BOTH transcribe `active` AND mic `active` (mic label `stop transcription`). Covers: `GAP` — NEW `voice-button-matrix.spec.ts`.
- [ ] **A-tr-5 — Transcribe distinct from mic testId.** Steps: inspect DOM in voice mode. Expect: `chat-composer-transcribe` and `chat-composer-mic` are two separate elements. Covers: `GAP` — NEW `voice-button-matrix.spec.ts`.

## A.3 Send control (`chat-composer-action`)

- [ ] **A-send-1 — Enabled with draft, agent up.** Steps: type text, agent ready. Expect: label `send`, enabled. Covers: `full-walkthrough.spec.ts`.
- [ ] **A-send-2 — `send another` while responding.** Steps: send, then type again while reply streams. Expect: label `send another`, enabled. Covers: `GAP` — NEW `voice-button-matrix.spec.ts`.
- [ ] **A-send-3 — Disabled when agent stopped.** Steps: force `!canSend` (agent stopped). Expect: label `send (agent stopped)`, `disabled=true`. Covers: `GAP` — NEW `voice-button-matrix.spec.ts`.
- [ ] **A-send-4 — Image-only send valid.** Steps: attach image, no text. Expect: send enabled (send is valid with image-only). Covers: `full-walkthrough.spec.ts`.
- [ ] **A-send-5 — Empty-empty no-op.** Steps: no text, no image, tap where send would be. Expect: mic shown instead, no empty message sent. Covers: `full-walkthrough.spec.ts`.
- [ ] **A-send-6 — `onPointerDown` preventDefault keeps keyboard up (mobile).** Steps: on Pixel-7 lane, tap send once. Expect: message sends on FIRST tap, keyboard stays up. Covers: `GAP` — NEW `voice-button-matrix.spec.ts` (mobile-chromium).

## A.4 Stop-generating control (`chat-composer-stop`)

- [ ] **A-stop-1 — Appears while streaming, empty composer.** Steps: send, keep composer empty during stream. Expect: STOP shown, label `stop generating`. Covers: `GAP` — NEW `voice-button-matrix.spec.ts`.
- [ ] **A-stop-2 — Interrupts generation.** Steps: tap stop mid-stream. Expect: generation aborts, stream ends, control returns to mic. Covers: `GAP` — NEW `voice-button-matrix.spec.ts`.
- [ ] **A-stop-3 — Hidden when composer has draft during stream.** Steps: type during stream. Expect: trailing slot becomes SEND (`send another`), not STOP. Covers: `GAP` — NEW `voice-button-matrix.spec.ts`.

## A.5 Transcribing badge (`chat-transcribing-badge`)

- [ ] **A-badge-1 — Shown only while transcribing.** Steps: enter transcription. Expect: badge visible; exit → badge gone. Covers: `voice-workbench-transcription-mode.spec.ts`.
- [ ] **A-badge-2 — Badge clears on mic-master-off.** Steps: transcribing, tap mic (master off). Expect: badge gone, transcript finalized. Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.

## A.6 Trailing-slot morph integrity

- [ ] **A-morph-1 — In-place morph, no remount pop.** Steps: type one char (mic→send), delete it (send→mic). Expect: one persistent `<div>`; no scale/fade remount flicker on each keystroke crossing the draft boundary. Covers: `GAP` — NEW `voice-button-matrix.spec.ts` (visual).
- [ ] **A-morph-2 — Slot precedence: send > stop > mic.** Steps: draft present + reply streaming. Expect: SEND wins (not STOP). Then clear draft mid-stream → STOP. Then stream ends → MIC. Covers: `GAP` — NEW `voice-button-matrix.spec.ts`.

---

# SECTION B — Voice capture & acoustic conditions

> Real audio only. Use the `chromium-voice-mic` Playwright project with `--use-file-for-fake-audio-capture` and WAV fixtures (`voice-realaudio.spec.ts` model). Known-phrase fixture: `@elizaos/ui/src/voice/voice-selftest/fixtures/known-phrase`.

## B.1 USER SCENARIO: voice getting loud then quiet (dynamic amplitude mid-utterance)

- [ ] **B-amp-1 — Loud→quiet ramp within one utterance.** Steps: play a WAV that starts loud, decays to near-whisper, all one sentence. Expect: full utterance transcribed as ONE turn (VAD does not cut on the quiet tail); analyser reflects amplitude; end-of-turn fires once at true end. Covers: `GAP` — NEW `voice-realaudio-dynamics.spec.ts` (dynamic-gain WAV).
- [ ] **B-amp-2 — Quiet→loud swell.** Steps: WAV rising from whisper to shout. Expect: no early cutoff at the quiet head, one committed turn. Covers: `GAP` — NEW `voice-realaudio-dynamics.spec.ts`.
- [ ] **B-amp-3 — Amplitude dip does not false-trigger end-of-turn.** Steps: loud → brief quiet dip (< silence threshold) → loud again. Expect: single turn, not two. Covers: `voice-workbench-pauses.spec.ts` (pause tolerance) + `GAP` for real dynamic-gain audio.

## B.2 USER SCENARIO: multiple voices / speakers overlapping

- [ ] **B-multi-1 — Two speakers overlapping.** Steps: WAV with two simultaneous voices. Expect: diarization separates or the aggregator commits coherent turns; agent does not merge both into one garbled reply. Covers: `voice-workbench-multi-speaker.spec.ts`, `voice-workbench-diarization.spec.ts`.
- [ ] **B-multi-2 — Multiple distinct voices sequentially.** Steps: 3 different speakers in turn. Expect: distinct turns; wrong-speaker turns gated appropriately. Covers: `voice-workbench-multi-voice.spec.ts`.
- [ ] **B-multi-3 — Multi-agent room.** Steps: agent-room scenario with multiple agents/speakers. Expect: only intended turns route to the agent. Covers: `voice-workbench-multi-agent-room.spec.ts`.

## B.3 USER SCENARIO: background conversation in the room while user talks to agent

- [ ] **B-babble-1 — Room babble under the user's voice.** Steps: WAV: user speaks a command over continuous background chatter. Expect: the user's turn is captured; babble does not produce spurious agent replies (`shouldRespondToVoiceTurn` + `core.voice_turn_signal` gate). Covers: `voice-workbench-noise.spec.ts` if present, else `GAP` — NEW `voice-realaudio-babble.spec.ts`.
- [ ] **B-babble-2 — Babble-only (no user command).** Steps: WAV of pure background conversation, no direct address. Expect: ZERO agent replies (server gate suppresses). Covers: `voice-workbench-respond-no-respond.spec.ts` + `GAP` for real babble WAV.
- [ ] **B-babble-3 — Low SNR command.** Steps: quiet command buried in loud babble. Expect: either a clean transcript or a graceful no-commit — never a hallucinated command routed to the agent. Covers: `GAP` — NEW `voice-realaudio-babble.spec.ts`.

## B.4 USER SCENARIO: people walking INTO the room, talking, then LEAVING (transient speakers)

- [ ] **B-enter-1 — Speaker enters mid-session, speaks, exits.** Steps: WAV: user talking → a second voice fades IN, says something, fades OUT → user resumes. Expect: the transient voice does not corrupt the user's turn; agent does not reply to the passer-by. Covers: `GAP` — NEW `voice-realaudio-transient-speaker.spec.ts`.
- [ ] **B-enter-2 — Transient speaker during hands-free.** Steps: hands-free on, transient voice enters. Expect: no misrouted reply; hands-free loop stays stable. Covers: `GAP` — NEW `voice-realaudio-transient-speaker.spec.ts`.
- [ ] **B-enter-3 — Transient speaker during transcription.** Steps: transcription on, person enters/talks/leaves. Expect: their speech is captured VERBATIM into the transcript (record-only), agent still never replies. Covers: `voice-workbench-transcription-mode.spec.ts` + `GAP` for transient-audio.

## B.5 USER SCENARIO: voice over conversation in the room — agent TTS echoed back through mic (echo rejection)

- [ ] **B-echo-1 — Agent TTS looped into mic.** Steps: hands-free on, agent replies (TTS plays), feed that TTS audio back into the mic. Expect: `shouldRespondToVoiceTurn` drops it client-side (recentAgentReply match, low replyAgeMs, agentSpeaking=true); server `core.voice_turn_signal` confirms no reply. Agent does NOT answer itself. Covers: `voice-workbench-respond-no-respond.spec.ts` + `GAP` for real TTS-echo WAV → NEW `voice-echo-rejection.spec.ts`.
- [ ] **B-echo-2 — Echo while `agentSpeaking=true`.** Steps: echo arrives during active TTS. Expect: dropped (agentSpeaking flag). Covers: `GAP` — NEW `voice-echo-rejection.spec.ts`.
- [ ] **B-echo-3 — Real user talks OVER agent TTS (barge-in).** Steps: user speaks a genuine new command while TTS plays. Expect: user turn is NOT dropped as echo (distinct from agent audio); barge-in interrupts/queues correctly. Covers: `GAP` — NEW `voice-echo-rejection.spec.ts`.
- [ ] **B-echo-4 — Stale-reply echo age.** Steps: echo arrives long after the reply (high replyAgeMs). Expect: gate still resolves correctly (server authority), no double-answer. Covers: `GAP` — NEW `voice-echo-rejection.spec.ts`.

## B.6 Disfluency / thinking-noise gate

- [ ] **B-dis-1 — Pure filler ("um", "uh").** Steps: WAV of only disfluency. Expect: no commit, no reply. Covers: `voice-workbench-respond-no-respond.spec.ts`.
- [ ] **B-dis-2 — Filler then real command.** Steps: "uh… what's the weather". Expect: filler head trimmed, command committed once. Covers: `voice-workbench-eot.spec.ts`.

## B.7 Pauses / end-of-turn

- [ ] **B-eot-1 — Slow speaker with mid-clause pause.** Steps: WAV with a long pause mid-sentence (converse). Expect: aggregator waits, does not cut off; single turn on true completion. Covers: `voice-workbench-pauses.spec.ts`, `voice-workbench-eot.spec.ts`.
- [ ] **B-eot-2 — Clean auto-stop carryover (one-shot backend).** Steps: local-inference auto-stops on silence with a held (unfinished) turn. Expect: `turnCarryoverRef` carries the pending fragment into the next capture; continuation appends, does NOT drop. Covers: `GAP` — NEW `voice-carryover.spec.ts`.
- [ ] **B-eot-3 — Explicit stop discards half-utterance.** Steps: mid-utterance, tap mic off / type (barge-in). Expect: `explicitStopRef` set → half-finished turn DISCARDED (not carried, not committed). Covers: `GAP` — NEW `voice-carryover.spec.ts`.

## B.8 Entity extraction over voice

- [ ] **B-ent-1 — Named entities in a voice turn.** Steps: WAV naming a person/place/time. Expect: entities extracted and enriched into the voice turn signal. Covers: `voice-workbench-entity-extraction.spec.ts`.

## B.9 Additional acoustic edge cases

- [ ] **B-x-1 — Clipping / over-driven mic.** Steps: WAV that clips (0 dBFS square-ish peaks). Expect: no crash in the analyser; transcript degrades gracefully, no phantom command. Covers: `GAP` — NEW `voice-realaudio-dynamics.spec.ts`.
- [ ] **B-x-2 — Near-silence whole utterance.** Steps: WAV at −45 dBFS throughout. Expect: no false end-of-turn commit spam; either one quiet transcript or a clean no-commit. Covers: `GAP` — NEW `voice-realaudio-dynamics.spec.ts`.
- [ ] **B-x-3 — Sudden onset (cold-start speech).** Steps: WAV that begins with speech in frame 0 (no lead-in silence). Expect: no clipped first word. Covers: `GAP` — NEW `voice-realaudio-dynamics.spec.ts`.
- [ ] **B-x-4 — Long trailing silence after speech.** Steps: command then 10s silence. Expect: single commit at end-of-speech, capture returns to idle/re-listen; no hang. Covers: `voice-workbench-eot.spec.ts` + `GAP` for the long-tail assert.
- [ ] **B-x-5 — Cross-talk: user + agent-TTS simultaneously (both live).** Steps: user speaks a NEW command exactly while agent TTS plays. Expect: user command answered, agent audio not treated as a turn (echo gate isolates agent audio only). Covers: `GAP` — NEW `voice-echo-rejection.spec.ts`.
- [ ] **B-x-6 — Music / non-speech noise.** Steps: WAV of music, no speech. Expect: zero commits, zero replies. Covers: `voice-workbench-noise.spec.ts` if present, else `GAP` — NEW `voice-realaudio-babble.spec.ts`.
- [ ] **B-x-7 — Same speaker, two rooms of reverb.** Steps: dry then heavily reverberant capture of the same command. Expect: both transcribe; reverb does not spawn a duplicate turn. Covers: `GAP` — NEW `voice-realaudio-dynamics.spec.ts`.
- [ ] **B-x-8 — Diarization: one speaker mislabeled across a pause.** Steps: single speaker with a 3s pause. Expect: not split into two speakers. Covers: `voice-workbench-diarization.spec.ts`.

---

# SECTION C — Transcription lifecycle (record-only; agent never replies)

## C.1 Start paths

- [ ] **C-start-1 — Start via transcribe BUTTON.** Steps: voice mode, tap `chat-composer-transcribe`. Expect: `transcriptionMode=true`, hands-free reply loop PAUSED, capture starts with `transcription` intent, badge shown. Covers: `voice-workbench-transcription-mode.spec.ts`.
- [ ] **C-start-2 — Start via SPOKEN start phrase.** Steps: while conversing, speak the start phrase (`isTranscriptionStartPhrase`). Expect: `setTranscript("")` then transcription toggles ON; the phrase itself is consumed (not sent as a turn). Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.
- [ ] **C-start-3 — Start via SERVER event.** Steps: dispatch `VOICE_CONTROL_EVENT` `command:"start"`. Expect: transcription turns ON (idempotent — "start" while already on is a no-op). Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.
- [ ] **C-start-4 — Start via SLASH command.** Steps: type the transcription slash command. Expect: transcription engages. Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.
- [ ] **C-start-5 — Enter forces chat open + unlocks audio.** Steps: from pilled/closed, enter transcription. Expect: `setIsOpen(true)`, `voiceOutput.unlockAudio()`, `beginTranscriptSession()`. Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.

## C.2 Stop paths (button-off vs mic-master-off) — CRITICAL distinction

- [ ] **C-stop-1 — Transcribe button off leaves MIC ON.** Steps: transcribing hands-free, tap `chat-composer-transcribe` off. Expect: session finalized, transcript → composer, hands-free reply loop RESUMES (`resumeHandsFreeAfterTranscriptRef`), MIC stays ON. Covers: `voice-workbench-transcription-mode.spec.ts` + `GAP` for resume-assert.
- [ ] **C-stop-2 — MIC button turns transcription fully OFF.** Steps: transcribing, tap `chat-composer-mic` (→ `stopTranscriptionAndMic`). Expect: transcription off, session finalized, mic MASTER off, hands-free NOT resumed, prior continuous mode persisted so auto-engage does not re-open the mic. Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.
- [ ] **C-stop-3 — Stop via SPOKEN exit phrase.** Steps: speak the exit phrase. Expect: transcription finalizes (off-path semantics: mic stays on). Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.
- [ ] **C-stop-4 — Stop via SERVER event.** Steps: dispatch `VOICE_CONTROL_EVENT` `command:"stop"`. Expect: transcription off (idempotent — "stop" while idle is a no-op). Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.
- [ ] **C-stop-5 — Started-with-mic-off case.** Steps: enter transcription while hands-free was OFF, then transcribe-button-off. Expect: hands-free does NOT get spuriously turned on (restore prior state only). Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.

## C.3 Transcript-drops-into-composer

- [ ] **C-drop-1 — Finalize drops transcript as composer attachment.** Steps: transcribe a paragraph, exit. Expect: transcript record created + chat link-widget; content lands in the composer to send with next message. Covers: `voice-workbench-transcription-mode.spec.ts` + `GAP` for attachment-in-composer assert.
- [ ] **C-drop-2 — Verbatim, no aggregator trimming.** Steps: transcribe with disfluencies/pauses. Expect: transcript is VERBATIM (transcription bypasses echo/disfluency aggregator; every final sent as-is after exit-phrase detection). Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.
- [ ] **C-drop-3 — Agent NEVER replies to a transcribed turn.** Steps: transcribe a full session. Expect: zero agent replies during transcription (record-only). Covers: `voice-workbench-transcription-mode.spec.ts`.
- [ ] **C-drop-4 — Wake-triggered inline reply folds into transcript (#9880).** Steps: during transcription, trigger a wake-word inline reply. Expect: the agent's answer is folded into the transcript record, speaker-labeled with the character name; one-shot flag cleared. Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.

## C.4 Re-listen loop

- [ ] **C-loop-1 — Long-form continues across silence auto-stops.** Steps: transcribe with several long silences (one-shot backend auto-stops each). Expect: re-listen loop re-opens `transcription` capture; recording continues; no lost segments. Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.
- [ ] **C-loop-2 — Re-listen suppressed while sending / speaking / draft present.** Steps: transcribing, then send / TTS plays / draft typed. Expect: re-listen timer does NOT re-open capture until those clear. Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.
- [ ] **C-loop-3 — Re-listen requires `ready`.** Steps: transcription on but agent not `ready` (model warming). Expect: loop waits; no capture spun up prematurely; resumes when ready. Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.
- [ ] **C-loop-4 — No double-capture from the loop.** Steps: force rapid loop ticks. Expect: loop no-ops when `recording || captureRef` already set. Covers: `GAP` — NEW `transcription-storm.spec.ts`.

## C.6 Transcription state-restore correctness

- [ ] **C-rest-1 — Prior continuous mode restored on mic-master-off.** Steps: hands-free OFF, enter transcription, mic-master-off. Expect: `saveContinuousChatMode(prior)` restores the pre-transcription mode; auto-engage does NOT re-open mic. Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.
- [ ] **C-rest-2 — `isOpen` stays open after finalize.** Steps: transcribe from open chat, exit. Expect: chat remains open with transcript in composer. Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.
- [ ] **C-rest-3 — Transcript session id uniqueness.** Steps: two transcription sessions back-to-back. Expect: two distinct transcript records, no merge. Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.

## C.5 USER SCENARIO: transcription on/off storms

- [ ] **C-storm-1 — 10× transcribe on/off via button.** Steps: tap `chat-composer-transcribe` on/off 10× fast. Expect: ends in a definite state matching last tap; no stuck capture (`captureRef` non-null while UI idle); no duplicate transcript sessions; badge state matches. Covers: `GAP` — NEW `transcription-storm.spec.ts`.
- [ ] **C-storm-2 — Mixed button/mic on-off storm.** Steps: alternate transcribe-toggle and mic-tap rapidly. Expect: mic-master-off always wins for mic; no orphaned session; hands-free resume flag never left dangling. Covers: `GAP` — NEW `transcription-storm.spec.ts`.
- [ ] **C-storm-3 — Server start/stop event storm.** Steps: fire alternating `voice-control` start/stop events rapidly. Expect: idempotent settle, final state matches last event. Covers: `GAP` — NEW `transcription-storm.spec.ts`.

---

# SECTION D — Interleaving & lifecycle

## D.1 USER SCENARIO: sending TEXT messages while doing voice (interleaved text + voice)

- [ ] **D-mix-1 — Type + send while hands-free listening.** Steps: hands-free on, type a text message, send. Expect: text turn sends as `DM` (not `VOICE_DM`); voice loop unaffected; reply not spoken (lastTurnVoice=false for the text turn). Covers: `GAP` — NEW `voice-text-interleave.spec.ts`.
- [ ] **D-mix-2 — Voice turn then immediate text turn.** Steps: speak a command (VOICE_DM), then immediately type+send. Expect: both land in the SAME conversation in order; voice reply spoken, text reply not. Covers: `GAP` — NEW `voice-text-interleave.spec.ts`.
- [ ] **D-mix-3 — Text mid-voice-utterance (barge-in-by-typing).** Steps: start speaking, begin typing before the utterance commits. Expect: half-utterance discarded (`explicitStopRef`), text turn sends cleanly, no ghost voice turn. Covers: `GAP` — NEW `voice-text-interleave.spec.ts`.
- [ ] **D-mix-4 — lastTurnVoice flips correctly per turn.** Steps: alternate voice/text several times. Expect: each reply's spoken-ness matches that turn's channel (VOICE_DM→spoken, DM→silent). Covers: `GAP` — NEW `voice-text-interleave.spec.ts`.

## D.2 USER SCENARIO: transcribing on/off repeatedly WHILE sending messages

- [ ] **D-txsend-1 — Send during transcription.** Steps: transcribing, type+send a text message. Expect: message sends; re-listen loop pauses during send then resumes; transcript session intact. Covers: `GAP` — NEW `transcription-send-interleave.spec.ts`.
- [ ] **D-txsend-2 — Transcribe-off, send, transcribe-on, send (×5).** Steps: repeat toggle+send. Expect: no lost/dup messages; each transcript finalization drops into composer; no misroute. Covers: `GAP` — NEW `transcription-send-interleave.spec.ts`.
- [ ] **D-txsend-3 — Finalize-into-composer then send that transcript.** Steps: transcribe, exit (transcript in composer), send it. Expect: exactly one message with the transcript attachment. Covers: `GAP` — NEW `transcription-send-interleave.spec.ts`.

## D.3 USER SCENARIO: turning voice on and off multiple times in a row (toggle storms)

- [ ] **D-vstorm-1 — 15× mic on/off.** Steps: tap mic on/off 15× fast. Expect: final state matches last tap; `startCapture` bails if `captureRef` already set (no double-capture); no stuck `recording`; analyser cleaned up. Covers: `GAP` — NEW `voice-toggle-storm.spec.ts`.
- [ ] **D-vstorm-2 — Hands-free engage/disengage storm.** Steps: toggle continuous mode rapidly. Expect: one capture at most; loop does not spawn duplicates. Covers: `GAP` — NEW `voice-toggle-storm.spec.ts`.
- [ ] **D-vstorm-3 — PTT press/release storm.** Steps: rapid press-release-press. Expect: each press-release = one turn boundary; no orphaned holding state (`pttHolding` stuck). Covers: `GAP` — NEW `voice-toggle-storm.spec.ts`.

## D.4 USER SCENARIO: smashing all the buttons (rapid chaotic taps on every control)

- [ ] **D-smash-1 — Chaotic multi-control mash.** Steps: rapidly tap mic, transcribe, send, stop, new-chat, swipe in random order for ~15s. Expect: app never enters an inconsistent state; no stuck spinner (conversation-loading watchdog `CONVERSATION_LOADING_MAX_MS` clears it); no stuck recording/sending; console has zero page-diagnostics errors (`expectNoPageDiagnostics`). Covers: `GAP` — NEW `voice-chaos-monkey.spec.ts`.
- [ ] **D-smash-2 — Send-spam single-flight.** Steps: mash send 10× on one draft. Expect: single-flight drain (`flushQueuedChatSends` guarded by `chatSendBusyRef`) sends the draft once; no duplicate turns. Covers: `GAP` — NEW `voice-chaos-monkey.spec.ts`.
- [ ] **D-smash-3 — Stop-spam mid-stream.** Steps: mash stop during a reply. Expect: idempotent abort, no crash. Covers: `GAP` — NEW `voice-chaos-monkey.spec.ts`.

## D.5 USER SCENARIO: swiping the chat (conversation swipe) mid-voice / mid-transcription

- [ ] **D-swipe-1 — Swipe to adjacent conversation while hands-free.** Steps: hands-free on, swipe (`selectAdjacentConversation`). Expect: switch behind loading flag; voice loop points at the switched conversation after settle; no turn misrouted to the old convo. Covers: `chat-clear-swipe.spec.ts` (swipe model) + `GAP` for voice-active swipe.
- [ ] **D-swipe-2 — Swipe mid-transcription.** Steps: transcribing, swipe conversations. Expect: transcript session survives or finalizes cleanly into the correct conversation; no cross-conversation transcript bleed. Covers: `GAP` — NEW `transcription-swipe.spec.ts`.
- [ ] **D-swipe-3 — Swipe with an in-flight voice turn (THE RACE, #10700).** Steps: commit a voice turn (enqueued), immediately swipe/new-chat before drain. Expect: the voice turn lands in the conversation it was SPOKEN into, NOT the newly-selected one. This is the unprotected shell `send()` surface (late `activeConversationIdRef` binding). Covers: `chat-clear-swipe.spec.ts` model → NEW `voice-send-race.spec.ts`.
- [ ] **D-swipe-4 — Swipe spinner never hangs.** Steps: swipe to an uncached conversation on a model-bound agent. Expect: spinner shows, then watchdog force-clears within `CONVERSATION_LOADING_MAX_MS` (12s); conversation usable. Covers: `conversation-management.spec.ts` + `GAP` for watchdog assert.

## D.6 USER SCENARIO: opening / switching VIEWS while chatting AND while transcribing

- [ ] **D-view-1 — Switch views while a reply streams.** Steps: send, switch to another view (e.g. models/tasks) mid-stream, return. Expect: stream continues/completes; message not lost; returning shows the completed reply. Covers: `GAP` — NEW `voice-view-switch.spec.ts`.
- [ ] **D-view-2 — Switch views while hands-free.** Steps: hands-free on, switch views. Expect: mic state survives per product intent (or cleanly pauses); no stuck capture; return restores expected state. Covers: `GAP` — NEW `voice-view-switch.spec.ts`.
- [ ] **D-view-3 — Switch views WHILE transcribing.** Steps: transcribing, open a different view, come back. Expect: transcript session continues recording (or is preserved); no lost segments; badge state consistent on return. Covers: `GAP` — NEW `voice-view-switch.spec.ts`.
- [ ] **D-view-4 — View switch mid-voice-turn does not misroute.** Steps: commit voice turn, switch view before drain. Expect: turn lands in the correct conversation (same #10700 late-binding surface). Covers: `GAP` — NEW `voice-send-race.spec.ts`.

## D.7 USER SCENARIO: new-chat mid-send (#10700 core)

- [ ] **D-newchat-1 — New chat between voice enqueue and drain.** Steps: commit a voice turn, tap new-chat (`clearConversation`) before the queue drains. Expect: the voice turn is delivered to its ORIGINAL conversation; the new chat is empty + greeted; `lastTurnVoice` reset false so the greeting is not spoken. Covers: `chat-clear-swipe.spec.ts` model → NEW `voice-send-race.spec.ts`.
- [ ] **D-newchat-2 — Cold-open double-send creates exactly ONE conversation.** Steps: from cold open (no active conversation), fire two sends near-simultaneously (voice + suggestion). Expect: exactly ONE conversation created (single-flight `createConversation`), both turns land in it. Covers: `GAP` — NEW `voice-send-race.spec.ts`.
- [ ] **D-newchat-3 — Suggestion-chip send is on the unprotected surface.** Steps: tap a suggested prompt, new-chat before drain. Expect: same race semantics as voice (shell `send()` path, not `handleChatSend`). Verify chip send routes correctly. Covers: `GAP` — NEW `voice-send-race.spec.ts`.
- [ ] **D-newchat-4 — Typed send is NOT exposed to the race.** Steps: type+send (`handleChatSend`), new-chat before drain. Expect: turn lands in the ORIGINAL conversation (conversationId snapshotted at enqueue). Confirms the asymmetry. Covers: `chat-clear-swipe.spec.ts`.

## D.8 USER SCENARIO: iterate back and forth like a real user

- [ ] **D-iter-1 — Full realistic session loop.** Steps: hands-free → speak → agent replies (TTS) → type a correction → swipe to old convo → speak there → transcribe a note → exit transcription → send the note → new chat → speak again. Expect: every turn in the correct conversation, correct spoken-ness, no dup/lost, clean final state. Covers: `full-walkthrough.spec.ts` (25-step model) → EXTEND with voice legs.
- [ ] **D-iter-2 — Speak → transcribe → speak (mode hop).** Steps: hands-free converse, enter transcription (reply loop pauses), transcribe, exit (reply loop resumes), converse again. Expect: reply loop correctly pauses/resumes; no dropped voice turns at the boundaries. Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.
- [ ] **D-iter-3 — Voice → text → swipe → voice, all one thread until swipe.** Steps: as named. Expect: pre-swipe turns in convo A, post-swipe voice in convo B; nothing bleeds. Covers: `GAP` — NEW `voice-send-race.spec.ts`.

## D.9 Concurrency & ordering guarantees

- [ ] **D-conc-1 — Two voice turns committed back-to-back.** Steps: two quick utterances before the first drains. Expect: FIFO order preserved in the single conversation; single-flight drain, no interleave corruption. Covers: `GAP` — NEW `voice-send-race.spec.ts`.
- [ ] **D-conc-2 — Voice turn during cloud handoff freeze.** Steps: commit a voice turn while `CLOUD_HANDOFF_PHASE_EVENT: migrating` is active. Expect: turn HELD (queue frozen, composer shows accepted, `chatSending` on), drained to the DEDICATED container after `switched`, delivered exactly once. Covers: `GAP` — NEW `voice-send-race.spec.ts`.
- [ ] **D-conc-3 — Handoff timeout/failure keeps turn on shared agent.** Steps: commit voice turn, handoff `timed-out`/`failed`. Expect: turn drains to the still-working shared agent exactly once. Covers: `GAP` — NEW `voice-send-race.spec.ts`.
- [ ] **D-conc-4 — Slash/prefixed command via voice-transcribed text.** Steps: dictate text that becomes a `/command`. Expect: `tryHandlePrefixedChatCommand` handles it, no server turn sent, local command turn appended. Covers: `GAP` — NEW `voice-text-interleave.spec.ts`.

---

# SECTION E — Cross-cutting invariants (assert on EVERY section-B/C/D item)

- [ ] **E-1 — No lost message.** Every enqueued turn appears exactly once in a conversation. Covers: `chat-clear-swipe.spec.ts`, `conversation-management.spec.ts`.
- [ ] **E-2 — No duplicate message.** Single-flight drain never double-sends. Covers: `GAP` — NEW `voice-send-race.spec.ts`.
- [ ] **E-3 — No misrouted message.** A turn never lands in a conversation other than the one it was created against (#10700). Covers: `chat-clear-swipe.spec.ts` → NEW `voice-send-race.spec.ts`.
- [ ] **E-4 — No stuck recording.** After any storm/mash, `recording=false` and `captureRef=null` when the UI shows idle. Covers: `GAP` — NEW `voice-toggle-storm.spec.ts`.
- [ ] **E-5 — No stuck sending.** After drain, `chatSending=false`, `chatSendBusyRef=false`. Covers: `GAP` — NEW `voice-chaos-monkey.spec.ts`.
- [ ] **E-6 — No stuck spinner.** Conversation-loading always clears (resolve or watchdog ≤12s). Covers: `conversation-management.spec.ts` + `GAP` for watchdog.
- [ ] **E-7 — Clean state reset on new chat.** `clearConversation` resets draft, `lastTurnVoice=false`, empty greeted conversation, prior non-empty convo still swipe-reachable. Covers: `chat-clear-swipe.spec.ts`.
- [ ] **E-8 — Analyser lifecycle clean.** `setAnalyser(null)` on every capture end (stop/dispose/error). No leaked AudioContext. Covers: `GAP` — NEW `voice-toggle-storm.spec.ts`.
- [ ] **E-9 — No hands-free resume-flag leak.** `resumeHandsFreeAfterTranscriptRef` never left `true` after a mic-master-off. Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.
- [ ] **E-10 — Zero page diagnostics.** `expectNoPageDiagnostics` passes (no uncaught errors/console.error) through the whole session. Covers: helper in `test/ui-smoke/helpers.ts` (all specs).
- [ ] **E-11 — Echo never self-answers.** Agent TTS echoed back never produces a reply, across all acoustic sections. Covers: NEW `voice-echo-rejection.spec.ts`.
- [ ] **E-12 — Server gate is authority.** For every "should not reply" case, confirm `core.voice_turn_signal` was the decider (not just the client pre-filter). Covers: `voice-workbench-respond-no-respond.spec.ts`.
- [ ] **E-13 — Optimistic user bubble on every send.** Each send renders the user bubble + typing indicator immediately, even while the agent warms (server holds the turn). No invisible queueing. Covers: `full-walkthrough.spec.ts` + `GAP` for warming-hold assert.
- [ ] **E-14 — Empty assistant bubble pruned.** A never-filled assistant placeholder (empty `text`, matching `assistantMsgId`) is removed, not left as a blank bubble. Covers: `GAP` — NEW `voice-chaos-monkey.spec.ts`.
- [ ] **E-15 — Draft cleared before debounce on send.** After send, `clearChatDraft(activeConversationId)` fires before the debounce window so a background-app pause cannot snapshot the empty-then-restored draft. Covers: `GAP` — NEW `voice-text-interleave.spec.ts`.
- [ ] **E-16 — `voiceSource` recorded on voice turns.** Every VOICE_DM turn carries `metadata.voiceSource` (the backend that produced it). Covers: `GAP` — NEW `voice-send-race.spec.ts`.
- [ ] **E-17 — No AudioContext leak across a full session.** Enter/exit voice + transcription ≥10× and confirm AudioContext count returns to baseline. Covers: `GAP` — NEW `voice-toggle-storm.spec.ts`.
- [ ] **E-18 — Transcript never routed to the server as a reply-eligible turn.** Confirm transcribed finals never carry a `voiceTurnSignal` that would trigger a reply. Covers: `GAP` — NEW `transcription-lifecycle.spec.ts`.

---

# SECTION F — Per-platform notes

Run the whole matrix (A–E) on each platform. Rebuild + redeploy before every capture (a stale install proves nothing).

## F.1 macOS desktop (Electrobun — `Eliza-dev.app` = prod build)

- [ ] **F-mac-1 — Real mic capture path.** Native mic through the desktop shell; not mocked-bridge Chromium. Evidence: `GET /api/dev/cursor-screenshot`.
- [ ] **F-mac-2 — Audio unlock on first voice.** `voiceOutput.unlockAudio()` succeeds; TTS plays. Covers: `voice-desktop-selftest.spec.ts`.
- [ ] **F-mac-3 — Echo rejection with real speakers→mic loop.** Play TTS through speakers, capture via real mic. Expect: no self-answer. Covers: `GAP` (hardware) → manual.
- [ ] **F-mac-4 — Toggle/transcription storms on native.** Same as D.3/C.5 on desktop. Covers: `GAP` → manual + NEW specs re-run under desktop project.

## F.2 Web (Chromium — `chromium` / `chromium-voice-mic` / `mobile-chromium`)

- [ ] **F-web-1 — Fake-audio WAV capture works.** `--use-file-for-fake-audio-capture` drives real transcription. Covers: `voice-realaudio.spec.ts`, `transcript-realaudio.spec.ts`.
- [ ] **F-web-2 — shimmed webkitSpeechRecognition + SSE + `/api/tts/cloud`.** Covers: `tts-stt-e2e.spec.ts`.
- [ ] **F-web-3 — Mobile-chromium (Pixel 7) composer + keyboard.** Send keeps keyboard up (A-send-6). Covers: NEW `voice-button-matrix.spec.ts` (mobile-chromium).
- [ ] **F-web-4 — Mic permission prompt / denied (A-mic-8).** Covers: NEW `voice-permission-denied.spec.ts`.

## F.3 iOS simulator

- [ ] **F-ios-sim-1 — Rebuild + cap sync + reinstall before capture.** Renderer change is baked into the IPA; restarting the old app does NOT pick it up. Confirm `versionName`/on-screen marker. Evidence: `capture:ios-sim`.
- [ ] **F-ios-sim-2 — Mic permission dialog (Capacitor).** Grant/deny paths. Covers: `GAP` → manual.
- [ ] **F-ios-sim-3 — Voice capture + transcription lifecycle on sim.** Covers: `GAP` → manual re-run of C/D.
- [ ] **F-ios-sim-4 — View-switch while transcribing (native nav).** Covers: `GAP` → manual (D.6).

## F.4 Real iOS device

- [ ] **F-ios-dev-1 — Real-mic acoustic matrix (B.1–B.5).** Loud→quiet, multi-speaker, room babble, people entering/leaving, agent-TTS echo — all with the physical mic/speaker in a real room. This is the definitive echo-rejection test (real acoustic loopback). Covers: `GAP` → manual, recorded walkthrough + audio.
- [ ] **F-ios-dev-2 — Background/foreground during voice.** Backgrounding mid-utterance/mid-transcription; return. Expect: no stuck capture, no lost transcript. Covers: `GAP` → manual.
- [ ] **F-ios-dev-3 — Bluetooth/AirPods route change mid-session.** Expect: capture survives or fails gracefully, no self-answer via route echo. Covers: `GAP` → manual.
- [ ] **F-ios-dev-4 — Full realistic loop (D.8) on device, narrated + recorded.** Covers: `GAP` → manual, video + audio + logs.

---

# NEW automated specs to add (model each on `chat-clear-swipe.spec.ts`'s stateful in-spec conversation store, desktop + Pixel-7 lanes; use `seedAppStorage`, `installDefaultAppRoutes`, `installPageDiagnosticsGuard`, `expectNoPageDiagnostics`)

1. `voice-button-matrix.spec.ts` — A.1–A.6 label/active/aria/disabled/morph across states.
2. `voice-permission-denied.spec.ts` — A-mic-8, F-web-4.
3. `voice-realaudio-dynamics.spec.ts` — B.1 loud↔quiet dynamic-gain WAV.
4. `voice-realaudio-babble.spec.ts` — B.3 room babble / low SNR.
5. `voice-realaudio-transient-speaker.spec.ts` — B.4 enter/talk/leave.
6. `voice-echo-rejection.spec.ts` — B.5 agent-TTS echo + barge-in.
7. `voice-carryover.spec.ts` — B.7 carryover vs explicit-stop discard.
8. `transcription-lifecycle.spec.ts` — C start/stop paths, drop-into-composer, re-listen, wake-fold.
9. `transcription-storm.spec.ts` — C.5 on/off storms.
10. `transcription-swipe.spec.ts` — D.5 swipe mid-transcription.
11. `transcription-send-interleave.spec.ts` — D.2 transcribe on/off while sending.
12. `voice-text-interleave.spec.ts` — D.1 interleaved text + voice.
13. `voice-toggle-storm.spec.ts` — D.3 voice on/off storms + E-4/E-8.
14. `voice-chaos-monkey.spec.ts` — D.4 button-smashing + E-5.
15. `voice-send-race.spec.ts` — D.5/D.7 #10700 misroute + cold-open dedupe (E-2/E-3).
16. `voice-view-switch.spec.ts` — D.6 view switching while chatting/transcribing.

---

## Sign-off

- [ ] Every A/B/C/D/E/F row is PASS or has a written N-A reason.
- [ ] Every user-demanded scenario (loud→quiet, multi-speaker, room babble, enter/leave, transcription, button-smashing, all button states, toggle storms, text-while-voice, transcribe on/off while sending, swipe mid-voice, iterate back-and-forth, view-switch while chatting/transcribing, agent-TTS echo rejection) has at least one PASS row.
- [ ] Every GAP has a NEW spec landed OR a written waiver.
- [ ] Real-LLM trajectory, backend+frontend logs, before/after screenshots (desktop+mobile), and a narrated video walkthrough attached under `.github/issue-evidence/10726-voice-delarp/` per `PR_EVIDENCE.md`.
