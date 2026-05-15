# Voice Wave 2 — closing summary (2026-05-14)

This is the closing summary for Voice Wave 2 in `/home/shaw/milady/eliza`
on `develop`. It complements `.swarm/VOICE_WAVE_2.md` (scope) and the
per-workstream impl reports under `.swarm/impl/`.

A parallel **Wave 3** (`W3-1` … `W3-12`) ran during the same window and is
also captured here for context — those commits closed gaps that bridged
into Wave 2's open items.

## Workstream tally

| Workstream | Status | Impl report |
|---|---|---|
| I1 turn detector | done | `impl/I1-turn.md` — bundle + scaffold + 110 tests |
| I2 speaker / OWNER | done | `impl/I2-speaker.md` — encoder + diarizer + profile store + onboarding routes + 84 tests |
| I3 emotion | done | `impl/I3-emotion.md` — Wav2Small classifier + text field-evaluator + 103 tests |
| I4 TTS cache (local + cloud) | done | `impl/I4-tts-cache.md` — shared snip + disk LRU + cloud cache |
| I5 sub-model versioning | done | `impl/I5-versioning.md` — manifest, signed Cloud catalog, model updater, UI panel, 76 tests |
| I6 OmniVoice freeze | done | `impl/I6-omnivoice.md` — preset v2, freeze-voice CLI, FFI bridge |
| I7 Kokoro samantha clone | done (gated) | `impl/I7-kokoro.md` — clone artifacts present; HF publish blocked on quality |
| I8 quantization | done | `impl/I8-quant.md` — K-quant ladders + OmniVoice ladder + ASR/turn-detector GGUF wrappers |
| I9 memory budget | done | `impl/I9-memory.md` — VoiceTierSlot, ensemble budgets, MAX/GOOD/OKAY/POOR classifier |
| I10 app voice UX | done | `impl/I10-app-ux.md` — components + hooks + mounts in ChatView/Header/chat-source |
| I11 ai_voices landing | done | `impl/I11-ai_voices.md` — samantha corpus + LJSpeech mirror + manifest builder |
| I12 verify guardian | done | rolling — final verify green (317/317 tasks) |
| Q1 quality metrics | done | `impl/Q1-quality.md` — metric bugs fixed + 21 unit tests + canonical docs |
| N2 kokoro full-FT | scaffolded | `impl/N2-kokoro-finetune.md` — runnable; awaits GPU operator |

## Closing-batch deliverables (this session, 2026-05-14)

### A — I10 mount points (agent A-i10-mounts)
- Commits: `a2203493fe`, `e66d0c3f6d`, `661cc6c587`.
- ContinuousChatToggle + ChatVoiceStatusBar mounted in `ChatView.tsx` and
  `PageScopedChatPane.tsx` (gated on voice activity / mode).
- OwnerBadge mounted in `Header.tsx` `rightDesktopControls`.
- ChatVoiceSpeakerBadge added to `chat-source.tsx` and `chat-message.tsx`;
  `voiceSpeaker` typed on `ConversationMessage`.
- family-step real capture wired via `recordAudioBlob` +
  `profilesClient.appendOwnerCapture` / `finalizeOwnerCapture`.
- 16 new tests across `useContinuousChat.test.tsx`, `chat-source.test.tsx`,
  `chat-message.voice-speaker.test.tsx`.

### B — Q1 metric correctness + re-eval (agent B-q1-finish)
- Commit: `28505f39fd` (plus earlier `ed56d0ce4b`, `c1f56d872e`,
  `1e4f474bd6`).
- 21 unit tests at `packages/training/scripts/kokoro/__tests__/test_metric_units.py`.
- Canonical metrics doc at `docs/inference/voice-quality-metrics.md`.
- Speaker-encoder INT8↔FP32 parity harness at
  `plugins/plugin-local-inference/native/verify/speaker_encoder_parity.mjs`.
- **Re-eval result:** with corrected SR + text normalisation, SpkSim
  delta flipped from −0.21 (broken) to **+0.27** (corrected) — the
  voice clone is moving toward samantha. UTMOS (Δ −2.43) and WER
  (Δ +1.04) still regress, so the HF publish gate stays blocked, but
  the regression is now diagnosable.
- **Next:** anchor-weight sweep ∈ {0.0, 0.05, 0.1, 0.2}, keep
  `lr=0.01`, bump `max_steps` to 1200.

### C — Heavy training phases (agent C-train-phases)
- All three `NotImplementedError` bodies are implemented (some by peer
  W3 agents during the same window — C verified + documented):
  - `distill_wav2small.py`: `teacher_pseudo_labels` (audeering
    teacher), `train_student` (71,666-param Wav2Small, **APOLLO-Mini**),
    `export_student_onnx` (INT8 quant + smoke roundtrip).
  - `finetune_turn_detector.py`: `build_pretrain_corpus` (DailyDialog),
    `build_sft_corpus`, `train_step` (APOLLO-Mini, top-3 by val F1,
    `RuntimeError` on F1-gate miss), `export_onnx`.
  - `finetune_kokoro_full.py`: smoke (12/12 green); configs ready.
- Tests: **58 passed** across the three suites.
- Operator deps: `torch`, `transformers`, `apollo-torch`, `onnx`,
  `onnxruntime`, `pyarrow`, `datasets`, `pyyaml`, `kokoro≥0.9.4`.

### D — I5 follow-ups (agent D-i5-followups)
- Commits: `d556b839b8`, `ea418323a0`, `10217361c6`.
- **D1 compat routes** — `/api/local-inference/voice-models/*` (six
  endpoints) in `plugin-local-inference/src/routes/voice-models-routes.ts`
  + UI client at `packages/ui/src/api/client-voice-models.ts`;
  `LocalInferencePanel.tsx` panel switched from no-op handlers to live.
- **D2/D3 native shims** — new package
  `@elizaos/capacitor-network-policy` with Android Kotlin
  (`NET_CAPABILITY_NOT_METERED`) and iOS Swift (`NWPathMonitor`
  long-lived monitor reading `isExpensive`/`isConstrained`).
- **D4 publish-pipeline writes** —
  `packages/training/scripts/append_voice_model_version.py` helper +
  `publish_custom_kokoro_voice.sh` wired to write into
  `voice-models.ts` and `models/voice/CHANGELOG.md` on each release
  (idempotent; the `already_has_entry()` regex fix handles re-runs
  with nested `ggufAssets` blocks).
- Tests: **57 new** across voice-models-routes (16), network-policy
  (17), voice-model-updater (24), plus 13 Python tests for
  `append_voice_model_version`.

### Parallel Wave 3 work (W3-1 … W3-12)
Wave 3 ran concurrently and closed deeper integration gaps. Major
landings:
- **W3-1** — VoiceProfileStore + VoiceAttributionPipeline wired into
  `EngineVoiceBridge`; speaker-imprint flows into entity bindings.
- **W3-2** — Three-agent dialogue benchmark
  (`packages/benchmarks/three-agent-dialogue/`).
- **W3-3** — OmniVoice merge / fine-tune pipeline.
- **W3-5** — Emotion roundtrip closure (classifier_adapter SUPERB
  discriminative re-scoring).
- **W3-6** — Multi-speaker validation
  (`packages/benchmarks/voice-speaker-validation/`).
- **W3-7** — Real voice bench harness (`bench:voice` orchestrator +
  smoke CI workflow `voice-bench-smoke.yml`).
- **W3-9** — `VoiceCancellationCoordinator` + barge-in integration tests
  + cancellation-contract doc.
- **W3-10** — ChatView continuous voice mode wiring (peer-landed,
  A-i10-mounts completed the PageScopedChatPane mirror).
- **W3-11** — Kokoro full-FT post-mortem (`impl/W3-11-finetune.md`),
  OmniVoice samantha config.
- **W3-12** — HF audit + repo-slug fixes (`elizalabs/eliza-1` →
  `elizaos/eliza-1` across all sources); `27b-1m` marked pending.

## What still blocks the public eliza-1 voice release

Per the publish gate in `release-staging/`:
1. **Voice quality (kokoro)** — clone candidate regresses on UTMOS/WER
   versus the af_bella baseline; HF push gated. Next: anchor-weight
   sweep + extended training.
2. **OmniVoice samantha freeze** — preset v2 shipped, but the
   public-publish path needs operator sign-off (Her-derivative
   training-data lineage check).
3. **Hardware-gated kernel verify** — Metal/iOS/Android kernel-verify
   harnesses ship but require physical hardware to flip from
   "compiles" to "runtime-verified".
4. **GPU evals** — distill_wav2small + finetune_turn_detector need
   operator-side GPU runs against the real teacher (audeering) /
   corpora (MSP-Podcast, MELD, IEMOCAP, DailyDialog).

None of these are code gaps in the runtime. The runtime carries every
piece of the voice loop end-to-end, gated behind the right safety
checks.

## Final verify

`bun run verify` → 317/317 tasks successful.

## Files of record

- `.swarm/voice-finish/CLOSING_PLAN.md` — the closing-batch plan that
  drove this session.
- `.swarm/voice-finish/eval-q1-rerun/` — Q1 corrected-metric eval JSON
  artifacts.
- `.swarm/voice-finish/WAVE_2_CLOSING_SUMMARY.md` — this file.
- `models/voice/CHANGELOG.md` — human-readable per-sub-model history
  (tracked).
- `packages/shared/src/local-inference/voice-models.ts` — machine
  history (extended by the publish helper).
- `docs/inference/voice-quality-metrics.md` — canonical metric
  reference.

## R-rename-2 (2026-05-14)

Completion of the `samantha` → `same` voice-pipeline rename that the
previous R-rename agent partially started and that the G2/G3/G4 peers
landed at the intermediate `sam` waypoint. User directive is `same` as
the canonical name; this agent closed the gap.

### Path renames (git mv)
- `packages/training/data/voice/sam/` → `packages/training/data/voice/same/`
  (CORPUS.md, README.md, .gitignore, manifest.jsonl, source.json,
  ljspeech/metadata.csv)
- `packages/training/scripts/kokoro/stage_sam_corpus.py` →
  `stage_same_corpus.py` (+ `__tests__/test_stage_sam_corpus.py` →
  `test_stage_same_corpus.py`)
- `packages/training/scripts/kokoro/configs/kokoro_sam{,_full,_f2,_g3}.yaml`
  → `kokoro_same*.yaml`
- `packages/training/scripts/asr/configs/asr_sam.yaml` → `asr_same.yaml`
- `packages/training/scripts/omnivoice/configs/omnivoice_sam.yaml` →
  `omnivoice_same.yaml`
- `packages/training/scripts/voice/audit_sam.sh` → `audit_same.sh`
- `packages/training/scripts/voice/build_sam_manifest.py` →
  `build_same_manifest.py` (+ `test_build_same_manifest.py`)
- Operator-side audio: `data/voice/same/audio/sam_NNN.{wav,txt}` →
  `same_NNN.{wav,txt}` (115 files, gitignored)
- Untracked `sam-distill/` staging dir → `same-distill/`

### Commit chain
- `94ef58172d` — path renames (filesystem)
- `c5ccb7f983` — in-file rename for voice corpus + scripts
- `b4206017a6` — voice docs / manifest / presets
- `aaceabc626` — training scripts + plugin tests
- `5d52fd25fb` — ffi.h doc + kokoro staging artifacts
- `467dc2317f` — voice profile defaults + freeze CLI + plugin tests

### Verify
- `bun --filter @elizaos/plugin-local-inference run typecheck` — green.
- `bun run lint` — green (biome version-mismatch warning is pre-existing).
- Targeted voice tests: 29/29 pass (`freeze-voice-cli.test.ts`,
  `voice-models-routes.test.ts`, `voice-preset-format-v2.test.ts`);
  `voice-profile-routes.test.ts` 15/15 pass; `voices.test.ts` 7/7 pass.
- `pytest scripts/{kokoro,voice,omnivoice,asr}/__tests__/` — 81/81 pass.
- 12 pre-existing voice test failures unrelated to this rename
  (engine-bridge `toBeInstanceOf`, FfiOmniVoice NULL preset, build-default
  voice preset, VoiceScheduler) — verified on baseline before any
  R-rename-2 changes, same failures.

### Ambiguous matches left alone (intentional)
- Upstream subset `samantha` references in `build_same_manifest.py`,
  `audit_same.sh`, `stage_same_corpus.py`, `same/README.md`,
  `same/CORPUS.md`, `same/source.json["upstreamSubset"]` — these point
  at `lalalune/ai_voices/samantha/`, the external repo's fixed
  directory name. We don't control upstream naming; the local clip ids
  are remapped to `same_NNN` at build time.
- `packages/examples/avatar/src/runtime/types.ts` — `VoiceOutputProvider = "sam" | "elevenlabs"` is an
  unrelated avatar voice provider enum, outside voice-pipeline scope.
- `packages/training/scripts/harness/personas.py` +
  `scenario_pool/MESSAGE.jsonl` — `sam` is a persona / message fixture
  name, not our voice.
- `models/voice/CHANGELOG.md` H3 entry citing the
  `ai_voices/samantha` upstream subset (one intentional reference).
- HF repo slugs already pushed by G4
  (`elizaos/eliza-1-voice-{asr,turn,emotion,...}`) — generic repo names
  without `samantha`/`sam`/`same`, left untouched.
