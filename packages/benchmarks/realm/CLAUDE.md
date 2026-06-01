# REALM-Bench — Agent Guide

Real-World Planning benchmark: 11 problem types (TSP, VRP, DARP, event
coordination, disaster relief, JSSP) drawn from arXiv:2502.18836. Vendored
upstream task definitions and datasets under `upstream/`. Registered in the
suite registry as `realm`.

## Run

```bash
# Direct — all 11 problems, one instance each, via the eliza TS bridge
python -m benchmarks.realm.cli --max-tasks 1

# Subset of problem types
python -m benchmarks.realm.cli --problems P1 P11

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks realm --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
# Deterministic mock oracle agent, tiny built-in P1 + P11 sample
python -m benchmarks.realm.cli --provider mock --use-sample-tasks

# Full mock run (all vendored instances, mock agent)
python -m benchmarks.realm.cli --provider mock --full-dataset
```

## Test the harness

```bash
# One-time install (from packages/benchmarks/realm/)
pip install -e ".[dev]"

# Run tests (from repo root or packages/benchmarks/)
pytest packages/benchmarks/realm/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | CLI entrypoint (`python -m benchmarks.realm.cli`) |
| `runner.py` | Async execution loop + `_MockREALMAgent` (oracle-based mock) |
| `evaluator.py` | Per-problem extrinsic scoring (quality, optimality, CSR, …) |
| `solvers.py` | OR-Tools oracles: TSP-TW, DARP, JSSP CP-SAT, disaster |
| `dataset.py` | Loader; normalises upstream schema variations |
| `disruption.py` | Mid-run disruption injection for P4/P7/P8/P9/P10 |
| `types.py` | `RealmProblem` (P1–P11), `REALMConfig`, DTOs |
| `plugin/` | Plan-response parsing helpers |
| `upstream/` | Vendored from genglongling/REALM-Bench (datasets + evaluation) |
| `tests/` | pytest suite (smoke, dataset, runner, solver, env-loader) |

## Notes

- Results write to `./benchmark_results/realm/<timestamp>/` (gitignored).
  Result files match `realm-benchmark-*.json`.
- Scored by `_score_from_realm_json` in `registry/scores.py`.
- OR-Tools is optional; install with `pip install "elizaos-benchmarks-realm[ortools]"`
  or pass `--auto-install-ortools`. Without it, P1/P3/P4 use heuristic fallbacks
  and P11 errors unless the instance has an `upper_bound` header.
- Solver wall-clock budget: `--solver-timeout` (default 30 s). Use 120 s for
  large DMU/TA JSSP instances to reach OPTIMAL.
- Upstream reference: <https://github.com/genglongling/REALM-Bench>.
- Full background: [README.md](README.md).
