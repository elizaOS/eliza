# #9147 Headful Voice Workbench DER Gate

Date: 2026-06-24
Branch: `fix/finish-9147`

Scope:
- The headful voice workbench player now returns `expectedSpeakerLabel`,
  `predictedSpeakerLabel`, and a top-level diarization DER summary.
- A speaker-label mismatch marks the affected turn as `fail`; the scenario is
  no longer green from respond-decision alone.
- The shell mirrors DER and speaker labels into DOM attributes so Playwright and
  non-JS scrapers can verify the result.
- The shared Playwright driver asserts JSON report labels, DER budget, and DOM
  speaker-label attributes for every voice-workbench scenario.
- The provisioned `voice-live-e2e.yml` acoustic matrix now runs a
  `packages/benchmarks/voice/*real*` script instead of omitting that acceptance
  lane. The new `voice-real-ci-matrix.mjs` script requires the staged fused
  library, WeSpeaker GGUF, pyannote GGUF, ASR/TTS bundle, and ElevenLabs key; it
  writes DER/WER/echo-rejection/owner-accuracy/impostor-accept JSON and Markdown
  reports, and fails rather than producing skip evidence when real dependencies
  are absent.
- `voice:workbench --real` now uses a provisioned real services adapter instead
  of passing `services: null`. The adapter generates distinct human speech with
  ElevenLabs, uses fused local TTS for agent echoes, prepares WeSpeaker speaker
  centroids from the generated corpus, runs fused ASR + pyannote, computes live
  `selfVoiceSimilarity`, and feeds the same respond gate/scorers as the mock and
  logic lanes.
- The acoustic workflow now invokes `bun run --cwd plugins/plugin-local-inference
  voice:workbench --real --out "$VOICE_REAL_MATRIX_OUT/voice-workbench-real"` so
  the named `--real` acceptance lane produces a workbench JSON/Markdown report
  in the uploaded `voice-real-acoustic-matrix` artifact.
- The workflow now targets the online provisioned `self-hosted, Linux, X64,
  eliza` runner pool instead of the absent `gpu-cuda-12.6` label. The real lane
  still fails hard on missing bundle/library/GGUF/secret dependencies after the
  job starts; the label change only makes the job schedulable.
- The acoustic workflow probe now creates `VOICE_REAL_MATRIX_OUT` before any
  hard dependency check and tees runner/provisioning output into `probe.log`, so
  early red runs still upload actionable evidence instead of failing artifact
  upload with an empty directory.
- The optional round-trip job no longer calls the removed
  `native/build-whisper.mjs` or the nonexistent `test:voice:roundtrip` script.
  It now probes for a preprovisioned fused ASR bundle, runs the current
  `test:asr:real` smoke when present, and only runs `roundtrip:real` when both
  cloud credentials are available.
- The acoustic matrix job no longer has `continue-on-error: true`; missing real
  evidence is now a red nightly / workflow-dispatch result.

Validation:

```bash
bunx @biomejs/biome check \
  packages/ui/src/voice/voice-selftest/voice-workbench-player.ts \
  packages/ui/src/voice/voice-selftest/VoiceWorkbenchShell.tsx \
  packages/app/test/ui-smoke/voice-workbench-cases.ts \
  plugins/plugin-local-inference/scripts/voice-workbench.ts \
  plugins/plugin-local-inference/src/services/voice/corpus-generator.ts \
  plugins/plugin-local-inference/src/services/voice/workbench-headless-runner.ts \
  plugins/plugin-local-inference/src/services/voice/workbench-real-services.ts \
  plugins/plugin-local-inference/src/services/voice/VOICE_WORKBENCH.md \
  packages/benchmarks/voice/voice-real-ci-matrix.mjs \
  packages/benchmarks/voice/CLAUDE.md \
  packages/benchmarks/voice/AGENTS.md \
  packages/benchmarks/voice/README.md

bun run --cwd packages/ui typecheck
bun run --cwd packages/app typecheck

bun run --cwd packages/app test:e2e \
  test/ui-smoke/voice-workbench-diarization.spec.ts --project=chromium

actionlint .github/workflows/voice-live-e2e.yml

gh api --paginate repos/elizaOS/eliza/actions/runners \
  --jq '.runners[] | select(([.labels[].name] | index("eliza"))) | {name,status,busy,labels:[.labels[].name]}'

bun build packages/benchmarks/voice/voice-real-ci-matrix.mjs \
  --target=bun --outfile=/tmp/voice-real-ci-matrix.js

bun build plugins/plugin-local-inference/scripts/voice-workbench.ts \
  --target=bun --outfile=/tmp/voice-workbench.js

bunx vitest run \
  plugins/plugin-local-inference/src/services/voice/corpus-generator.test.ts \
  plugins/plugin-local-inference/src/services/voice/workbench-headless-runner.test.ts \
  plugins/plugin-local-inference/src/services/voice/workbench-logic-services.test.ts

bun run --cwd plugins/plugin-local-inference typecheck

bun run --cwd plugins/plugin-local-inference voice:workbench --logic \
  --out /tmp/voice-workbench-logic

ELIZA_ASR_BUNDLE=/tmp/eliza-missing-real-bundle ELEVENLABS_API_KEY=test \
  bun run --cwd plugins/plugin-local-inference voice:workbench --real \
  --out /tmp/voice-workbench-real-missing

bun run verify
```

Result:
- Biome: pass.
- `packages/ui` typecheck: pass.
- `packages/app` typecheck: pass.
- Focused Playwright diarization scenario: `1 passed`.
- `actionlint`: pass.
- Runner placement audit: online `self-hosted, Linux, X64, eliza` runners exist;
  no runner currently advertises `gpu-cuda-12.6`.
- Benchmark script bundle/syntax build: pass (`1361 modules`).
- `voice:workbench` CLI bundle/syntax build: pass.
- Focused workbench Vitest: pass (`23 passed`).
- `plugins/plugin-local-inference` typecheck: pass.
- `voice:workbench --logic`: pass (`15 ran, 0 skipped`).
- `voice:workbench --real` missing-dependency honesty check: pass by expected
  failure (`exit_status=1`, clear `missing ELIZA_ASR_BUNDLE` error).
- Root `bun run verify`: pass (`509 successful, 509 total`).
- Current-head rebase verification on `origin/develop`: pass
  (`bun install --frozen-lockfile`, focused builds/tests, Playwright
  diarization smoke, `actionlint`, `git diff --check origin/develop...HEAD`,
  and root `bun run verify` with `509 successful, 509 total`).
- Workflow-dispatch audit:
  - `Voice Live E2E` run `28092178735` on branch `fix/finish-9147` scheduled on
    the `self-hosted, Linux, X64, eliza` runner pool after the label fix.
  - `Real acoustic VAD + diarization + self-voice matrix` started on runner
    `odi-100-25-4` and failed in `Probe provisioned voice runner` because
    `ELEVENLABS_API_KEY` was empty; the same probe showed `nvcc`,
    `nvidia-smi`, and `ffmpeg` absent on that host.
  - `Real voice STT + TTS->STT round-trip` started on runner `odi-100-25-5` and
    failed at the stale `plugins/plugin-local-inference/native/build-whisper.mjs`
    command; the workflow now uses the current fused-ASR smoke/roundtrip scripts
    instead.
- Workflow-dispatch audit after probe hardening:
  - `Voice Live E2E` run `28093202597` on branch `fix/finish-9147` executed the
    fixed workflow at commit `ef05bb12a8e6037c8e9801c7d89f1bc8e8f6d281`.
  - `Real fused ASR + optional mixed round-trip (self-hosted)` passed on runner
    `odi-100-25-4`. The probe reported no preprovisioned fused ASR bundle at
    `/home/runner/.eliza/local-inference/models/eliza-1-2b.bundle` and no fused
    library, set `ELIZA_ROUNDTRIP_REAL_READY=0`, and skipped the optional
    `test:asr:real` / `roundtrip:real` steps without calling the removed
    `native/build-whisper.mjs` path.
  - `Real acoustic VAD + diarization + self-voice matrix (self-hosted)` started
    on runner `odi-100-25-3` and failed hard in `Probe provisioned voice runner`
    before executing the acoustic matrix. The uploaded artifact
    `voice-real-acoustic-matrix` (artifact ID `7847377997`, SHA256
    `50c4240dee150225030df4d4dd7c958d217f2aad4601ae75095b6afa31b8131b`)
    contains `probe.log` showing `nvcc`, `nvidia-smi`, and `ffmpeg` are not on
    `PATH`, and `ELEVENLABS_API_KEY` is empty on that runner.
- Workflow-dispatch audit after rebasing on current `origin/develop`:
  - `Voice Live E2E` run `28093983203` on branch `fix/finish-9147` executed the
    rebased workflow at commit `8e19477c347971089bfab0ccb3c12f75046c99a3`.
  - `Real fused ASR + optional mixed round-trip (self-hosted)` passed. The probe
    again found no preprovisioned ASR bundle, so the guarded `test:asr:real` and
    `roundtrip:real` steps skipped instead of calling stale scripts.
  - `Real acoustic VAD + diarization + self-voice matrix (self-hosted)` started
    on runner `eliza-runners` with workspace
    `/opt/actions-runner-2/_work/eliza/eliza`, then failed hard in
    `Probe provisioned voice runner` before executing the acoustic matrix.
  - The uploaded `voice-real-acoustic-matrix` artifact (artifact ID
    `7847707091`, SHA256
    `17c2026e386359cddcbcfa88a0b9cc39a0522a930182632d09821df43b7a3205`)
    contains `probe.log` showing `nvcc`, `nvidia-smi`, and `ffmpeg` are not on
    `PATH`, and `ELEVENLABS_API_KEY` is empty on the current runner.

N/A:
- No screenshot/video was captured because this change adds machine-readable
  report/DOM evidence and test enforcement only; it does not alter visible UI
  layout.
- `voice-real-ci-matrix.mjs` and `voice:workbench --real` were not executed
  locally because they require the provisioned self-hosted voice runner, fused
  native library, real GGUF bundle, and ElevenLabs secret. The workflow now runs
  both as part of the uploaded `voice-real-acoustic-matrix` artifact.
