# Evidence for #12536 - Baseline Comparisons

## Code PR

https://github.com/elizaOS/eliza/pull/13213

## Human Follow-Up

https://github.com/elizaOS/eliza/issues/13214

## Agent-Completed Work

- Added a first-class `baseline_comparisons` manifest/report section to the
  meeting transcription proof benchmark.
- Required comparison rows for Otter-style bot transcription, Granola-style
  bot-free capture, Zoom native notes/transcripts, Google Meet/Gemini notes,
  WhisperX + pyannote, NeMo Sortformer, and the current Eliza production
  baseline.
- Required external-product, open-source, and internal-baseline comparison
  types.
- Required comparison stress-condition coverage across meeting/acoustic
  conditions and comparison metrics: WER, CER, DER, JER, cpWER, WDER, speaker
  name accuracy, action-item F1, decision F1, unsupported-claim rate, latency,
  and privacy/capture mode.
- Required `not_run_reason` for skipped systems so unavailable commercial or
  uninstalled open-source baselines are never counted as pass.
- Made the registry scorer reject publishable real reports that omit baseline
  comparisons, omit the current Eliza baseline, or omit an open-source
  run/import.
- Added mocked fixture rows for all seven required baseline comparisons.
- Documented the baseline-comparison contract in the benchmark README, package
  agent guide, and benchmark plan.

## Verification

Commands run on 2026-07-04:

```bash
bun install
```

Result: completed; no intended dependency changes were kept in this PR. The
install synced the repo artifact bundle in the isolated worktree.

```bash
PYTHONPATH=packages/benchmarks/meeting-transcription-proof pytest packages/benchmarks/meeting-transcription-proof/tests -q
```

Result: 30 tests passed.

```bash
pytest packages/benchmarks/tests/test_registry_scores.py -q
```

Result: 8 tests passed.

```bash
python -m py_compile packages/benchmarks/meeting-transcription-proof/elizaos_meeting_transcription_proof/cli.py packages/benchmarks/registry/scores.py packages/benchmarks/meeting-transcription-proof/tests/test_cli.py packages/benchmarks/tests/test_registry_scores.py
```

Result: passed.

```bash
PYTHONPATH=packages/benchmarks/meeting-transcription-proof python -m elizaos_meeting_transcription_proof --lane mocked_plumbing --output /tmp/mtp-smoke-baseline-comparisons-12536
```

Result: completed. The emitted report was manually inspected: kind
`meeting_transcription_proof_report`, `baseline_comparisons` count `7`, one
open-source run/import, score `1.0`, publishable `false`.

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

Result: failed outside this PR in the repo-wide lint lane. The blocking failure
was `@elizaos/plugin-computeruse#lint` on existing non-null assertion
diagnostics in `plugins/plugin-computeruse`. No `plugins/plugin-computeruse`
files are touched by this PR.

## Not Captured By Agent

N/A for real commercial/open-source product proof in this code PR. The follow-up
human issue must capture real or terms-approved imported outputs for any
commercial systems used, at least one real open-source baseline run over the
same meeting/audio scenario as Eliza, baseline artifacts, Eliza artifacts,
metrics JSON, Markdown comparison report, manual review notes, and terms/usage
notes for commercial output imports.
