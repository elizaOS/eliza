# `packages/benchmarks`

The elizaOS evaluation suite — **44 registered benchmarks** (the canonical set in
`registry/commands.py`; 53 publicly runnable once adapter-only ids are counted)
spanning agent autonomy, tool-call correctness,
long-horizon reasoning, voice/vision multimodal, embodied control, onchain
trading, and adversarial robustness, plus shared agent-harness adapters.

Primarily Python, with several TypeScript/Bun and Rust harnesses. Lives outside
the TypeScript workspace; not an npm package. Each benchmark is self-contained in
its own directory and carries `README.md` + `AGENTS.md` + `CLAUDE.md`.

> **Honest coverage breakdown (#9475).** "Registered" does not mean "runs in CI
> on a real model." The de-larp pass (#9475) deleted the directories that never
> benchmarked Eliza (no `@elizaos` wiring, no registry entry): the vendored
> upstreams `claw-eval` / `qwen-claw-bench` / `swe-bench-pro` /
> `swe-bench-multilingual` / `loca-bench`, the `qwen-web-bench` stub, the
> compactor-strategy harness `compactbench`, the abandoned `evm`, and the
> import-shim / dup matrix adapters (`app_eval`, `clawbench_matrix`,
> `claw_eval_matrix`, `qwen_claw_bench_matrix`, `swe_bench_pro_matrix`,
> `openclaw_benchmark`). What remains is classified explicitly:
>
> - **Registered** — 44 benchmarks in `registry/commands.py`.
> - **Bridge-wired & real** — ~25 route through the `eliza-adapter` (which boots
>   a real `AgentRuntime` + real model plugins and serves
>   `/api/benchmark/message`) on their default/real path.
> - **CI lane** — every registered benchmark now carries an explicit CI lane in
>   `orchestrator/ci_coverage.py` (`tests/test_ci_coverage.py` keeps it 1:1 with
>   the registry, so no benchmark silently has zero coverage):
>   - `scheduled` — a core real-model subset (`bfcl`, `action-calling`,
>     `agentbench`, `tau_bench`, `mint`, `context_bench`) runs weekly via
>     `.github/workflows/benchmark-orchestrator-scheduled.yml`; `hyperliquid_bench`
>     and `lifeops_bench` have their own dedicated live lanes.
>   - `smoke` — has a no-key mock/sample path exercisable in CI.
>   - `manual` — live-gated / Docker / sandbox / real-audio; run on demand
>     (`workflow_dispatch` / operator runbook), never silently.
>
> Keep this section and `orchestrator/ci_coverage.py` in sync when adapters are
> added or benchmarks are dropped.

## How it fits together

| Piece | Role |
| --- | --- |
| `registry/` | Source of truth. `get_benchmark_registry()` defines every benchmark: id, run command, requirements, result locator, scorer. |
| `orchestrator/` | Runs benchmarks from the registry, normalizes results into SQLite/JSON, computes calibration/readiness/leaderboards, serves the viewer. |
| `<benchmark>/` | One directory per benchmark — harness code, data, tests, and docs. |
| `*-adapter/` | Harness bridges (`eliza`, `hermes`, `openclaw`, `smithers`) that let one benchmark run against different agent backends. |
| `agentbench_matrix/` | Code-agent comparison adapter for the real `agentbench`, driven by `orchestrator/code_agent_matrix.py`. (The dup `*_matrix` / import-shim variants for vendored sources were removed in #9475.) |
| `loadperf/`, `memperf/`, `mobile-resource/`, `view-bundle-size/` | Direct resource/load/bundle KPI workbenches with their own CI lanes; not suite-orchestrator adapters. |
| `framework/`, `lib/`, `standard/` | Shared harness framework, helpers, and the standard academic adapters (MMLU, HumanEval, GSM8K, MT-Bench, dispatched by `run.py`). |
| `viewer/` | Static browser UI for inspecting normalized results. |
| `tests/` | Suite-level tests (registry scores, runner normalization, acceptance gate, …). |

## Running

List everything the registry knows about and verify adapter coverage:

```bash
python -m benchmarks.orchestrator list-benchmarks
```

Run one benchmark (idempotent — successful signatures are skipped):

```bash
python -m benchmarks.orchestrator run --benchmarks <id> --provider <p> --model <m>
```

Run the whole suite:

```bash
python -m benchmarks.orchestrator run --all --provider cerebras --model gemma-4-31b
```

Each benchmark can also be run directly from its own directory — see that
benchmark's `AGENTS.md` for the exact command and a no-key smoke path.

Use your workspace Python so dependency versions stay consistent across
benchmark subprocesses. Full operator runbook (remote GPU, sub-agent matrix,
calibration gates): [`ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md`](ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md)
and [`orchestrator/README.md`](orchestrator/README.md).

## Testing the harnesses

```bash
# Suite-level tests (registry, scoring, normalization, acceptance gate)
pytest tests/ -v

# A single benchmark's tests — see its AGENTS.md for the exact path, e.g.
pytest rlm-bench/elizaos_rlm_bench/tests/ -v
```

## Results

Run output (per-task traces, scorecards, the orchestrator SQLite DB, and viewer
data) lands under `benchmark_results/` and is **gitignored** — it is generated,
never committed. Inspect history with:

```bash
python -m benchmarks.orchestrator serve-viewer
```

## Adding a benchmark

1. Create `<your-benchmark>/` with the harness, tests, and the three docs.
2. Register it in `registry/commands.py` (id, `build_command`, `locate_result`,
   `requirements`) and add a scorer in `registry/scores.py`.
3. Classify its CI lane in `orchestrator/ci_coverage.py` (`scheduled` / `smoke`
   / `manual`) — `tests/test_ci_coverage.py` fails until you do (#9475).
4. Confirm it appears in `python -m benchmarks.orchestrator list-benchmarks`.

## Docs

User-facing summary: [Benchmarks track page](../docs/tracks/training/benchmarks.mdx).
