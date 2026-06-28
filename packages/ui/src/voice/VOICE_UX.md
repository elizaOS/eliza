# Voice & Voice-Chat UX — current state and the ideal

This document is the design source-of-truth for the voice surface: the
microphone modes, the "hey eliza" wake word, and transcript mode (both the
button and the agent-driven action). It describes what exists today, the ideal
experience we are building toward, and the seams that make it testable.

## 1. The three pillars

The voice surface is organized around three independent capabilities that
compose, not three mutually-exclusive modes:

1. **Always-on mic ("just talk").** The regular microphone mode is, by design,
   *continuous*: once engaged it stays open, listens turn-by-turn, and lets the
   agent decide when a turn ends. The user does not press-to-talk for every
   utterance. This is `VoiceContinuousMode = "always-on"` driven by the
   hands-free loop in `useShellController`.

2. **Wake word ("hey eliza").** When the mic is *not* already open, saying
   "hey eliza" arms a bounded **listening window**: voice is enabled for a
   period of time, the user speaks their request, and the window closes once the
   agent has responded (or after a short idle timeout if nothing was said). This
   is the hands-free experience without leaving the mic on forever.

3. **Transcript mode ("just record").** A long-form, reply-suppressed capture:
   every utterance is folded into one growing transcript record instead of
   producing chat turns. It is reachable two ways — a **button next to the mic**,
   and an **agent action** (`START_TRANSCRIPTION` / `STOP_TRANSCRIPTION`) so the
   agent can drop into transcript mode while a live mic session is running
   ("ok, I'll just take notes — keep talking").

These three are layered, not exclusive: wake word is the *entry ramp* into a
listening turn; always-on is *staying* in listening; transcript mode is a
*different consumer* of the same capture stream.

## 2. Current state (what exists)

### Capture / mic

- `useShellController` owns capture intent (`converse` | `dictate` |
  `transcription`), the hands-free (always-on) re-listen loop, push-to-talk
  dictation, and the transcription re-listen loop.
- `useContinuousChat` exposes the three continuous modes
  (`off` | `vad-gated` | `always-on`) and aggregates status.
- `ChatComposer` renders the mic button (180ms hold → push-to-talk, tap →
  compose/toggle). `ContinuousChatOverlay` is the live-mic surface and renders
  the mic button **with the transcript toggle next to it**.

### Wake word

- Native detection exists: the **Swabble** native plugin
  (`getSwabblePlugin()`), backed by openWakeWord (GGUF, default trigger
  `eliza`), configured in `VoiceConfigView`'s `WakeWordSection` (triggers,
  `minPostTriggerGap`, model size, live audio-level meter).
- The agent-side `wake-word.ts` / `voice-entity-binding.ts` track "a wake word
  fired within the recent listen window" for *speaker attribution* (owner and
  enrolled contacts answer without a wake word).

### Transcript mode

- `toggleTranscriptionMode()` / `stopTranscriptionAndMic()` in
  `useShellController`. The mic and transcript are linked-but-distinct: the
  **transcript button** turns transcript off but *leaves the mic on*; the **mic
  button** turns the mic (and thus transcript) fully off.
- Agent action path: `START/STOP_TRANSCRIPTION` → agent-event bus →
  `VOICE_CONTROL_EVENT` window event → `useShellController` flips transcription
  to match (idempotent).

## 3. The gap

The wake word is **detected but the loop is never closed in the UI.** The
Swabble plugin only surfaces an `audioLevel` event; nothing listens for an
actual *wake firing* to **open the mic for a window and close it once the agent
responds.** So "hey eliza enables voice for a period of time until the agent
responds" — pillar 2 — has all its parts (native detector, settings, config)
except the orchestration seam that turns a detection into a listening turn.

This document's accompanying change adds that seam:

- A `wakeWord` event on `SwabblePluginLike` (the native detection signal).
- A **pure** `wake-listen-window` state machine: wake → `open` (mic on) →
  `awaiting-response` (user spoke) → `idle` (agent responded), with an idle
  timeout (no speech) and a hard safety cap. Re-arming on a second wake refreshes
  the window.
- A `useWakeListenWindow` hook that subscribes to the wake event, ticks the
  machine, and drives the existing hands-free mic on/off — **without** clobbering
  a user who has already chosen always-on (for them, wake is a no-op).

## 4. Ideal UX — the trajectories

1. **Cold wake.** Mic idle. User: "hey eliza, what's the weather?" → wake fires
   → mic opens, status pill shows *listening* → user finishes → *thinking* →
   agent speaks the answer → window closes, mic returns to idle. One sentence,
   no buttons.

2. **Wake then silence.** "hey eliza" → mic opens → user says nothing → after
   the idle timeout the window closes silently. No dangling open mic.

3. **Always-on, wake is inert.** User has toggled always-on. Saying "hey eliza"
   does not toggle anything off — the mic is already open and stays open. Wake is
   only an *entry ramp*, never an exit.

4. **Transcript via button.** In the live overlay, user taps the transcript
   button next to the mic → replies suppressed, utterances accumulate → taps it
   again → transcript saved, **mic stays on**.

5. **Transcript via agent.** Mid-conversation the agent decides to take notes
   and emits `START_TRANSCRIPTION`; the UI drops into transcript mode while the
   live mic keeps running; `STOP_TRANSCRIPTION` (or the user) ends it and the
   session becomes a Transcript record.

## 5. Why a pure state machine

The wake window's correctness (open on wake, close on response, time out on
silence, re-arm on re-wake, never fight always-on) is pure logic over a few
observable signals. Keeping it in `wake-listen-window.ts` as a reducer makes
every transition unit-testable with a frozen clock, with the React hook reduced
to a thin adapter — the same shape the rest of the voice layer already uses
(`end-of-turn.ts`, `transcript-session.ts`, `should-respond.ts`).
