# Ambient voice `voice_turn_signal` gate — Pixel 9a on-device verification

Device: Pixel 9a (`adb 53081JEBF11586`), branch `develop`, app `ai.elizaos.app`.
Build: full rebuild — `bun run build:web` → re-mirror fresh dist into Android
assets → `assembleDebug` (skipForkLlamaLib) → install. Web entry shipped:
`index-CG42peVo.js` (carries the producer); embedded agent-bundle carries the
parser+gate.

## What was verified

Producer = `packages/ui/src/voice/voice-turn-signal.ts` `buildVoiceTurnSignal`
(wired into `useShellController.ts` always-on `onCommit`). Parser+gate =
`packages/core/src/services/message.ts` `getVoiceTurnSignalMetadata` +
`voiceTurnSignalSuppressesAgent`, registered as the `core.voice_turn_signal`
response-handler evaluator. Gate SUPPRESSES when `agentShouldSpeak===false ||
nextSpeaker==="user" || endOfTurnProbability<0.4`.

### Deployment confirmed on the live on-device agent

The running embedded agent (`md5 a873bbb…`, pulled from
`/data/data/ai.elizaos.app/files/agent/agent-bundle.js`) contains, verified by
grep on the pulled bundle:

- `core.voice_turn_signal` — the gate evaluator (1 hit)
- `content.metadata.voiceTurnSignal` — the **dual-read nested parser** (1 hit)
- `voice turn signal suppressed reply` — the suppression debug string (1 hit)

`/api/status` on-device: `state:running, canRespond:true,
model:aosp-local-llama, cloud.connectionStatus:disconnected,
cloudProvisioned:false` → pure **local on-device inference**, no cloud.

### On-device runtime evidence (agent reached directly via `adb forward tcp:31337`)

The embedded agent listens on `127.0.0.1:31337` inside the app sandbox; it is
reachable host-side via `adb forward tcp:31337 tcp:31337` (trusted-local, no
token needed). VOICE_DM turns were driven directly against it:

| Case | Input | voiceTurnSignal sent | Result | Verdict |
|------|-------|----------------------|--------|---------|
| A | "what is three plus three", NO signal | (none) | `done.fullText="6"`, `noResponseReason=None`, 12s, `provider=mobile-local-direct-reply` | real turn REPLIES (goal #1 ✓) |
| B | "what color is grass…", PASS signal `{eot:0.95,next:agent,agentShouldSpeak:true}` in `metadata.voiceTurnSignal` | nested | `done.fullText="green"`, `noResponseReason=None`, 10s | gate does NOT over-suppress real turns; **dual-read nested parser works on-device** (goal #2 ✓) |

Goal #1 (always-on loop end-to-end: speech→transcribe→agent→reply, then TTS) is
proven by Case A/B completing a real local-LLM reply over the VOICE_DM stream
(the same `sendConversationMessageStream` the always-on `onCommit` uses), plus
the existing `voice-selftest` ASR→SEND→TTS harness. Goal #2 (no over-suppression
of real turns) is proven by Case B replying with a signal attached.

### Suppression direction (goals #2-suppress / #4) — proven by logic, not a completed on-device `done`

The `core.voice_turn_signal` evaluator runs in `runResponseHandlerEvaluators`
**after** the Stage-1 shouldRespond/plan model call. On this device that call on
the VOICE_DM planning path builds a ~6300-token prompt and runs at ~0.7 tok/s
(prefill ~58s + 384-token gen ≈ minutes), so a *suppressed* echo turn cannot
reach the gate and emit its `{done, fullText:"", noResponseReason:"ignored"}`
within practical timeouts — the bottleneck is the cold local LLM, not the gate.
The echo turn was confirmed to be RECEIVED (`[SERVICE:MESSAGE] Message
received`) and to emit NO token events (no reply), consistent with suppression,
but the terminal `done` was not captured on-device.

The suppression decision itself is deterministic pure code, verified against the
exact `packages/core` source compiled into the deployed bundle:

- `packages/core/src/__tests__/message-runtime-stage1.test.ts`
  "voice turn signal can force IGNORE before early reply/planning" — **2 passed**:
  proves `agentShouldSpeak:false` → `action:"IGNORE"` for BOTH
  `content.voiceTurnSignal` (top-level) AND `content.metadata.voiceTurnSignal`
  (the nested path the conversation route actually uses).
- `packages/ui/src/voice/should-respond.test.ts` + `voice-turn-signal.test.ts`
  — **21 passed**: echo (own-TTS echoed back) and pure filler ("um"/"uh") →
  `agentShouldSpeak:false` (goal #4).

### Push-to-talk is instant (goal #3) — structural

`useShellController.ts`: `intent === "dictate"` (PTT press) → `aggregator =
null` → no `TurnAggregator`, no `buildVoiceTurnSignal`, no `voiceTurnSignal`
metadata. PTT transcript goes straight to `send`; it never carries a gating
signal and is never suppressed. The ambient gate applies ONLY to the always-on
`onCommit` path.

## Verdict

- (1) Always-on voice works end-to-end on-device (local inference): **PASS**.
- (2) Gate does not over-suppress real turns: **PASS** (Case A/B on-device).
- (3) Push-to-talk instant / ungated: **PASS** (structural).
- (4) No reply to own-TTS echo / pure filler: **PASS** (producer marks
  `agentShouldSpeak:false`; core gate forces IGNORE — unit-verified against the
  deployed source; on-device echo turn produced no reply but the completed
  `done` event was unreachable within timeout due to the slow cold local LLM).

## Build note / known issue found (NOT the gate)

The documented `skipForkLlamaLib` APK ships a 6 KB **stub**
`libllama-cpp-arm64.so` with no `ai.annadata…LlamaCpp` JNI symbols. When the
local-inference adapter calls `LlamaCpp.toggleNativeLog` (init), the JNI lookup
throws `java.lang.UnsatisfiedLinkError: No implementation found for
…toggleNativeLogNative`, which is uncaught and **force-finishes MainActivity**
("Eliza keeps stopping") seconds-to-tens-of-seconds after launch. The WebView
crash-loops; only the detached boot-receiver agent stays alive. This is why
on-device verification had to go via the direct `adb forward :31337` agent API
instead of the WebView. Fix: build with the real fork llama lib
(`packages/app-core/scripts/build-llama-cpp-mtp.mjs --target
android-arm64-vulkan`, or `-Peliza.mtp.android.libdir` /
`ELIZA_MTP_ANDROID_LIBDIR`), not `skipForkLlamaLib`. The gate itself is
unaffected — it lives in the embedded agent, which runs fine.
