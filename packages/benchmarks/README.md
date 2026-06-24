# `packages/benchmarks`

The elizaOS evaluation suite — 40+ benchmark harness directories spanning agent
autonomy, tool-call correctness, long-horizon reasoning, voice/vision multimodal,
embodied control, onchain trading, and adversarial robustness.

Primarily Python, with several TypeScript/Bun and Rust harnesses. Lives outside
the TypeScript workspace; not an npm package. Each benchmark is self-contained in
its own directory and carries `README.md` + `AGENTS.md` + `CLAUDE.md`.

> **"Integrated" is not uniform across these directories** (#9475). The "40+"
> counts harness *directories present in the tree*, which is larger than the set
> that actually benchmark Eliza against a live runtime today. The honest
> breakdown:
>
> - **Bridge-wired & real** — route through the `eliza-adapter` (which boots a
>   real `AgentRuntime` + real model plugins and serves `/api/benchmark/message`)
>   or a `_matrix`/extra adapter that imports `ElizaClient` / `ElizaServerManager`:
>   the registry's bridge benchmarks plus the code-agent `_matrix` wrappers
>   (`clawbench_matrix`, `claw_eval_matrix`, `qwen_claw_bench_matrix`,
>   `swe_bench_pro_matrix`, `openclaw_benchmark`) and the runtime adapters
>   `loca-bench`, `compactbench`, `evm`.
> - **Vendored task/dataset directories** consumed *by* those bridges but with no
>   Eliza code inside them (`claw-eval`, `qwen-claw-bench`, `swe-bench-pro`,
>   `swe-bench-multilingual`).
> - **Vendored-but-not-yet-integrated** — present and registry/coverage-tracked or
>   skip-listed, but with no working adapter yet; see each dir's `INTEGRATION.md`
>   (`qwen-web-bench`, `skillsbench`).
> - **Runs in CI** — only a small subset has its own scheduled/gated lane
>   (`memperf`, `lifeops-bench`, `hyperliquid-bench-live`, voice, mobile-resource).
>   The registry-driven orchestrator suite as a whole is **not** scheduled against
>   real models — `python -m benchmarks.orchestrator run` is invoked from CI only
>   by `hyperliquid-bench-live.yml` (one benchmark). Closing that gap (a scheduled
>   orchestrator lane over a core subset) is the main open de-larp task in #9475.
>
> Treat "40+" as the count of vendored harness directories, several deferred or
> integration-pending rather than wired end-to-end. Update this when adapters are
> added or vendored snapshots are dropped.

## How it fits together

| Piece | Role |
| --- | --- |
| `registry/` | Source of truth. `get_benchmark_registry()` defines every benchmark: id, run command, requirements, result locator, scorer. |
| `orchestrator/` | Runs benchmarks from the registry, normalizes results into SQLite/JSON, computes calibration/readiness/leaderboards, serves the viewer. |
| `<benchmark>/` | One directory per benchmark — harness code, data, tests, and docs. |
| `*-adapter/` | Harness bridges (`eliza`, `hermes`, `openclaw`, `smithers`) that let one benchmark run against different agent backends. |
| `*_matrix/`, `app_eval/` | Per-benchmark code-agent comparison adapters, driven dynamically by `orchestrator/code_agent_matrix.py`. |
| `loadperf/`, `memperf/`, `mobile-resource/` | Direct resource/load KPI workbenches with their own CI lanes; not suite-orchestrator adapters. |
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
python -m benchmarks.orchestrator run --all --provider groq --model openai/gpt-oss-120b
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
3. Confirm it appears in `python -m benchmarks.orchestrator list-benchmarks`.

## Docs

User-facing summary: [Benchmarks track page](../docs/tracks/training/benchmarks.mdx).
