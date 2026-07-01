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

## 6. Name-aware detection — the unified `WakeController`

The wake phrase follows the **character name** ("hey eliza" → rename to *Ada* →
"hey ada", zero config). But the battery-efficient openWakeWord detector is a
*per-phrase trained head*, not zero-shot, so an arbitrary renamed name cannot be
detected by the head alone. `wake-controller.ts` resolves this with a **two-stage
name-aware wake** and picks the cheapest correct path for the platform:

| Path | When it is selected | Cost / latency | Name support |
|---|---|---|---|
| **head fast-path** | a trained openWakeWord head exists for the current name (shipped `hey-eliza`, or an auto-trained head) | lowest — pure fused detector, no ASR | exact phrase only |
| **two-stage ASR** | a generic always-on detector (openWakeWord generic / native VAD) is available + a short-window ASR can confirm | idle cost stays at Stage-A levels; ASR runs only on a candidate | zero-shot, follows renames |
| **Swabble fallback** | the fused FFI is unavailable (e.g. some browsers) | continuous OS ASR — not battery-friendly, fallback only | zero-shot (Swabble already name-aware) |

**Stage A (always-on, cheap):** the only thing burning power at idle — the fused
openWakeWord generic detector (or native VAD) at **~0.23 ms / 80 ms frame on
native CPU**, accelerated via `libelizainference` (Metal/Vulkan/CUDA/CPU).

**Stage B (confirmation, on candidate):** when Stage A raises a candidate, a short
ASR window opens and the transcript is fuzzy-matched against the live character
name (`wake-name-match.ts`: Levenshtein-tolerant for ASR slop + homophones). This
buys zero-shot, rename-following name support while keeping idle power at Stage-A
levels. The window self-cancels after `confirmWindowMs` (default 2500 ms) so a
candidate can never get stuck.

**Head fast-path:** if a trained head exists for the current name, Stage B is
skipped entirely — pure openWakeWord, lowest latency. The shipped `hey-eliza`
head holds **~98.8 % true-accept / ~3.6 % false-accept** on a 250+250 held-out
set; auto-training a head for a renamed character (via the TTS corpus pipeline in
`packages/training/scripts/wakeword/`) is a documented follow-up.

`selectWakePath()` encodes this priority; `wakeControllerReducer()` runs the
confirmation handshake. Both are pure + clock-injected (unit + fuzz tested in
`wake-controller.test.ts` / `wake-controller.fuzz.test.ts`). `useWakeController`
is the thin React adapter that owns the single native subscription, and
`useWakeListenWindow` consumes its confirmed detections to arm the mic window —
so every surface (mic window, Swabble triggers, transcript inline-reply) agrees
on what counts as "the wake word".

## 7. Cross-platform capability & battery matrix

What runs the always-on Stage-A detector on each target, and therefore which path
the controller selects:

The live verification surface for this table is
[`VOICE_LIVE_MATRIX.md`](./VOICE_LIVE_MATRIX.md). `bun run voice:matrix` emits
the reviewer-facing JSON/Markdown/HTML report and records skipped hardware cells
explicitly instead of treating Linux-only evidence as cross-platform coverage.

| Platform | Stage-A detector | Stage-B ASR confirm | Selected path | Always-on battery |
|---|---|---|---|---|
| **macOS** (desktop) | fused openWakeWord (CPU/Metal) | fused transcription / Whisper.cpp | head fast-path → two-stage | ✅ ~0.23 ms/frame |
| **iOS** | fused openWakeWord (CPU/ANE target) | `SFSpeechRecognizer` | head fast-path → two-stage | ✅ ANE/CPU, frame-cheap |
| **Android** | fused openWakeWord (CPU/NNAPI) | Android `SpeechRecognizer` | head fast-path → two-stage | ✅ frame-cheap |
| **Linux** (desktop) | fused openWakeWord (CPU/Vulkan/CUDA) | Whisper.cpp bridge | head fast-path → two-stage | ✅ frame-cheap |
| **Windows** (desktop) | fused openWakeWord (CPU/CUDA) | Whisper.cpp bridge | head fast-path → two-stage | ✅ frame-cheap |
| **Web / browser** | — (no fused FFI) | — | Swabble fallback (Web Speech) | ⚠️ continuous ASR — fallback only |

Both wake signals are now **bridged to the UI**: the Swabble `wakeWord` event
(Web-Speech fallback) and the fused on-device path via the
`subscribeFusedWake` bridge (`fused-wake-bridge.ts`). The native host signals the
fused runtime is live with `window.__ELIZA_FUSED_WAKE__ = true` and forwards each
fused stage (head-fire / Stage-A candidate / Stage-B transcript) as an
`eliza:fused-wake` event; `useWakeController` declares `openWakeWord` in its
default capabilities and routes those stages through the same reducer dispatch as
Swabble. The controller picks the *selected* (cheapest available) path and never
invents a subscription for a detector that is not actually present — emission, not
the capability flag, drives detection. The remaining native task is emitting
those stages from `wake-word-ggml.ts` on each platform; the UI contract is
complete and covered by `useWakeController.fused.test.tsx`.
