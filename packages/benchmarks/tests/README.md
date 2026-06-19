# tests — benchmark suite test harness

Pytest tests for the benchmark suite's infrastructure modules. These are unit/integration tests of the tooling itself, not benchmark task executions.

Run from the `packages/benchmarks` root:

```bash
pytest tests/ -v
```

## Files

| File | What it tests |
|------|---------------|
| `test_acceptance_gate.py` | `scripts/acceptance_gate.py` — precheck, Cerebras smoke, lift-over-random gate, trajectory normalization step, and CLI exit codes. Network and subprocess calls are fully mocked. |
| `test_agent_install.py` | `lib/agent_install.py` — openclaw npm install/idempotency/force-reinstall, Hermes git+venv install, manifest read/write, verify-only CLI path. All subprocess calls are mocked. |
| `test_compare.py` | `benchmarks/compare.py` — suite resolution, endpoint parsing, noise-threshold pass/fail semantics, `ResultsStore` persistence, report serialisation, and CLI plumbing. Uses a canned `BenchmarkRunCallable` — no real network calls. |
| `test_random_baseline.py` | `lib/random_baseline.py` — strategy registry, per-kind random-response generators (multiple-choice, function-call, empty-patch, trajectory, freeform), lift math, and CLI subcommands. |
| `test_random_baseline_harness.py` | `orchestrator/random_baseline_runner.py` + `orchestrator/compare_vs_random.py` — in-process synthesizer output shape, SQLite-backed compare-vs-random lift check (seeds a real DB via `tmp_path`), and CLI dispatch wiring. |
| `test_registry_scores.py` | `registry/scores.py` — validation rules for Hermes env JSON (placeholder-only rejection, incomplete-rollout rejection, mixed-metric acceptance). |
| `test_runner_normalization.py` | `orchestrator/trajectory_normalize_hook.py` — per-harness canonical JSONL output for eliza, openclaw, and hermes; unchanged output on unknown artifacts; corrupt-input resilience. |
| `test_trajectory_normalizer.py` | `lib/trajectory_normalizer.py` — `CanonicalEntry` schema, normalizers for all three harness formats, `align_by_step`, JSON compactness, and the `normalize`/`diff` CLI subcommands (invoked as a subprocess). |
