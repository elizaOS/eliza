# REALM-Bench (elizaOS implementation)

A paper-faithful implementation of REALM-Bench — a benchmark for LLM
and multi-agent **planning** across 11 real-world scenarios:

> **REALM-Bench: A Real-World Planning Benchmark for LLMs and Multi-Agent Systems**
> Geng et al., 2025. arXiv [2502.18836](https://arxiv.org/abs/2502.18836)
> Upstream: <https://github.com/genglongling/REALM-Bench>

Upstream task definitions, instance datasets (P1–P10 JSON, P11 JSSP
text), and the canonical six-metric framework are vendored under
[`upstream/`](upstream/) (see [`upstream/ATTRIBUTION.md`](upstream/ATTRIBUTION.md)).

## What's evaluated

The 11 canonical problem types from the paper:

| ID  | Name                                | Family            | Multi-agent | Disruptions |
|-----|-------------------------------------|-------------------|-------------|-------------|
| P1  | Single-Agent Campus Tour            | TSP with time windows | -       | -           |
| P2  | Multi-Group Campus Tours            | VRP-TW             | yes        | -           |
| P3  | Urban Ride-Sharing                  | DARP               | yes        | -           |
| P4  | URS with Disruptions                | DARP               | yes        | yes         |
| P5  | Wedding Logistics                   | Event coordination | yes        | -           |
| P6  | Thanksgiving Dinner                 | Event coordination | yes        | -           |
| P7  | Disaster Relief Deployment          | Priority allocation| yes        | yes         |
| P8  | Wedding Logistics + Disruptions     | Event coordination | yes        | yes         |
| P9  | Thanksgiving + Disruptions          | Event coordination | yes        | yes         |
| P10 | Global GPU Supply Chain             | Industrial planning| yes        | yes         |
| P11 | Job Shop Scheduling (JSSP)          | Combinatorial      | -           | -           |

The problem taxonomy lives in `benchmarks.realm.types.RealmProblem`. The
back-compat alias `REALMCategory = RealmProblem` is also exported.

## Scoring

The previous implementation set-intersected agent action names against a
hardcoded `expected.actions` list and used the agent-reported
`plan_quality_score` (circular — the agent grades itself). That's all
removed. Each task is now scored extrinsically:

- **Planning Quality** — fraction of expected entities served / visited
  (locations, passengers, errands, cooking tasks, …).
- **Planning Optimality** — `oracle_cost / agent_cost` from an
  **independent** OR-Tools solver. Per-problem solver / expected
  optimality:
  - **TSP-TW (P1)**: OR-Tools `RoutingModel` with a `Time` dimension.
    Provably optimal for paper-sized instances within the solver
    budget (default 30s); GLS-improved feasible otherwise.
  - **VRP-TW (P2)**: coverage-based score (no oracle solve).
  - **DARP / CVRP-TW (P3/P4)**: OR-Tools `RoutingModel` with pickup-
    delivery pairs, capacity dimension, time-window cumul, and
    disjunction penalties for unservable requests. Near-optimal for
    paper-sized instances; greedy fallback (logged) on
    infeasibility or timeout.
  - **Disaster (P7)**: closed-form severity-weighted coverage. Exact.
  - **JSSP (P11)**: OR-Tools CP-SAT `NoOverlap` + interval makespan
    minimisation. Provably optimal within `--solver-timeout` for
    small instances; FEASIBLE within budget on the largest DMU/TA.
    Oracle is the *tighter* of CP-SAT and the upstream
    `upper_bound` header (Taillard / DMU).
- **Constraint Satisfaction Rate** — fraction of declared constraints
  satisfied (time windows, deadlines, capacity, budget, …).
- **Coordination** — for multi-agent tasks: fraction of expected agents
  active in the agent's solution.
- **Resource Usage** — measured wall-clock `planning_time_ms` /
  `execution_time_ms` (replaces the old `0.25 * total` estimate).
- **Adaptation to Disruption** — for P4/P7/P8/P9/P10 the runner injects
  the first declared disruption mid-run, re-prompts the agent, and
  records whether the replanned solution stays feasible.

## Agent contract

The agent's `solve_task(task, test_case)` must return a
`PlanningTrajectory` whose `solution` dict is shaped per the problem
family. Example shapes:

| Problem | `solution` shape                                                                |
|---------|----------------------------------------------------------------------------------|
| P1      | `{"route": ["entrance", "library", ..., "entrance"]}`                            |
| P2      | `{"assignments": {"guide1": [{"group": "g1", "start": 10}, ...], ...}}`          |
| P3/P4   | `{"assignments": {"vehicle1": ["pickup:p1", "dropoff:p1", "pickup:p2", ...]}}`   |
| P5/P6/8/9 | `{"pickups": [...], "errands_done": [...], "cooking_schedule": [...]}`        |
| P7      | `{"allocations": {"region1": {"food": 500, "water": 200}, ...}}`                 |
| P10     | `{"orders": [{"component": "gpu_chips", "cost": 100, "eta": 25}, ...]}`          |
| P11     | `{"sequence": [[1, 0, 2, ...], [...]]}` — one job-index permutation per machine |

The `_MockREALMAgent` (in `runner.py`) emits these shapes from the
built-in oracles and is what `--provider mock` uses for smoke tests.

The default eliza-adapter agent (`ElizaREALMAgent`) drives the loop
via the eliza TS bridge (`GENERATE_PLAN` / `EXECUTE_STEP` /
`ADAPT_PLAN` / `COMPLETE_TASK`) and surfaces a `solution` payload from
`response.params["solution"]` or a JSON message on `COMPLETE_TASK`.

## CLI

```bash
# All 11 problems, one instance each, against the eliza TS bridge
python -m benchmarks.realm.cli --max-tasks 1

# Subset (paper IDs)
python -m benchmarks.realm.cli --problems P1 P11

# Deterministic smoke run with the mock oracle agent
python -m benchmarks.realm.cli --provider mock --max-tasks 1

# Tiny built-in P1 + P11 sample (no upstream needed)
python -m benchmarks.realm.cli --provider mock --use-sample-tasks

# Load every vendored instance instead of the default cap
python -m benchmarks.realm.cli --provider mock --full-dataset

# Export per-task trajectories alongside the benchmark report
python -m benchmarks.realm.cli --provider mock --use-sample-tasks --export-trajectories
```

## OR-Tools dependency

OR-Tools (`ortools >= 9.5, < 10.0`) is an optional runtime dependency.
Importing `benchmarks.realm.solvers` does not require it. Solver calls
that need CP-SAT or `RoutingModel` load it lazily.

```bash
pip install "elizaos-benchmarks-realm[ortools]"
```

For CLI runs, `--auto-install-ortools` installs OR-Tools into an
isolated user-cache venv for the current Python version and adds that
venv's site-packages to `sys.path` for the process. This does not modify
the active environment. The same behavior can be enabled with
`REALM_AUTO_INSTALL_ORTOOLS=1`; use `REALM_ORTOOLS_CACHE_DIR` to choose
the cache directory.

Without OR-Tools, P1 and P3/P4 use local fallback heuristics and log a
warning. P11 uses an explicit upstream `upper_bound` when the instance
provides one; otherwise the JSSP oracle raises a clear runtime error
explaining how to install or enable OR-Tools.

### Solver budget

CP-SAT and `RoutingModel` run with a configurable wall-clock budget per
instance via `--solver-timeout` (default 30s) or
`REALMConfig(solver_timeout_s=...)`. Tests use 2–5s; full DMU/TA JSSP
runs may want `--solver-timeout 120` for OPTIMAL on the largest.

### Dataset size controls

The loader caps upstream instances to 5 per problem by default so smoke
runs stay cheap. Use `--max-instances-per-problem N` to load a larger
per-problem pool, `--max-tasks N` to run at most `N` cases per problem,
or `--full-dataset` to load all vendored instances before filtering.

## Tests

```bash
pytest packages/benchmarks/realm/
```

`test_runner_report_validation.py::test_sample_smoke_run_reports_makespan_and_optimality`
asserts that an end-to-end run of P1 + P11 with the mock oracle agent
produces a real makespan and a meaningful optimality ratio (1.0 for
the sample P1 where the brute-force oracle is exact; > 0 for P11 with
the FIFO sequence vs. the LB).

## Leaderboard

The previous file shipped fabricated per-category "GPT-4 / Claude-3 /
…" overall percentages that don't appear anywhere in the paper. Those
are removed.

The only headline numbers we keep are the P11 / JSSP "gap to upper
bound (%)" entries from the upstream README — see
`LEADERBOARD_SCORES` and `LEADERBOARD_NOTE` in `types.py`. The full
per-problem leaderboard lives upstream:
<https://github.com/genglongling/REALM-Bench>.

## File layout

```
realm/
  upstream/                # Vendored from genglongling/REALM-Bench
    evaluation/            # task_definitions.py, metrics.py, evaluator.py
    datasets/              # P1..P10 JSON + P11 JSSP text
    ATTRIBUTION.md
  types.py                 # RealmProblem (P1..P11) + dataclasses
  dataset.py               # Loader; normalises upstream schema variations
  solvers.py               # JSSP / TSP-TW / DARP / disaster oracles
  evaluator.py             # Per-problem extrinsic scoring
  disruption.py            # Disruption injection for P4/P7/P8/P9/P10
  runner.py                # Wall-time-measured runner + mock oracle agent
  cli.py                   # Command-line interface
  plugin/                  # Plan-response parsing helpers
  tests/                   # Smoke tests + dataset / runner invariants
```

## Limitations / stubs

- **Event coordination (P5/6/8/9)** has no closed-form oracle. We
  score on coverage of the upstream-declared `guests`, `errands`,
  `cooking_tasks` plus deadline respect. The paper itself does not
  publish a numeric oracle for these scenarios.
- **Supply chain (P10)** scoring uses on-time delivery count, total
  cost, and budget compliance. A full MIP oracle is not implemented.
- **Multi-agent** support is currently single-process: the runner
  prompts the eliza agent once with the problem context and reads the
  full N-vehicle / N-guide solution back. Distributed multi-agent
  orchestration (one eliza agent per vehicle) is a future extension.
