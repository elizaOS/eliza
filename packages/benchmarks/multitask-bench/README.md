# MultitaskBench

Measures the interference one long-lived agent incurs when it drives **N tasks
at once** versus one at a time. The claim under test is "one agent handling N
tasks" — a single shared agent client per harness driving N interleaved LifeOps
task conversations — not "N agents" (which would be a different claim).

The headline metric is **interference**: mean per-task score at N minus at
N=1, over the identical `(scenario, seed)` pairs both lanes run. A delta of
`0.0` means the shared agent scores each task exactly as well under load as
alone; a negative delta quantifies degradation.

## What it reuses

MultitaskBench is a thin scheduler on top of
[`lifeops-bench`](../lifeops-bench): each task is one LifeOps STATIC scenario
driven through `LifeOpsBenchRunner.run_one`. The sample is a frozen set of 10
STATIC scenarios (5 SMOKE ids + 5 CORE STATIC ids across the remaining domains)
so all eleven LifeOps surfaces are represented and every lane scores the same
world.

## Lanes and waves

Tasks are **batch-presented at t=0** in waves of exactly N: the sample is
sliced `sample[k*N:(k+1)*N]` and each wave runs concurrently. The N=1 lane is
10 sequential single-task waves — the interference baseline. N=5 is two waves;
N=10 is one wave of ten.

## Isolation — disclosed, never erased

| harness  | isolation          | interference means                          |
|----------|--------------------|---------------------------------------------|
| eliza    | `shared_runtime`   | N sessions contend for one `AgentRuntime`   |
| hermes   | `process_per_turn` | shared rate/cost budget only (process-isolated) |
| openclaw | `process_per_turn` | shared rate/cost budget only (process-isolated) |

The eliza lane's per-session usage attribution depends on the
AsyncLocalStorage fix in `packages/lifeops-bench/src/server.ts` (issue #13777
PR 1). Until that is in tree, the eliza live lane is gated behind
`MULTITASK_ELIZA_USAGE_FIX=1`.

## Metrics per lane

`completion_rate`, `mean_task_score`, `throughput_tasks_per_min`,
`turn_latency_ms{p50,p95,max}`, `task_wall_s{p50,p95,max}`,
`cost_usd{total,per_completed_task}`, `tokens{prompt,completion}`,
`starved_tasks` / `starvation_rate` (a task that timed out while a wave peer
completed, or produced zero turns), `fairness_turns_jain` (Jain's index over
per-task turn counts, per wave), and `lifecycle_events` (which orchestration
stages fired, via `orchestrator_lifecycle.events.extract_lifecycle_events`).

The registry scalar score is the `mean_task_score` of the N=10 lane.

## Running

```bash
# Hermetic oracle — no keys. Perfect scores 1.0 with zero interference.
python -m multitask_bench --harness perfect --lanes 1,5,10 --output-dir results

# Live harness (needs CEREBRAS_API_KEY); eliza also needs the server usage fix.
CEREBRAS_API_KEY=... python -m multitask_bench --harness hermes --lanes 1,5,10 \
    --model gemma-4-31b --output-dir results
```

Reports land at `results/multitask_<timestamp>.json`.

## Tests

```bash
pytest packages/benchmarks/multitask-bench/tests -v
```

The suite drives the real scheduler + runner through the frozen sample with the
deterministic Perfect/Wrong oracles (no model, no keys), plus unit coverage for
wave partitioning, Jain math, starvation classification, percentiles, and the
report schema round-trip.
