# Voice Workbench (#8785) — Capability Assessment & Evidence Map

This is the human/AI-reviewable map of the elizaOS voice-assistant capability: what exists, what this work added, what is **CI-proven** vs **hardware/credential-gated**, and the recommendations. Pair with [VOICE_PIPELINE_RESEARCH_2026.md](./VOICE_PIPELINE_RESEARCH_2026.md) (the evidence base) and [../VOICE_WORKBENCH.md](../VOICE_WORKBENCH.md) (how to run it).

Legend: **✅ PROVEN** = verified by a CI-runnable test/lane (no models, no network). **🟡 GATED** = real code exists but verification needs hardware/models/credentials. **🔵 DESIGN** = decision logic + tests exist; runtime wiring is a follow-up.

---

## 1. The pipeline already in place (recon findings)

elizaOS ships a deep, real voice pipeline in `plugins/plugin-local-inference/src/services/voice/` (~240 files). The honest baseline:

| Subsystem | Implementation | Status |
|---|---|---|
| VAD | Silero v5.1.2 GGML, 2-tier (RMS gate + model), 32 ms hop; configurable onset 0.5 / offset 0.35 / end-hangover 700 ms / pause-hangover 100 ms | 🟡 GATED (native FFI) |
| EOT | Heuristic (`@elizaos/shared/voice-eot`) + Eliza1 (`<im_end>` prob) + Composite + LiveKit GGUF; early-commit at P≥0.9, tentative at P≥0.6 | partial ✅ (heuristic) / 🟡 (model) |
| Barge-in | `BargeInController` + `voice-state-machine` (C1 checkpoint), 600 ms words-grace, AbortSignal hard-stop | 🟡 GATED |
| Optimistic gen | `optimistic-policy` (battery-aware) + `optimistic-rollback` (C7 prefill) | 🟡 GATED |
| Wake-word | openWakeWord GGML, 80 ms frames, "hey eliza" head (real head v0.3.0 published; placeholder pending bundle ship) | 🟡 GATED |
| Speaker encoder | WeSpeaker ResNet34-LM INT8, 256-dim, L2-norm, cosine, match threshold **0.78** | 🟡 GATED |
| Diarization | pyannote-segmentation-3.0 INT8, 5 s window, 7-class powerset | 🟡 GATED |
| Entity binding | `VOICE_TURN_OBSERVED` → merge engine → `VOICE_ENTITY_BOUND`; `IDENTIFY_SPEAKER` action; `speakerEntityId` on VOICE_DM | ✅ (event seam tested) |
| Echo/respond gate | word-overlap echo guard (9 s / 70 %) + disfluency filter + bystander suppression + wake-word override | ✅ PROVEN (now consolidated) |
| Owner enrollment | first-run voice routes (`/api/voice/first-run/*`) write the owner entity | 🟡 GATED |
| Routing | local/cloud STT+TTS; hybrid (local TTS + cloud STT on mobile) documented + unit-tested | ✅ (selection) / 🟡 (live) |

**Gaps this work closed:** the `--real` workbench lane was hollow (mock echoed ground truth → circular); there was no robustness corpus, no echo-rejection scorer/scenario, no owner-vs-intruder scenario, and no autonomous owner inference. Acoustic echo cancellation (AEC3-style) is **still MISSING** at the PCM level — see §6.

---

## 2. What this work added (all ✅ PROVEN, CI-runnable, no models)

1. **Robustness corpus DSP** (`corpus-augment.ts`, 19 tests): seeded, deterministic additive noise (white/pink at a target SNR), Freeverb reverb, far-field attenuation, telephone/low-quality line (band-limit + µ-law), background talkers. Wired into the corpus generator via a per-turn / per-scenario `environment`.
2. **Real-decision-logic lane** (`workbench-logic-services.ts`, `voice:workbench --logic`): runs the SHIPPED EOT heuristic + respond/echo/bystander/wake-word gate + name extraction over the corpus, instead of echoing ground truth. Genuinely suppresses a bystander, rejects the agent's echoed reply, and holds on a mid-utterance pause — asserted, not assumed.
3. **Single source of truth** for the respond/echo gate (`@elizaos/shared/voice/respond-gate`): the UI client re-exports it, so the workbench tests exactly what ships. (21 UI tests still green.)
4. **New scorers + report metrics**: echo-rejection rate, owner-vs-intruder accuracy, impostor-accept rate.
5. **Owner inference** (`@elizaos/shared/voice/owner-inference`, 6 tests): `resolveOwnerCandidate` proposes the owner from who speaks most/most-confidently — only when evidence is sufficient AND unambiguous, else UNDECIDED. The decision logic an owner-detection provider/evaluator runs when no owner is enrolled. 🔵 wired into the workbench; runtime provider wiring is the follow-up.
6. **New scenarios**: noisy-room, far-field-reverb, background-talkers, echo-self-trigger, owner-enrollment-inference, owner-vs-intruder.

Lanes: `--mock` PASS (plumbing), `--logic` PASS (real decision logic, 12 scenarios), `--real` SKIPPED (honesty contract).

---

## 3. #8785 acceptance criteria

| AC | Status | Evidence |
|---|---|---|
| VoiceScenario schema + labeled corpus (multi-voice, pauses, respond/no, multi-speaker, entity, voice→entity, diarization, EOT, transcription, multi-agent, long-form **+ robustness, echo, owner-security, overlapping**) | ✅ | `voice-scenario.ts`, `workbench-scenarios.ts` (12 scenarios) |
| All scoring in one shared module; no duplicate WER | ✅ | `e2e-harness.ts` + `@elizaos/shared/voice-wer`; respond/echo now also single-source |
| Headless runner over real services + scenario-runner `voice` turn kind | ✅ | `workbench-headless-runner.ts`, `packages/scenario-runner/src/voice-turn.ts` |
| Headful scenario player + per-turn DOM verdict + specs per class | ✅ (mocked) | `VoiceWorkbenchShell`, 10 `voice-workbench-*.spec.ts` |
| Single `voice:workbench` JSON+MD report with baselines | ✅ | `voice-workbench-report.ts`, `scripts/voice-workbench.ts` |
| CI: mocked always, real where provisioned, `skipped` (never `pass`) when absent | ✅ | `--mock`/`--logic` run+pass; `--real` skips |
| Multi-agent room ≥3 participants who-responds | ✅ | `multi-agent-room-address` |
| README documents the consolidation | ✅ | `VOICE_WORKBENCH.md` |

**#8785 is closeable for the workbench scope and for the decision-logic of local + cloud.** The remaining lane — real acoustic models on degraded audio (real WER/DER/EOT-latency, and the live cloud STT/TTS round-trip) — is wired and gated, see §5.

---

## 4. The user's expanded questions — answered

| Question | Answer | Status |
|---|---|---|
| Ideal pause lengths? | ~200 ms modal inter-turn gap; with a semantic EOT model use **200 ms** end-hangover, fixed-VAD **500 ms**, max-wait **3000 ms**. Pipeline ships 700 ms hangover with semantic early-commit at P≥0.9. | research §1; tune ticket |
| Optimistic-but-abortable generation? | `optimistic-policy` + `optimistic-rollback` (C1 checkpoint, C7 prefill, battery-aware) | 🟡 GATED, exists |
| Reject the agent's own voice from TTS? | Word-overlap echo gate (9 s/70 %) — now scored in the workbench (echo-rejection rate 1.0). **PCM-level AEC is still missing** — see §6. | ✅ (transcript) / ❌ (acoustic) |
| Reverb / low-quality / near-far / noise / background talkers? | `corpus-augment.ts` models all of them deterministically; scenarios assert the decision still holds | ✅ corpus; 🟡 real-model robustness |
| Interrupting / overlapping voices? | `overlapping-speech` class + background-talkers mixing; barge-in controller exists | ✅ corpus / 🟡 live |
| Speaker recognition & continuity to cancel others? | bystander suppression (confidence ≥0.7, not enrolled, no wake word) — scored; WeSpeaker centroids continuity | ✅ gate / 🟡 acoustic |
| Detect the user's voice? | WeSpeaker 256-d centroid, cosine ≥0.78 match, Welford online update | 🟡 GATED |
| Diarize multiple people → entities, extract names, merge? | pyannote diarizer + `VOICE_TURN_OBSERVED`→merge-engine→`VOICE_ENTITY_BOUND`; name extraction scored in `--logic` | ✅ seam / 🟡 acoustic |
| How do we know the owner? provider/evaluator when unsure? | `resolveOwnerCandidate` — exactly this logic, undecided until sufficient+unambiguous | 🔵 logic ✅; provider wiring TODO |
| Owner vs intruder (security)? | `owner-vs-intruder` scenario: impostor gated out (impostor-accept 0); research: FAR ≤0.1 % + ≥3 s utterance for sensitive actions | ✅ gate / 🟡 verification |
| Wake word "hey eliza"? | openWakeWord GGML head (real v0.3.0 published; bundle ship pending); `--logic` tests the "hey eliza" phrase override | ✅ phrase / 🟡 acoustic head |
| Mix local STT/TTS + fast cloud LLM? | documented + unit-tested routing; latency math: **~300–400 ms TTFA from end-of-speech** (local STT + Cerebras LLM + local Kokoro TTS) | research §7; 🟡 live |
| Qwen / Gemma / CoreML / TPU / eliza-1? | Qwen3-ASR (elizaOS ASR), Kokoro TTS, Gemma 3n audio-in, Apple ANE / Tensor G5 on-device; omni models cloud-only | research §6 |
| VAD? | Silero v5 2-tier; defaults per research §2 | 🟡 GATED |

---

## 5. What is gated (and why it is not faked)

The `--real` lane and the headful real-backend run need artifacts CI does not have here:
- **Acoustic models** (Qwen3-ASR, WeSpeaker, pyannote, Silero, openWakeWord, Kokoro/OmniVoice) — large GGUF/native libs; under the repo's `coverage=true` bunfig, model-loading EMFILEs (run real smokes OUTSIDE `bun test`). The fused native lib must be built per platform.
- **Live cloud STT/TTS** (ElevenLabs via `/api/v1/voice/*`) — needs an authenticated Cloud session; inference currently returns HTTP 402 (insufficient credits) on the test account — a billing state, not a code bug.
- **iOS device** — blocked on Apple ID provisioning in Xcode; simulator local-inference is Metal-limited.

Per the honesty contract, every one of these reports **`skipped`, never `pass`**, when the artifact is absent. The decision logic that does NOT need them is proven by `--logic` + the unit suites.

---

## 6. Open recommendation: PCM-level acoustic echo cancellation

The single most impactful missing piece. Today self-echo is caught only at the transcript level (word overlap), which fails when ASR mis-transcribes the echo or when the agent's TTS overlaps a real user turn. Recommended (research §3):
1. **`agentSpeaking` flag + ~1.5 s post-TTS cooldown with a raised RMS gate** — cheap, robust, no new model. *(Effective half-duplex; ship first.)*
2. **WebRTC AEC3 with a time-aligned playback reference**, interrupt detection off the linear-filter output — true barge-in.
3. **Speaker-embedding self-voice rejection** — imprint the agent's TTS voice (we already have the encoder) and reject frames matching it.

Track as a follow-up issue; the workbench `echo-rejection` scorer is ready to gate it.

---

## 7. How to verify (commands)

```bash
# Real decision logic over the full scenario matrix (no models, no network):
bun run --cwd plugins/plugin-local-inference voice:workbench -- --logic

# Unit suites:
bun run --cwd plugins/plugin-local-inference test -- src/services/voice/corpus-augment.test.ts \
  src/services/voice/workbench-logic-services.test.ts
bun run --cwd packages/shared test -- src/voice/owner-inference.test.ts
bun run --cwd packages/ui test -- src/voice/should-respond.test.ts src/voice/voice-turn-signal.test.ts

# Gated real-model lane (skips cleanly without artifacts):
bun run --cwd plugins/plugin-local-inference voice:workbench -- --real
```
