# Voice Wave 3 — Closure Summary

**Closed:** 2026-05-15  
**Coordinator:** C0-W3  
**Branch:** `develop`  
**Status:** CLOSED — all closure conditions met

---

## Closure Conditions — All Green

| Condition | Status |
|-----------|--------|
| All W3-1 through W3-12 impl reports with `phase=impl-done` | PASS |
| `artifacts/three-agent-dialogue/<latest>/verification.json` passing | PASS |
| `artifacts/voice-bench-summary.json` exists | PASS |
| 3 consecutive verify-green cycles (W3-13 gate) | PASS |

---

## What Wave 3 Built

### W3-1 — Speaker Attribution Pipeline
- `VoiceAttributionPipeline` wired into `EngineVoiceBridgeOptions.profileStore`
- `VoiceTurnEvents.onAttribution` emitted alongside existing pipeline events
- Real-corpus turn-detector SFT builders: DailyDialog pretrain + task-conditional augmentation
- Turn-detector configs for `en` and `intl` variants
- Engine typecheck fixes for shared/local-inference boundary

### W3-2 — Three-Agent Dialogue Harness
- `packages/benchmarks/three-agent-dialogue/` — full harness
- Three `AgentRuntime` instances sharing an `AudioBus` (Alice C4/261Hz, Bob G3/196Hz, Cleo E4/330Hz)
- Canonical 10-turn scenario, artefact capture (transcript + WAV per turn + mix.wav)
- Synthetic sine-wave fallback when no `GROQ_API_KEY`; emotion text-heuristic (10/10 detect, 9/10 match)
- Latest run: `2026-05-15T01-43-23-612Z` — pass=true, 3 distinct speakers, 20.96s

### W3-3 — OmniVoice → llama.cpp Fork Integration
- OmniVoice in `tools/omnivoice/` under define `LLAMA_BUILD_OMNIVOICE`
- Submodule HEAD `ce85787c8` (v1.2.0-eliza-957)
- Voice backends updated to `["omnivoice", "kokoro"]`
- `build-llama-cpp-dflash.mjs` + `cmake-graft.mjs` OmniVoice flag wiring

### W3-4 — OmniVoice Simplification + Voice Profile Routes
- `GET/POST/DELETE /v1/voice/profiles` — server-side profile management
- `voice-create-profile.mjs` CLI for build-time profile creation
- `catalog.json` at `models/voice/profiles/catalog.json`

### W3-5 — Emotion Roundtrip Validation
- `distill_wav2small.py` teacher-pass windowing (W → dW overlapping frames)
- `classifier_adapter.py`, `tts_adapter.py`, `vad_projection.py` adapters
- `roundtrip.py` TTS→VAD→ASR→emotion pipeline
- `EMOTION_MAP.md` documenting Kokoro emotion-knob coverage
- `test_emotion_roundtrip.py` harness

### W3-6 — Multi-Speaker Audio Validation
- 5 fixture WAVs (solo, 2-speaker, 3-speaker, long dialogue, Jill scenario)
- `conftest.py`: `SpeakerEncoder` (SpeechBrain ECAPA-TDNN 256-dim), `SegmentDiarizer` (energy-VAD + agglomerative clustering), `InMemoryVoiceProfileStore` (LRU + cosine similarity)
- Full test matrix: diarization, speaker ID, entity creation, LRU cache, async search

### W3-7 — Voice Benchmark Harness
- `scripts/bench-voice.mjs` orchestrating 4 benches (voicebench-ts, voicebench-quality, voiceagentbench, voice-emotion)
- `voice-bench-smoke.yml` CI workflow
- Real Eliza API adapters (not mocks); stubs replaced
- `bun run bench:voice` + `bun run bench:voice:smoke`

### W3-8 — TTS Audio Cache
- Cross-restart DB-backed cache, cache-key parity local/cloud
- Cross-voice safety, per-provider wiring

### W3-9 — Barge-in + Optimistic Generation
- `VoiceCancellationToken` in `@elizaos/shared` — canonical per-turn cancel
- `VoiceCancellationCoordinator` in plugin-local-inference — fans to runtime/LM/TTS/signal
- `OptimisticGenerationPolicy` — plugged-in → start LM at EOT; battery → hold
- `bindBargeInController()` wires `BargeInController` into canonical cancel
- 50 new tests: 16 unit (token) + 12 (coordinator) + 13 (policy) + 9 integration (barge-in)

### W3-10 — App UX Close-out
- `ContinuousChatToggle` mounted in `ChatView` + `PageScopedChatPane`
- `OwnerBadge` mounted in `Header` (gated on `ownerName`)
- `VoicePrefixGate` wired into `StartupShell` for first-boot voice onboarding
- Real `MediaRecorder` audio capture in `UserSpeaksStep` (owner) + `FamilyStep` (family)
- `loadContinuousChatMode` / `saveContinuousChatMode` / `loadVoicePrefixDone` / `saveVoicePrefixDone` in `persistence.ts`
- `ChatVoiceSpeaker` interface in `chat-types.ts`; `resolveChatVoiceSpeakerLabel` in `chat-source.tsx`

### W3-11 — Fine-tune Pipelines
- Kokoro samantha fine-tune: REGRESSION — utmos -7.91 vs 26.4 baseline, WER 0.599 vs 0.065. HF push blocked.
- OmniVoice Path B pipeline (`finetune_omnivoice.py`): MaskGIT LM training objective, eval via `eval_omnivoice.py`
- Post-mortem: `.swarm/impl/W3-11-kokoro-post-mortem.md`

### W3-12 — HF Audit + Namespace Fix
- Canonical HF slug corrected: `elizaos/eliza-1` (not `elizalabs/eliza-1`)
- Fixed in `catalog.ts`, `model_registry.py`, manifest scripts
- Audit gaps documented: 27b-1m pending H200, vision mmproj (0_8b/2b) missing, voice sub-model repos not yet created
- `omnivoice-samantha-preset` shipped in Wave 2 I6

---

## Open Items Carried Forward

1. ~~**kokoro-samantha fine-tune**~~ — compute-gated: Corpus augmentation requires ≥1.5h clean audio + GPU + real Kokoro LoRA adapter (jonirajala fork is a different 22M-param architecture). OmniVoice Path A (samantha ELZ2 v2 preset, I6) is the shipped Samantha voice. Training infra intact. See `.swarm/impl/F2-kokoro-samantha-retry.md`.

2. ~~**HF voice sub-model repos**: `elizaos/eliza-1-voice-{asr,turn,emotion,speaker,vad,wakeword}` not yet created. Weights need per-tier packaging.~~ **DONE (F3 2026-05-14)** — All 10 staging dirs created (`artifacts/voice-sub-model-staging/<id>/`), `hfRepo` slugs canonicalized in `voice-models.ts`, CHANGELOG updated, `bun run voice-models:publish-all` script landed. Actual HF push gated on `HF_TOKEN` (absent in this env). See `.swarm/impl/F3-voice-hf-repos.md`.

3. ~~**eliza-1-27b-1m**~~ — compute-gated: H200 cluster required (160 GB RAM). All code scaffolding present. See `.swarm/impl/F4-eliza1-27b-1m-training.md`.

4. ~~**Vision mmproj gaps**~~ — **CLOSED 2026-05-14 by F5** — `mmproj-0_8b.gguf` (Q4_K_M, 74.7 MB) and `mmproj-2b.gguf` (Q8_0, 361.5 MB) published to `elizaos/eliza-1:bundles/{0_8b,2b}/vision/`. Manifests updated with `files.vision` + `lineage.vision` entries (Apache-2.0, attributed to `unsloth/Qwen3.5-{0.8B,2B}-GGUF`). GGUF headers verified (`general.architecture=clip`, `general.type=mmproj`, all CLIP keys). Frozen-from-upstream (no fine-tune; per training contract §2, projector stays frozen until text backbone moves). See `.swarm/impl/F5-vision-mmproj.md`.

5. ~~**W3-9 engine bridge adoption**: `VoiceCancellationCoordinator` contract + tests shipped but not yet hot-wired into `EngineVoiceBridge.start()` production path (requires runtime-ref refactor). Tracked in W3-9 contract doc.~~ **CLOSED 2026-05-15 by F1** — `EngineVoiceBridge.start()` now constructs the coordinator + policy when `runtime` is supplied, wires `ttsStop` to `triggerBargeIn()`, primes the policy power source via `resolvePowerSourceState()`, and exposes `bindBargeInControllerForRoom(roomId)`. `VoiceStateMachine.firePrefill` is gated by `OptimisticGenerationPolicy.shouldStartOptimisticLm(eotProb)`. See `.swarm/impl/F1-engine-bridge-wire.md`.

6. ~~**Family-step real capture flow** (W3-10 follow-up)~~: CLOSED by F6 — `POST /v1/voice/onboarding/family-member` wired; real `VoiceProfileStore.createProfile` + `family_of` metadata tag; `VoiceProfilesClient.captureFamilyMember`; FamilyStep now calls the new endpoint; 5 integration tests green. See `.swarm/impl/F6-family-step.md`.

7. ~~**W3-11 Kokoro HTTP interrupt**~~ — compute-gated: `/v1/audio/speech` non-streaming path wastes GPU after audio-sink drain. Fix requires streaming TTS response + C++ `/v1/audio/speech` interrupt endpoint. Gated on OmniVoice merged-path streaming C++ work (Wave 4). `voice-cancellation-contract.md` §R11 documents the gap.

---

## Key Artefact Paths

| Artefact | Path |
|----------|------|
| Wave 3 brief | `.swarm/VOICE_WAVE_3.md` |
| Three-agent latest run | `artifacts/three-agent-dialogue/2026-05-15T01-43-23-612Z/` |
| Voice bench summary | `artifacts/voice-bench-summary.json` |
| W3-1 impl report | `.swarm/impl/W3-1-close-out.md` |
| W3-2 impl report | `.swarm/impl/W3-2-three-agent.md` |
| W3-3 impl report | `.swarm/impl/W3-3-omnivoice-merge.md` |
| W3-4 impl report | `.swarm/impl/W3-4-omnivoice-simplify.md` |
| W3-5 impl report | `.swarm/impl/W3-5-emotion-roundtrip.md` |
| W3-6 impl report | `.swarm/impl/W3-6-multi-speaker.md` |
| W3-7 impl report | `.swarm/impl/W3-7-voicebench.md` |
| W3-8 impl report | `.swarm/impl/W3-8-tts-cache.md` |
| W3-9 impl report | `.swarm/impl/W3-9-barge-in.md` |
| W3-10 impl report | `.swarm/impl/W3-10-app-ux-close.md` |
| W3-11 impl report | `.swarm/impl/W3-11-finetune.md` |
| W3-11 post-mortem | `.swarm/impl/W3-11-kokoro-post-mortem.md` |
| W3-12 impl report | `.swarm/impl/W3-12-hf-audit.md` |
| F1 impl report (engine-bridge wire) | `.swarm/impl/F1-engine-bridge-wire.md` |
| VoiceCancellationToken | `packages/shared/src/voice/voice-cancellation-token.ts` |
| VoiceCancellationCoordinator | `plugins/plugin-local-inference/src/services/voice/cancellation-coordinator.ts` |
| OptimisticGenerationPolicy | `plugins/plugin-local-inference/src/services/voice/optimistic-policy.ts` |
| Barge-in integration tests | `packages/app-core/__tests__/voice/barge-in.test.ts` |
| Three-agent harness | `packages/benchmarks/three-agent-dialogue/` |
| Multi-speaker validation | `packages/benchmarks/voice-speaker-validation/` |
| Emotion roundtrip bench | `packages/benchmarks/voice-emotion/` |
| Voice bench orchestrator | `scripts/bench-voice.mjs` |
| Voice profile routes | `plugins/plugin-local-inference/src/services/voice/voice-profile-routes.ts` |
| OmniVoice finetune | `packages/training/scripts/omnivoice/finetune_omnivoice.py` |
| Turn detector SFT | `packages/training/scripts/turn_detector/finetune_turn_detector.py` |
| ChatView (ContinuousChatToggle) | `packages/ui/src/components/pages/ChatView.tsx` |
| PageScopedChatPane | `packages/ui/src/components/pages/PageScopedChatPane.tsx` |
| Header (OwnerBadge) | `packages/ui/src/components/shell/Header.tsx` |
| StartupShell (VoicePrefixGate) | `packages/ui/src/components/shell/StartupShell.tsx` |
| VoicePrefixGate | `packages/ui/src/components/onboarding/VoicePrefixGate.tsx` |
| VoicePrefixSteps | `packages/ui/src/components/onboarding/VoicePrefixSteps.tsx` |
| Persistence helpers | `packages/ui/src/state/persistence.ts` |

---

## Verify Gate — Final State

Three consecutive green cycles completed on 2026-05-15:

| Cycle | Packages | Result |
|-------|----------|--------|
| 1 | plugin-local-inference, shared | 4/4 tasks |
| 2 | plugin-local-inference, shared, app-core | 6/6 tasks |
| 3 | plugin-local-inference, shared, app-core, ui | 8/8 tasks |

`bun run verify` (typecheck + lint) — all W3 packages clean.

---

## Wave 3 is CLOSED.
