# `packages/benchmarks`

The elizaOS evaluation suite — 40+ integrated benchmark harnesses spanning agent
autonomy, tool-call correctness, long-horizon reasoning, voice/vision multimodal,
embodied control, onchain trading, and adversarial robustness.

Primarily Python, with several TypeScript/Bun and Rust harnesses. Lives outside
the TypeScript workspace; not an npm package. Each benchmark is self-contained in
its own directory and carries `README.md` + `AGENTS.md` + `CLAUDE.md`.

## How it fits together

| Piece | Role |
| --- | --- |
| `registry/` | Source of truth. `get_benchmark_registry()` defines every benchmark: id, run command, requirements, result locator, scorer. |
| `orchestrator/` | Runs benchmarks from the registry, normalizes results into SQLite/JSON, computes calibration/readiness/leaderboards, serves the viewer. |
| `<benchmark>/` | One directory per benchmark — harness code, data, tests, and docs. |
| `*-adapter/` | Harness bridges (`eliza`, `hermes`, `openclaw`, `smithers`) that let one benchmark run against different agent backends. |
| `*_matrix/`, `app_eval/` | Per-benchmark code-agent comparison adapters, driven dynamically by `orchestrator/code_agent_matrix.py`. |
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
