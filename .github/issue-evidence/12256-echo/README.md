# #12256 — Echo: TTS-reference AEC on the desktop loop + production self-voice imprint + ERLE telemetry

Part of #12187. Layered echo defense in the settled order (parent decision #7):
**cooldown gate → NLMS-with-reference on the desktop loop → embedding self-voice**,
gated by measured ERLE before considering AEC3 (escalation only — not vendored here).

## Artifacts

| File | What it is |
| --- | --- |
| `echo-aec-evidence.json` | Real NLMS + desktop `FarEndReference` + MFCC self-voice imprint over the deterministic synthetic echo corpus. Regenerate: `bun run --cwd plugins/plugin-local-inference scripts/echo-aec-evidence.ts` |
| `workbench-logic-report.json` | `voice:workbench --logic` full report (24 scenarios, `overall: pass`, no regressions vs the #12258 baseline). Includes `desktop-aec-echo` (10 cases, pass) and `speaker-gated-barge-in` (14 cases, pass). |
| `real-lane-hardfail.txt` | Proof the `--real` lane hard-fails (exit 1) without staged GGUFs — no false pass. |

## ERLE numbers vs the #12258 ceiling (`minErleDb` 18)

Real `NlmsEchoCanceller` (256 taps, µ 0.3, double-talk freeze) over the agent's
own synthetic TTS as the far-end reference, plus far-field attenuation + early
reflections within the filter span:

| Condition | delay | far-field | reflections | ERLE (far-active) | vs 18 dB |
| --- | --- | --- | --- | --- | --- |
| clean-echo | 20 ms | 6 dB | 0 | **31.71 dB** | PASS |
| early-reflections | 45 ms | 9 dB | 2 | **29.25 dB** | PASS |
| long-transport | 380 ms | 9 dB | 1 | **30.05 dB** | PASS |

Desktop `FarEndReference` end-to-end (whole-utterance cross-correlation align +
warm-pass cancel of a WAV, timestamped renderer playback frames delivered as the
pump does, history surviving a `reset`): **applied, ERLE 33.67 dB, alignment
confidence 0.954, offset 14880 samples** — clears 18 dB with headroom, matching
the ~29 dB synthetic target.

**Before:** the desktop ASR ingest (`/api/asr/local-inference`) had NO AEC
(grep `echo|aec` → empty); the agent transcribed its own playback. **After:**
every WAV utterance is echo-cancelled before transcription when a correlated
far-end reference exists (bit-exact passthrough otherwise).

## Self-voice rejection (layer 3)

`AgentSelfVoiceImprint` centroid over 8 agent utterances, then probed:

- **Agent echoes:** self-similarity mean **1.0** → all rejected.
- **Human turns (4 scenario participants):** mean **0.091** (max 0.573) → all passed.

Threshold note: the imprint's production default is **0.28** for the fused
WeSpeaker embedding (self ~0.37 vs human ~0.15, `research/VOICE_8785_ASSESSMENT.md`
§6 — **NOT** the 0.78/0.7 human bars). The fused WeSpeaker GGUF is unstaged in
this worktree, so the corpus evidence uses the deterministic **MFCC-timbre-13d**
proxy encoder, whose honest operating point is the workbench's 0.7 bar; the
imprint's `selfVoiceThreshold` travels with the measurement source precisely so
each encoder is gated on its own scale. The unit tests
(`self-voice-imprint.test.ts`) exercise the 0.28 WeSpeaker operating point
directly with controlled embeddings at the measured §6 margins.

## N/A with reason

- **Real-hardware ERLE** (`packages/benchmarks/voice/device-acoustic-erle.mjs`):
  N/A — no loaded acoustic host / device in this worktree. The synthetic ERLE
  (~30 dB) exceeds the 18 dB bar with margin; if measured device ERLE after the
  NLMS layer is <18 dB, the AEC3 / `webrtc-audio-processing` follow-up is the
  escalation path (not implemented here — the ERLE the dev route now surfaces is
  the gate for that decision).
- **Fused WeSpeaker embedding self-voice margin** (self ~0.37): N/A — the fused
  `libelizainference` speaker GGUF is not provisioned; the MFCC proxy stands in
  for the corpus run and the unit tests cover the 0.28 operating point.
- **Captured real STT→TTS round-trip audio / narrated walkthrough**: N/A — no
  audio device or fused Kokoro/ASR bundle in this worktree. The synthetic corpus
  drives the identical production DSP path end to end.

## Self-voice-gate handle contract for #12255 (speaker-gated barge-in)

Mirrors #12257's `getSharedVoiceProfileStore()` handle. #12255 calls
`getAgentSelfVoiceImprint()` (no args) from `services/voice/self-voice-imprint.ts`
to get the live production imprint the voice pipeline registered, then gates
barge-in with `await imprint.isAgentSelfVoice(embedding)`:

- returns `true` → the turn is the agent's own echo; do **not** hard-stop TTS.
- returns `false` → a real speaker; barge-in may proceed.
- returns `null` → no centroid yet (agent hasn't spoken enough); **fail open**
  (treat as not-self), never as self-voice.

The speak-back loop's imprint (`engine-bridge`, registered `"speak-back-loop"`)
takes precedence over Pipeline A's (`"live-frames"`). #12255 never constructs
its own imprint or re-derives the threshold — `imprint.threshold` is the
agent-specific bar, and the raw similarity + that threshold flow into the
respond-gate via `selfVoiceThreshold` so the fold compares on the right scale.

## Telemetry (layer 4)

`GET /api/dev/voice-latency` now carries an `aec` block
(`echoReferenceWired`, playback delivery counters, per-utterance ERLE ring);
`GET /api/voice/aec-capture` returns the measured ERLE by replaying the armed
near/far window through the real canceller (`replayAecCaptureErle`).
