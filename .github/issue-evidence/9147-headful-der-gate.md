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
- The acoustic matrix job no longer has `continue-on-error: true`; missing real
  evidence is now a red nightly / workflow-dispatch result.

Validation:

```bash
bunx @biomejs/biome check \
  packages/ui/src/voice/voice-selftest/voice-workbench-player.ts \
  packages/ui/src/voice/voice-selftest/VoiceWorkbenchShell.tsx \
  packages/app/test/ui-smoke/voice-workbench-cases.ts \
  packages/benchmarks/voice/voice-real-ci-matrix.mjs \
  packages/benchmarks/voice/CLAUDE.md \
  packages/benchmarks/voice/AGENTS.md \
  packages/benchmarks/voice/README.md

bun run --cwd packages/ui typecheck
bun run --cwd packages/app typecheck

bun run --cwd packages/app test:e2e \
  test/ui-smoke/voice-workbench-diarization.spec.ts --project=chromium

actionlint .github/workflows/voice-live-e2e.yml

bun build packages/benchmarks/voice/voice-real-ci-matrix.mjs \
  --target=bun --outfile=/tmp/voice-real-ci-matrix.js

bun run verify
```

Result:
- Biome: pass.
- `packages/ui` typecheck: pass.
- `packages/app` typecheck: pass.
- Focused Playwright diarization scenario: `1 passed`.
- `actionlint`: pass.
- Benchmark script bundle/syntax build: pass (`1361 modules`).
- Root `bun run verify`: pass (`509 successful, 509 total`).

N/A:
- No screenshot/video was captured because this change adds machine-readable
  report/DOM evidence and test enforcement only; it does not alter visible UI
  layout.
- `voice-real-ci-matrix.mjs` was not executed locally because it requires the
  provisioned self-hosted GPU runner, fused native library, real GGUF bundle,
  and ElevenLabs secret. The workflow now runs it as part of the uploaded
  `voice-real-acoustic-matrix` artifact.
