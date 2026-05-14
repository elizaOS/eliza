# Swarm collaboration notes — Voice Wave 2

> **Read this file on every wake. Write to it if anything weird is happening.**

## Rules of the road

1. **No worktrees, no `git stash`, no branch switches.** Stay on `develop`.
2. **Commit dirty work as you go.** If you have to leave half-done, commit
   it as `wip(<scope>): ...` so the next agent inherits it cleanly.
3. **Don't `git reset --hard`.** It nukes other agents' uncommitted work.
   If you think you need to, leave a note here first and wait for the
   coordinator (C0).
4. **`git pull --no-rebase`** before every push (concurrent agents push too).
   If you hit a merge conflict, resolve it — don't `--ours` blindly.
5. **Don't kill processes you didn't start.** Check `.swarm/run/*.pid`
   before SIGTERM. Long-running training / build / serve jobs belong to
   the agent that started them.
6. **Heavy GPU/CUDA builds serialize.** Coordinate by appending an
   "owns the local GPU build right now" line below.
7. **One agent at a time per package directory for edits.** Reads are
   free. If you must touch a dir another agent is editing, post a note.
8. **Never finalize a "done" claim without `bun run verify` passing for
   your area.**

## Active agents (append-only roster)

(format: `YYYY-MM-DD HH:MM agent-id phase: claim`)

- 2026-05-13 23:30 C0 phase=meta: master brief at `.swarm/VOICE_WAVE_2.md`;
  spawning R1-R12 research agents now.
- 2026-05-13 23:42 R3-emotion phase=research: starting emotion-recognition
  (voice + text) survey; writing to `.swarm/research/R3-emotion.md`. Read-only
  on packages/core/runtime, packages/app-core/services, packages/inference.

## Locks / exclusive zones

(append a row when you start exclusive work; remove when you push)

- (none)

## Incidents / weirdness

(if something keeps getting deleted, written over, or breaks unexpectedly,
log it here with timestamp + agent-id + what happened + your hypothesis)

- (none yet)

## Open questions surfaced by research (C0 to resolve before Phase I)

- 2026-05-13 **R7 vs R12 — Kokoro path conflict.** R7 plans LoRA fine-tune
  (≤2000 steps) on the samantha clips. R12 reports the actual count is
  **58 paired clips ≈ 3.51 min**, well below the LoRA community minimum
  of 1–3 h. R12 recommends `extract_voice_embedding.py` (voice-clone-only)
  as the primary path. **C0 decision:** I7 runs voice-embedding-clone
  FIRST (it's the right tool for 3.5 min); LoRA only as an experimental
  comparison and only if we can source ≥30 min more samantha audio.
  Voice-embedding-clone is the publish path; LoRA experiment becomes the
  "fine-tune both" satisfier from the user's brief.

- 2026-05-13 **R12 — License.** `ai_voices` has no LICENSE; samantha voice
  is a derivative of *Her* (2013). **C0 decision:** the published HF
  artifact is research/personal-use only — model card must say so;
  default `private=true` on first push; do NOT public-release without
  explicit user OK on Phase V.

- 2026-05-13 **R12 — gitignore.** `packages/training/.gitignore` ignores
  `data/` globally. I11 adds a `data/voice/` carve-out so manifest +
  README track (raw audio stays ignored).

- 2026-05-13 **R7 side bugs.** `publish_custom_kokoro_voice.sh:36`
  whitelist missing `4b` (I7); `stage_kokoro_assets.py` hard-codes upstream
  voice repo path → add `--voice-remote-template` arg (I7);
  `eliza1_manifest.py:35` uses `elizalabs/eliza-1` while rest of repo
  uses `elizaos/eliza-1` (I12 — repo-wide fix).

- 2026-05-13 **R12 — Whisper hallucination.** `samantha_002.txt = '641.'`
  on a 1.37 s clip. I11/I7 must re-transcribe with `whisper-large-v3`
  before the manifest is published.
- 2026-05-13 23:42 R5-versioning phase=research: starting sub-model versioning + auto-update + per-platform policy research; writing to `.swarm/research/R5-versioning.md`.
- 2026-05-13 23:45 R6-omnivoice phase=research: starting OmniVoice freeze + llama.cpp port feasibility; read-only on packages/app-core/scripts/omnivoice-fuse, kernel-patches, voice pipeline-impls, ~/.eliza/local-inference/models/*.bundle/. Writing to `.swarm/research/R6-omnivoice.md`.
2026-05-13 23:48 R7-kokoro phase=research: starting Kokoro fine-tune pipeline + samantha corpus + HF publish gates audit; read-only on packages/training/scripts/kokoro, packages/training/data/voice, packages/training/AGENTS.md. Writing to .swarm/research/R7-kokoro.md.
2026-05-13 23:50 R8-quant phase=research: starting quantization pipeline coverage research; read-only on packages/inference, packages/native-plugins, packages/training/scripts, packages/app-core/scripts. Writing to .swarm/research/R8-quant.md.
2026-05-13 23:55 R9-memory phase=research: starting cross-model memory budget + MAX/GOOD/OKAY/POOR tier detection research; read-only on packages/app-core/src/services/local-inference, packages/inference, packages/shared/src/local-inference. Writing to .swarm/research/R9-memory.md.
2026-05-13 23:58 R10-app-ux phase=research: starting app voice UX audit — continuous chat, onboarding, OWNER badge, voice profile manager, mobile background audio. Read-only on apps/app, packages/ui/src/voice, plugins/plugin-capacitor-bridge, apps/app/electrobun. Writing to .swarm/research/R10-app-ux.md.
2026-05-13 23:59 R11-cancellation phase=research: starting tight ASR<->LM<->TTS cancellation audit; read-only on packages/app-core/src/services/local-inference, packages/core/src/services, packages/inference. Writing to .swarm/research/R11-cancellation.md.
2026-05-14 00:02 R12-ai_voices phase=research: starting ai_voices clone + samantha inventory; cloning to /tmp/ai_voices (NOT repo root); planning landing at packages/training/data/voice/samantha/. Writing to .swarm/research/R12-ai_voices.md.
2026-05-13 23:43 R4-tts-cache phase=research: starting first-sentence LRU TTS cache spec (local + Eliza Cloud); read-only on plugins/plugin-local-inference/src/services/voice, packages/app-core/scripts/kernel-patches, packages/app-core/scripts/voice-preset, cloud/apps/api/v1/voice, cloud/packages/lib/services/elevenlabs.ts, plugins/plugin-elizacloud/src/models/speech.ts, plugins/plugin-edge-tts/src, plugins/plugin-openai/models/audio.ts. Writing to .swarm/research/R4-tts-cache.md.
2026-05-13 23:55 R7-kokoro phase=research-done: wrote .swarm/research/R7-kokoro.md (audit of finetune_kokoro/eval_kokoro/stage_kokoro_assets/publish_custom_kokoro_voice + samantha staging plan + per-corpus YAML + HF repo target + manifest slot-in + I7 file list + risks). Effort class M for I7. No code changes.
2026-05-14 00:20 R12-ai_voices phase=research-done: ai_voices cloned (258 MB, public, no auth) to /tmp/ai_voices. samantha = 58 wav/txt pairs, 18.67 MB, 210.3 s (3.51 min) total, uniform 44.1 kHz mono 16-bit. Per-file .txt transcripts (Whisper-base via utils/transcribe_files.py). No LICENSE file (README says "research only"). Flagged: samantha_002.txt='641.' is a Whisper hallucination on a 1.37 s clip. Landing plan + gitignore carve-out (data/ is globally ignored) + LJSpeech mirror + 5-file audit script in .swarm/research/R12-ai_voices.md. Handoff to I11 (manifest builder + carve-out + scripts/voice/build_samantha_manifest.py) and I7 (kokoro extract_voice_embedding.py voice-clone — corpus too small at 3.5 min for full LoRA fine-tune). Effort: S. Working tree unpolluted; /tmp/ai_voices stays out of repo.
2026-05-14 00:25 R1-turn phase=research: starting turn-detection survey (turnsense + livekit/turn-detector model cards) and audit of existing repo turn handling. Read-only on plugins/plugin-local-inference/src/services/voice, packages/core/src/runtime/turn-*, packages/core/src/services/message.ts. Writing to .swarm/research/R1-turn.md.
- 2026-05-13 23:54 R5-versioning phase=research DONE: report at `.swarm/research/R5-versioning.md` (10 sections + verified path inventory). TL;DR — bundle manifest already has semver + sha + atomic-swap; gap is per-sub-model history (`voice-models.ts` + `CHANGELOG.md`), an updater service modeled on `update-checker.ts`, and a `NetworkPolicy` bridge (Capacitor Network plugin + iOS NWPathMonitor + Android NET_CAPABILITY_NOT_METERED + desktop OS shims). Effort: L, two PRs.
- 2026-05-13 23:55 R4-tts-cache phase=research-done: report at `.swarm/research/R4-tts-cache.md` (11 sections + verified path inventory). TL;DR — existing `PhraseCache` is per-text only and would replay wrong voice on Kokoro→ElevenLabs swap (F3 bug). Spec adds shared `firstSentenceSnip()` helper (`packages/shared/src/voice/`), a SQLite-backed `FirstLineCache` at `~/.milady/cache/tts-first-line/<provider>/<voiceId>/<voiceRevision>/<sha256>.opus` (64 MB / 30 d defaults), R2+D1-backed cloud counterpart hooked into `cloud/apps/api/v1/voice/tts/route.ts` (no message-stream-out TTS exists on cloud today; client posts to /v1/voice/tts after streamed text), settings-fingerprint match for safety. I4 effort: L. No code changes. Read-only audit.
- 2026-05-14 00:35 R2-speaker phase=research-done: report at `.swarm/research/R2-speaker.md` (11 sections + verified path inventory). TL;DR — ASR pipeline emits NO speaker info today (`BaseStreamingTranscriber.withMetadata` only echoes caller-supplied defaults; `speaker-imprint.ts` has zero callers; `VoiceSpeaker`/`VoiceSegment` types exist but no producer populates them). Recommend WeSpeaker ResNet34-LM (256-dim, ~7 MB int8, EER 0.72%, CC-BY-4.0) for embeddings + pyannote-segmentation-3.0 ONNX int8 (1.54 MB, MIT) for diarization; Sortformer rejected (broken NeMo ONNX export). OWNER pattern already exists end-to-end (`Role` enum in `packages/core/src/types/environment.ts`; `ensureOwnerRole` in `packages/agent/src/runtime/roles/src/index.ts`); shaw gets OWNER by writing `ELIZA_ADMIN_ENTITY_ID` at end of onboarding. Entity binding rides existing LifeOps `EntityStore.observeIdentity` with `platform:"voice"` — no new identity graph, no new field on `core` Entity. "Jill" scenario: 1 new Entity row (Jill via her own utterance) + 1 voice identity + 1 `partner_of` row (`metadata.label="wife"`); Shaw's intro alone creates only a pending relationship that resolves when Jill speaks. I2 needs 12 new files + 7 edits; effort class M (5-7 days core). No code edits this round.
2026-05-14 00:08 R11-cancellation phase=research-done: .swarm/research/R11-cancellation.md landed. TL;DR — runtime.TurnControllerRegistry + BargeInCancelToken + OptimisticRollbackController already exist as three islands; spec one VoiceTurnToken that binds them, plus add the missing runtime.abortTurn() call on hardStop. C++ TTS interrupt is the load-bearing gap (HTTP /v1/audio/speech is non-streaming). Two slot-save REST shapes coexist in tree (fork: ?action=save; client: /save?filename). Effort L.
2026-05-14 00:55 R1-turn phase=research-done: report at .swarm/research/R1-turn.md (10 sections + 2 appendices). TL;DR — existing EOT scaffold (`HeuristicEotClassifier`, `LiveKitTurnDetector`, `RemoteEotClassifier`) and `VoiceTurnController` already wire turn signal into runtime via `voiceTurnSignal` on Memory.content; the *integration* is done, *bundling* is missing. Three bugs in current code: default ONNX filename is wrong (`model_quantized.onnx` vs upstream `onnx/model_q8.onnx`), no manifest entry for `turn` lineage/files, no staging step in `stage_eliza1_bundle_assets.py`. Recommended ship path: `livekit/turn-detector @ v1.2.2-en` (SmolLM2-135M distilled, 65.7 MB ONNX) for ≤1.7B tiers; `livekit/turn-detector @ v0.4.1-intl` (pruned Qwen2.5-0.5B, 396 MB ONNX, 14 langs) for ≥4B tiers; turnsense Apache-2.0 fallback if LiveKit license review blocks. Effort: M to ship Option A; XL to fine-tune into Qwen3.5 head later. Cancellation handshake spec'd for R11 — keep `BargeInCancelToken.signal`, add `"turn-suppressed"` reason. No code edits; only writes are .swarm/research/R1-turn.md + this collab note + roster line above. Exiting.
- 2026-05-13 23:55 R6-omnivoice phase=research-done: report at `.swarm/research/R6-omnivoice.md`. TL;DR — llama.cpp port already shipped (graft, no custom ops needed); OmniVoice has NO learned speaker embedding (text-instruct + ref-audio-tokens only); freeze plan is preset-based (ELZ2 format v2 with `refAudioTokens`/`refText`/`instruct` sections), not graph surgery. I6 effort class **S**.
- 2026-05-14 01:05 R3-emotion phase=research-done: report at `.swarm/research/R3-emotion.md` (8 sections + sources + verified in-repo path inventory). TL;DR — voice path: ship **`Wav2Small`** (72K params, ~120 KB ONNX, continuous V-A-D) distilled from `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim` (teacher only — license CC-BY-NC-SA-4.0 forbids shipping). **`emotion2vec_plus` REJECTED**: 1.12 GB PT, ONNX export upstream is unresolved ([emotion2vec issue #55](https://github.com/ddlBoJack/emotion2vec/issues/55)). `SenseVoiceSmall` (int8 ONNX ~230 MB, Apache-2.0 mirror at `DennisHuang648/SenseVoiceSmall-onnx`) is the alternative if I6 replaces Qwen3-ASR with it — gets emotion + AED + LID for free; cross-ref R-quant/R-memory. Existing Qwen3-ASR does NOT advertise model-native emotion (`expressive-tags.ts:305-340` explicitly handles `asr_emotion_metadata_ignored`). Text path: **REUSE eliza-1 LM via the Stage-1 envelope `emotion` enum field-evaluator** — `EXPRESSIVE_EMOTION_ENUM` already declared at `expressive-tags.ts:63-66`, one-liner registration in `builtin-field-evaluators.ts`; zero new binary. Roberta-go-emotions ONNX = documented fallback. Runtime channel: new `voiceEmotion?: VoiceEmotionAttribution` on `TranscriptUpdate`; new `metadata.voice.{emotion,transcript,audio,timestamp}` on `MessageMetadata`; `Content.emotion` rides existing dynamic-property signature. Consumers: planner provider entry at position `-5` (opt-in, `confidence > 0.6`); TTS via existing `SpeakTask.emotion` channel — OmniVoice first-class (`plugin-omnivoice/synth.ts:18-35` already accepts `design.emotion`), inline tags on singing GGUF, **Kokoro = NO emotion knob** (only `(input_ids,style,speed)` — per-emotion style vectors needed, R7 dependency); ElevenLabs `voice_settings.style`. Bench: new `packages/benchmarks/voice-emotion/` for IEMOCAP/MELD/MSP-Podcast intrinsic + emotion-fidelity duet metric. Existing `attributeVoiceEmotion` in `voice/emotion-attribution.ts` becomes the fusion stage. I3 effort: **M** (Wav2Small + reuse Stage-1 + plumbing + bench, 5-7 days, one engineer). **L** if SenseVoice-replaces-ASR. No code edits this round.
2026-05-13 23:58 R9-memory phase=research-done: report at .swarm/research/R9-memory.md. Audited ram-budget/memory-monitor/recommendation/active-model + voice/shared-resources; measured live bundle weights in ~/.eliza/local-inference/models/eliza-1-{0_6b,1_7b}.bundle/; produced MAX/GOOD/OKAY/POOR thresholds, the VoiceBudget allocator API, hot/warm/cold role mapping (incl. emotion=15 + speaker-id=18 additions), tier warning copy, mobile constraints, and the I9 file-touch list. M effort.
2026-05-13 23:59 R8-quant phase=research-done: report at .swarm/research/R8-quant.md. Coverage matrix + concrete fork-op gaps + concrete I8 sequencing. Key findings: K-quant ladder Q3/Q5/Q6 sibling apply scripts missing for text LM (referenced but unwritten); omnivoice.cpp already covers Q2_K..Q8_0; kokoro+turn-detector+VAD+wakeword+speaker-encoder+emotion are NOT amenable to polar/qjl/tbq as literal application — most are ONNX-canonical and that's correct, not a gap. Stale llama.cpp pin in AGENTS.md (says v1.0.0-eliza @ 08032d57, actual is ce85787c).

## Tracking policy for .swarm/ artifacts (C0)

- `.swarm/` is gitignored at `.gitignore:550`.
- R7, R12, R1, R2, R3, R4, R5, R8, R9, R11 left reports untracked (default).
- R6 force-added its report + this collab.md via commit `18f55c464f` (pushed).
- **Decision:** at Phase-V close, C0 force-adds all `.swarm/research/*` + the
  final `.swarm/collab.md` + `.swarm/VOICE_WAVE_2.md` in one cleanup commit so
  the wave's record is durable on origin. Other agents do NOT force-add — leave
  it to C0 to avoid noise/conflicts.
2026-05-13 00:25 R10-app-ux phase=research-done: report at .swarm/research/R10-app-ux.md (audit of existing voice surface; specs for continuous-chat toggle, 7-step onboarding prefix with owner voice capture, OWNER badge surfaces, voice profile manager UI, mobile background audio plumbing for iOS UIBackgroundModes + Android FOREGROUND_SERVICE_MICROPHONE, device-tier banner, full Voice settings tree). Estimated effort L; recommend splitting I10 into a/b/c/d/e sub-tasks. No code changes — research only.
- 2026-05-13 23:56 I1-turn phase=impl-starting: starting Turn Detector bundling implementation. Will fix the three R1 bugs (eot-classifier filename, manifest schema, stage script), scaffold turn_detector fine-tune dir, add eval gate, extend tests. Working in plugins/plugin-local-inference and packages/training/scripts.
- 2026-05-14 01:30 I5-versioning phase=impl-starting: starting sub-model versioning + auto-updater + per-platform network policy + UI panel + Cloud catalog endpoint. Adding new files (no overlap with peers): models/voice/CHANGELOG.md, packages/shared/src/local-inference/voice-models.ts + network-policy.ts + manifest-signature.ts, plugins/plugin-local-inference/src/services/voice-model-updater.ts, packages/ui/src/components/local-inference/ModelUpdatesPanel.tsx, cloud/apps/api/v1/voice-models/catalog/route.ts, CLI register.models.update.ts. Will only EDIT: packages/shared/src/local-inference/index.ts (re-exports), packages/shared/package.json (add @noble/curves), plugins/plugin-local-inference/src/services/manifest/schema.ts (header comment fix + optional sourceVersions field). Other I-agents touching schema.ts: coordinate before swap.
