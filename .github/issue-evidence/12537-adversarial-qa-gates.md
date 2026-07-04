# Evidence for #12537 - Adversarial Fuzz and QA Gates

## Code PR

https://github.com/elizaOS/eliza/pull/13219

## Human Follow-Up

https://github.com/elizaOS/eliza/issues/13220

## Agent-Completed Work

- Added `adversarial_cases` to the meeting transcription proof manifest/report.
- Required adversarial scenario classes for overlapping similar voices,
  duplicate display names, borrowed-laptop identity, transcript prompt
  injection, side conversations, sarcastic/negated action items,
  music/noise false VAD, bot removal or permission revocation, audio deletion
  with transcript retention, and malformed artifact shapes.
- Required fuzz targets for canonical artifact schema, transcript span
  alignment, RTTM/diarization segments, speaker profile lifecycle,
  capture-source state machine, ASR media references, meeting-note grounding,
  and importer response shapes.
- Required deterministic fuzz seeds, expected invariants, evidence, metrics, and
  failure policies for every adversarial case.
- Added `qa_review_checklist` rows with machine-readable verdicts for
  permission denied, capture stopped, speaker correction, delete audio, and
  share/privacy state.
- Made the registry scorer reject publishable real reports that omit
  adversarial cases or QA checklist verdicts.
- Added mocked fixture rows and docs for the adversarial/fuzz and QA contract.

## Verification

Commands run on 2026-07-04:

```bash
bun install
```

Result: completed after rebasing onto current `origin/develop`; artifact sync
was already current at `2026-06-18.1`. Local Bun reordered `bun.lock`, which was
restored because no dependency change is part of this issue.

```bash
PYTHONPATH=packages/benchmarks/meeting-transcription-proof pytest packages/benchmarks/meeting-transcription-proof/tests -q
```

Result: 32 tests passed.

```bash
pytest packages/benchmarks/tests/test_registry_scores.py -q
```

Result: 8 tests passed.

```bash
python -m py_compile packages/benchmarks/meeting-transcription-proof/elizaos_meeting_transcription_proof/cli.py packages/benchmarks/registry/scores.py packages/benchmarks/meeting-transcription-proof/tests/test_cli.py packages/benchmarks/tests/test_registry_scores.py
```

Result: passed.

```bash
PYTHONPATH=packages/benchmarks/meeting-transcription-proof python -m elizaos_meeting_transcription_proof --lane mocked_plumbing --output /tmp/mtp-smoke-adversarial-qa-12537-current
```

Result: completed. The emitted report was manually inspected: kind
`meeting_transcription_proof_report`, `adversarial_cases` count `10`, fuzz
target count `8`, `qa_review_checklist` count `5`, score `1.0`, publishable
`false`.

```bash
bun run --cwd packages/docs test
```

Result: 15 tests passed.

```bash
bun run --cwd packages/docs lint:check
```

Result: passed.

```bash
bun run verify
```

Result: failed outside this PR in `@elizaos/plugin-computeruse#lint`. The
reported diagnostics were pre-existing non-null assertion violations, including
`plugins/plugin-computeruse/src/__tests__/scene-builder.test.ts:146`,
`plugins/plugin-computeruse/src/__tests__/scene-multimon-coords.test.ts:52`,
`plugins/plugin-computeruse/src/__tests__/screen-state.test.ts:136`, and
`plugins/plugin-computeruse/src/actor/brain.ts:276`. Biome auto-fixes in
unrelated packages were restored before publishing this branch.

## Not Captured By Agent

N/A for live model trajectories and headful QA evidence in this code PR. The
follow-up human issue must capture live-model scenario-runner reports and native
JSONL trajectories for notes/action-item adversarial cases, headful screenshots
and video for permission denied/capture stopped/correction/delete/share flows,
frontend/backend/network logs, reviewed manual QA checklist output, and real
artifact links.
