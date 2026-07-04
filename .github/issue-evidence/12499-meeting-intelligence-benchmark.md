# Evidence for #12499 - Meeting Intelligence Benchmark

## Code PR

https://github.com/elizaOS/eliza/pull/13169

## Human Follow-Up

https://github.com/elizaOS/eliza/issues/13170

## Agent-Completed Work

- Added `generated_artifact_scores` validation to the meeting transcription proof manifest/report contract.
- Added deterministic generated-artifact scoring for summaries, action items, decisions, open questions, memory entities, hallucination rate, omission rate, and source grounding.
- Added mock fixture coverage for all eight generated meeting-intelligence score rows.
- Added registry gating so real product reports cannot publish without the complete generated-artifact score set.
- Documented deterministic, live-model, and manual proof requirements.

## Verification

Commands run on 2026-07-04:

```bash
bun install
```

Result: completed; no intended dependency changes were kept in this PR.

```bash
bun run verify
```

Result: failed in the repo-wide lint lane before reaching this benchmark package. The failing task was `@elizaos/tui#lint`, with existing `lint/suspicious/noControlCharactersInRegex` diagnostics in `packages/tui/src/keys.ts` and `packages/tui/src/terminal.ts`. The same run also reported existing warnings in `@elizaos/security#lint` and `@elizaos/capacitor-llama#lint`. None of those files are touched by this PR.

```bash
pytest packages/benchmarks/meeting-transcription-proof/tests -q
```

Result: 31 focused meeting-transcription-proof tests passed.

```bash
pytest packages/benchmarks/tests/test_registry_scores.py -q
```

Result: 8 registry score tests passed.

```bash
python -m py_compile \
  packages/benchmarks/meeting-transcription-proof/elizaos_meeting_transcription_proof/artifact_scoring.py \
  packages/benchmarks/meeting-transcription-proof/tests/test_artifact_scoring.py
```

Result: passed with no syntax errors.

```bash
PYTHONPATH=packages/benchmarks/meeting-transcription-proof python -m elizaos_meeting_transcription_proof \
  --lane mocked_plumbing \
  --output /tmp/mtp-smoke-generated-artifacts-12499
```

Result: wrote `/tmp/mtp-smoke-generated-artifacts-12499/meeting-transcription-proof-report.json`.

Manual report inspection confirmed:

- `lane`: `mocked_plumbing`
- `publishable`: `false`
- `generated_artifact_scores`: 8 rows
- generated metric values present for `summary_factuality`, `action_item_owner_date`, `decision_extraction`, `open_question_extraction`, `memory_entity_correctness`, `hallucination_rate`, `omission_rate`, and `source_grounding`

## Not Captured By Agent

N/A for live model/product proof in this code PR. The follow-up human issue must capture real meeting product runs, live LLM trajectories, manually reviewed generated artifacts, UI/video evidence, structured backend and frontend logs, and domain artifacts from memory/knowledge writes.
