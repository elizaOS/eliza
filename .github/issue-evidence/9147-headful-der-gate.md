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

Validation:

```bash
bunx @biomejs/biome check \
  packages/ui/src/voice/voice-selftest/voice-workbench-player.ts \
  packages/ui/src/voice/voice-selftest/VoiceWorkbenchShell.tsx \
  packages/app/test/ui-smoke/voice-workbench-cases.ts

bun run --cwd packages/ui typecheck
bun run --cwd packages/app typecheck

bun run --cwd packages/app test:e2e \
  test/ui-smoke/voice-workbench-diarization.spec.ts --project=chromium
```

Result:
- Biome: pass.
- `packages/ui` typecheck: pass.
- `packages/app` typecheck: pass.
- Focused Playwright diarization scenario: `1 passed`.

N/A:
- No screenshot/video was captured because this change adds machine-readable
  report/DOM evidence and test enforcement only; it does not alter visible UI
  layout.
- Real acoustic GGUF execution remains covered by the existing
  `voice-live-e2e.yml` matrix and prior `9147-real-audio-matrix-m4max.md`
  evidence.
