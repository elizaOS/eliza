# Issue #11374 — RESULTS_MATRIX registry sync test

## Result

Added an offline pytest guard that pins
`packages/benchmarks/docs/RESULTS_MATRIX.md` to the live benchmark registry,
adapter discovery, CI lane classification, and the certified numeric score rows
in `CERTIFICATION.md`.

## Human-reviewed evidence

- `python3 -m pytest packages/benchmarks/tests/test_results_matrix_sync.py -q`
  - Passed: 4 tests.
  - Guards registered rows/counts, registered lanes, certified numeric score
    provenance, adapter-only rows/counts, adapter-only lanes, and adapter-only
    non-score cells.
- `python3 -m pytest packages/benchmarks/tests/test_ci_coverage.py packages/benchmarks/tests/test_results_matrix_sync.py -q`
  - Passed: 11 tests.
- Drift proof with a temporary local edit:
  - Removed the registered `bfcl` row from `RESULTS_MATRIX.md`.
  - `python3 -m pytest packages/benchmarks/tests/test_results_matrix_sync.py -q`
    failed as expected with `Extra items in the right set: 'bfcl'`.
  - Restored `RESULTS_MATRIX.md` and reran the test successfully.
- Domain artifact reviewed:
  - `python3 -m benchmarks.orchestrator list-benchmarks`
  - Reported `Total adapters: 53`, `Total benchmark dirs: 43`, and `All benchmark directories are covered by adapters.`
  - Direct registry/discovery count check reported `registry=44 adapters=53 adapter_only=9`.
  - Adapter-only ids reviewed: `adhdbench`, `app-eval`, `eliza_1`,
    `eliza_replay`, `experience`, `framework`, `interrupt_bench`,
    `personality_bench`, `three_agent_dialogue`.

## Validation gaps / non-applicable artifacts

- No new real-model benchmark run: this change does not alter a benchmark
  harness, scorer, prompt, model call, or recorded score. It adds an offline
  consistency gate over committed registry/docs/certification artifacts.
- No screenshots or video: documentation/test-only backend benchmark metadata
  guard; no UI surface changed.
- `bun run verify` is blocked before typecheck/lint by unrelated repo-wide
  type-safety ratchet drift:
  - `as unknown as`: `80 current > 77 baseline`.
  - ``?? {}`` in core/agent/app-core: `379 current > 377 baseline`.
