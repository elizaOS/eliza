# Voice E2E Gap Analysis — End-to-End Voice Pipeline Assessment
**Generated:** 2026-05-24  
**Machine:** Apple M4 Max (128 GB, ARM64, Metal)  
**Scope:** TTS, STT/ASR, Speaker Diarization, OWNER Voice Verification, Multi-User Scenarios, Security

---

## 1. What We Have (Confirmed Installed & Working)

### 1.1 TTS Engines

| Engine | Model Files | Backend | Status |
|--------|------------|---------|--------|
| OmniVoice | `omnivoice-base-Q8_0.gguf` + `omnivoice-tokenizer-Q8_0.gguf` (9b/27b bundles) | Metal FFI via llama-server | ✅ Models installed, server starts |
| Kokoro | `model_q4.onnx` + 10 voice packs (0_8b bundle) | ONNX (deprecated) / llama-server | ⚠️ ONNX broken, llama-server needs build |
| ElevenLabs | Cloud API | HTTP | ✅ Available with API key |
| Edge TTS | Microsoft cloud | HTTP | ✅ Free, no key |

**OmniVoice Voice Design:** Supports gender/age/pitch/style/emotion parameters. Can generate distinctly different voices for multi-user scenarios.

**Kokoro Voices Available:** af_bella (warm female), af_nicole (breathy), af_sarah (professional), af_sky (young female), am_adam (neutral male), am_michael (warm male), bf_emma, bf_isabella, bm_george, bm_lewis

### 1.2 ASR/STT

| Engine | Model Files | Status |
|--------|------------|--------|
| Eliza-1 ASR (Qwen3-based) | `eliza-1-asr.gguf` + `eliza-1-asr-mmproj.gguf` in 9b/27b bundles | ✅ Installed, loads in llama-server |
| Whisper.cpp | External whisper model | ✅ FFI adapter built |

### 1.3 Voice Processing Models

| Model | File | Status |
|-------|------|--------|
| VAD (Silero v5) | `silero-vad-v5.1.2.ggml.bin` (2b/27b bundles); MISSING from 0_8b | ⚠️ Missing from 0_8b bundle |
| Speaker Encoder (WeSpeaker ResNet34-LM) | `wespeaker-resnet34-lm-fp32.gguf` (0_8b) | ✅ Installed |
| Speaker Diarizer (Pyannote-segmentation-3.0) | `pyannote-segmentation-3.0-fp32.gguf` (0_8b) | ✅ Installed |
| Emotion Classifier (Wav2Small) | `wav2small-cls7-int8.onnx` (0_8b) | ✅ Installed |
| Turn Detector | `livekit-turn-detector` dir | ✅ Installed |

### 1.4 Existing Test Infrastructure

| Harness | Location | Passes |
|---------|----------|--------|
| Two-agent voice demo (synthetic) | `native/verify/two_agent_voice_demo.mjs` | ✅ 4 turns, 937ms avg, 113 tok/s |
| Speaker imprint diarization harness | `native/verify/speaker_imprint_diarization_harness.mjs` | ⚠️ VAD=false (missing model), attribution=1.0 |
| Voice duet sweep | `native/verify/voice_duet_sweep.mjs` | Not tested |
| Kokoro e2e preflight | `native/verify/kokoro_e2e_loop_bench.mjs` | ❌ ONNX broken, llama-server needs build |
| Three-agent dialogue runner | `packages/benchmarks/three-agent-dialogue/` | Uses Groq/synthetic only |
| VAD quality harness | `native/verify/vad_quality_harness.mjs` | Not tested |
| Voice profile emotion status | `native/verify/voice_profile_emotion_status.mjs` | Not tested |

### 1.5 Voice Profile & OWNER System

| Component | Status |
|-----------|--------|
| VoiceProfile types (isOwner, cohort, embeddings) | ✅ Fully defined |
| Voice profile API routes (`/api/voice/profiles`) | ✅ Implemented |
| Onboarding capture flow (start/append/finalize) | ✅ Implemented |
| OWNER role system (`roles.ts`, `resolveOwnershipRole`) | ✅ Fully implemented |
| Voice-to-role binding integration | ⚠️ Not wired — hook point exists |
| Diarization pipeline (`diarization-pipeline.ts`) | ✅ Code exists, not tested |
| Private challenge for OWNER verification | ✅ Code at `private-challenge.ts` |
| Owner confidence scoring | ✅ Code at `owner-confidence.ts` |

### 1.6 Code Architecture (What's Wired)

- `plugin-local-inference/src/services/voice/speaker/` — Speaker encoder + diarizer TypeScript wrappers
- `plugin-local-inference/src/services/voice/speaker-imprint.ts` — `attributeVoiceImprintObservations()` — attribution logic
- `plugin-local-inference/src/services/voice/vad.ts` — VAD detector + Silero provider
- `packages/app-core/src/services/voice-profiles/diarization-pipeline.ts` — Full diarization pipeline
- `packages/app-core/src/services/voice-profiles/store.ts` — Profile storage
- `packages/app-core/src/services/voice-profiles/owner-confidence.ts` — OWNER confidence scoring
- `packages/app-core/src/services/voice-profiles/private-challenge.ts` — Challenge-response for OWNER verification

---

## 2. What's Broken / Missing

### 2.1 Critical Gaps

**GAP-1: Full Multi-Speaker Diarization NOT Wired**
- `speaker_imprint_diarization_harness.mjs` explicitly reports: `"localMultiSpeakerImplemented": false`
- The diarizer GGUF exists (pyannote-segmentation-3.0-fp32.gguf)
- The TypeScript wrapper (`diarizer-ggml.ts`) exists
- But: No integration in the live voice pipeline connecting VAD → diarizer → speaker encoder → attribution
- Missing: End-to-end segment → speaker-ID assignment in production code path

**GAP-2: Kokoro TTS Broken on All Paths**
- ONNX path: `KokoroOnnxRuntime` constructor undefined (module resolution failure)
- llama-server path: `needs-build` — the fused llama-server binary doesn't include Kokoro `/v1/audio/speech` endpoint
- The Kokoro source exists in `native/llama.cpp/tools/kokoro/` but needs compilation into the server binary

**GAP-3: VAD Missing from 0_8b Bundle**
- The `eliza-1-0_8b.bundle/voice/vad/` directory is empty
- VAD exists in 2b and 27b bundles as `silero-vad-v5.1.2.ggml.bin`
- Diarization harness falls back to "no VAD" mode, skips real speech detection

**GAP-4: No Three-Voice End-to-End Test**
- The goal requires 3 voices (2 human + 1 agent) in the same audio stream
- Existing two-agent demo is synthetic only (no real audio)
- The `three-agent-dialogue` runner at `packages/benchmarks/` uses Groq (cloud) or synthetic
- No test uses omnivoice to generate distinct voices, merge them into one audio stream, and run through diarization

**GAP-5: OWNER Voice Verification Not Tested End-to-End**
- `owner-confidence.ts` and `private-challenge.ts` exist but no integration test
- No scenario testing OWNER recognition via voice profile match
- No test for security: non-owner voice attempting to get OWNER privileges
- Voice onboarding flow (UI) not tested with actual audio

**GAP-6: Agent Response Decision Test Missing**
- No scenario validating when agent SHOULD respond (addressed to it) vs. SHOULD NOT (ambient conversation not addressing agent)
- The agent's "should I respond?" logic is not covered by voice-specific tests

### 2.2 Secondary Gaps

**GAP-7: Emotion Model Backend Deprecated**
- `wav2small-cls7-int8.onnx` is the int8 ONNX format
- The voice-models.ts versioning shows v0.3.0 should be GGUF-only
- The GGUF version not installed in 0_8b bundle

**GAP-8: ASR Benchmarks Missing WER on Real Speech**
- `asr-wer-real-recorded-0_8b-needs-corpus-20260516.json` says "needs-corpus"
- No standardized audio corpus for WER measurement available locally
- RTF benchmarks exist but accuracy baselines don't

**GAP-9: OmniVoice Voice Design Multi-Voice Not Tested**
- OmniVoice supports gender/age/pitch/style/emotion parameters
- No test generating multiple distinct voices with different designs
- The `OMNIVOICE_INSTRUCT` parameter for voice design not exercised in benchmarks

---

## 3. Requirements vs. Current State

| Requirement | Status | Gap |
|------------|--------|-----|
| 3 voices in same room audio stream | ❌ | GAP-4 |
| Script-driven agent interaction | ✅ (scenario-runner) | None |
| Test when agent should/shouldn't respond | ❌ | GAP-6 |
| Voice transcripts from all voices | ⚠️ | GAP-1, GAP-2 |
| TTS via omnivoice.cpp | ⚠️ | GAP-2 (llama-server needs build for Kokoro) |
| TTS via kokoro | ❌ | GAP-2 |
| ASR via eliza-1 models | ✅ | None (9b/27b bundles) |
| Sub-agent: TTS/ASR baseline verification | ⚠️ | GAP-2, GAP-3 |
| Multi-user scenarios (male/female voices) | ❌ | GAP-4 |
| Merge audio streams from multiple voices | ⚠️ | Audio bus exists in 3-agent runner |
| Speaker diarization (differentiate voices) | ❌ | GAP-1 |
| Build entities/relationships from voice | ⚠️ | Infrastructure exists, not wired |
| OWNER recognized as OWNER | ⚠️ | GAP-5 |
| OWNER voice profile onboarding | ⚠️ | UI exists, not E2E tested |
| OWNER voice profile built during onboarding | ⚠️ | GAP-5 |
| Voice verification (non-owner can't impersonate) | ❌ | GAP-5 |
| Prompt injection attack scenario via voice | ❌ | GAP-5 |
| 1-person scenario | ✅ (two-agent synthetic) | Nearly there |
| 2-person differentiation | ❌ | GAP-1, GAP-4 |
| Role integration | ✅ (OWNER role system) | Wiring missing |

---

## 4. Implementation Plan

### Phase 1: Fix Core Models (1 session)

1. **Fix VAD for 0_8b bundle** — Copy silero VAD from 2b bundle or symlink
2. **Fix Kokoro ONNX path** — Debug KokoroOnnxRuntime module resolution  
3. **Build Kokoro llama-server** — Compile `native/llama.cpp` with kokoro support via `build-omnivoice.mjs`
4. **Verify diarizer loads** — Run `diarizer-ggml.ts` with pyannote model directly

### Phase 2: TTS/ASR Baseline (Sub-agent A)

1. Run omnivoice TTS with 3+ distinct voice designs → save WAV files
2. Run each WAV through eliza-1 ASR → verify transcript
3. Measure RTF and WER
4. Run kokoro TTS with `af_bella` (female) and `am_michael` (male) → compare
5. Benchmark all voices on M4 Max

### Phase 3: Multi-Voice Scenario (Sub-agent B)

1. Build `three_voice_scenario.mjs`:
   - Voice A: `omnivoice` with female voice design (high-pitched, young)
   - Voice B: `omnivoice` with male voice design (deep, older)  
   - Agent Voice: `omnivoice` with neutral/Eliza design
2. Script: A asks question, B comments, agent responds to A only
3. Use AudioBus from `packages/benchmarks/three-agent-dialogue/runner/audio-bus.ts`
4. Merge A+B into mixed audio stream → run diarization
5. Verify agent correctly attributes turns to speaker A or B

### Phase 4: Diarization Wiring (Sub-agent B)

1. Connect: VAD → pyannote diarizer → speaker encoder → speaker imprint attribution
2. Use `diarization-pipeline.ts` in `packages/app-core/src/services/voice-profiles/`
3. Test with mixed 2-speaker WAV (alternating voices)
4. Measure DER (Diarization Error Rate) on generated speech

### Phase 5: OWNER Voice Verification (Sub-agent C)

1. Simulate onboarding: capture voice samples → build embedding → store as OWNER profile
2. Test recognition: same voice → OWNER role assigned
3. Test rejection: different voice → USER role, OWNER access denied
4. Security test: attacker says "I am the owner" → voice profile mismatch → access denied
5. Integration with `resolveOwnershipRole()` in `roles.ts`

---

## 5. Quick Wins (Can Do Immediately)

1. **Fix VAD** — `cp ~/.eliza/local-inference/models/eliza-1-2b.bundle/vad/silero-vad-v5.1.2.ggml.bin ~/.eliza/local-inference/models/eliza-1-0_8b.bundle/voice/vad/`
2. **Run omnivoice TTS** — The 9b bundle has the model; need to start llama-server and call `/v1/audio/speech`
3. **Run diarization pipeline test** — Models installed in 0_8b bundle, TypeScript code exists
4. **Run voice profile emotion status** — `bun verify/voice_profile_emotion_status.mjs`

---

## 6. Benchmark Targets (M4 Max)

Based on existing results:
- Kokoro 0_8b TTS RTF: 0.066 (from existing bench results)
- LLM decode: 113 tok/s (eliza-1-0_8b)
- Average voice turn (TTS+ASR+LLM): ~937ms synthetic
- VAD frame compute: ~0.5ms median per 32ms frame (from VAD harness)

Target for 3-voice scenario:
- Total round-trip per turn: < 2s
- Diarization DER: < 15% on generated speech
- OWNER recognition accuracy: > 95% on 3+ enrollment samples
