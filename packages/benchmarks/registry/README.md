# Benchmark Registry

Source-of-truth catalogue of every benchmark the elizaOS benchmark suite can run. The orchestrator and scoring pipeline read this package; nothing else should need to touch it.

## Files

| File | Purpose |
|---|---|
| `commands.py` | `get_benchmark_registry(repo_root)` — returns `list[BenchmarkDefinition]`, one entry per benchmark. Each definition holds the benchmark `id`, a `build_command` callable that assembles the subprocess argv from a `ModelSpec` + `extra` dict, and a `locate_result` callable that finds the output JSON. Also exports `load_benchmark_result_json`. |
| `scores.py` | One `_score_from_<id>_json(data)` extractor per benchmark. Each reads the raw result JSON and returns a `ScoreExtraction` (primary score, unit, `higher_is_better`, named metrics dict). |
| `__init__.py` | Re-exports all public names from both modules so callers can do `from benchmarks.registry import get_benchmark_registry` or, with `benchmarks/` on `sys.path`, `from registry import get_benchmark_registry`. |
| `_monolith.py` | Shim that loads a legacy flat `registry.py` file via `importlib` when it is present. Not used in normal operation; kept for backward compatibility with older checkouts that still have the monolithic file. |

## Who consumes this

- `orchestrator/adapters.py` — calls `get_benchmark_registry(workspace_root)` to enumerate runnable benchmarks and build subprocess commands.
- `orchestrator/scoring.py` — calls `get_benchmark_registry` and `load_benchmark_result_json`, then dispatches to the appropriate `_score_from_*` extractor.
- `scripts/acceptance_gate.py` — reads scored results using the same two entry points.

For suite-level conventions, orchestrator flags, and how to add a new benchmark, see `../AGENTS.md`.
