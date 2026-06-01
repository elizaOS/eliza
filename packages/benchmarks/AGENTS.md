# Benchmarks — Agent Guide

The elizaOS evaluation suite. The **registry** declares every benchmark; the
**orchestrator** runs them; each benchmark lives in its own directory with its
own `README.md` / `AGENTS.md` / `CLAUDE.md`.

## Layout

```
registry/        Canonical benchmark definitions (id, command, requirements, scorer)
orchestrator/    Runner: executes registry benchmarks, normalizes results, viewer, gates
framework/ lib/  Shared harness framework + helpers
standard/        MMLU / HumanEval / GSM8K / MT-Bench adapters (dispatched by run.py)
viewer/          Static results UI
tests/           Suite-level tests (registry, scoring, normalization, acceptance gate)
*-adapter/       Agent harness bridges: eliza / hermes / openclaw / smithers
*_matrix/ app_eval/  Code-agent comparison adapters (driven by orchestrator/code_agent_matrix.py)
<benchmark>/     One self-contained benchmark per directory
benchmark_results/   Generated run output — GITIGNORED, never commit
```

## Run a benchmark

```bash
# List integrated benchmarks + adapter coverage
python -m benchmarks.orchestrator list-benchmarks

# Run one (idempotent: skips already-successful signatures)
python -m benchmarks.orchestrator run --benchmarks <id> --provider <p> --model <m>

# Run all
python -m benchmarks.orchestrator run --all --provider groq --model openai/gpt-oss-120b
```

`--rerun-failed` reruns only failed signatures; `--force` always makes a fresh
run; `--extra '<json>'` passes benchmark-specific options. Each benchmark's own
`AGENTS.md` documents the direct (non-orchestrator) command and a no-key
smoke/mock path.

## Test the harnesses

```bash
pytest tests/ -v                                   # suite-level
pytest <benchmark>/.../tests/ -v                   # one benchmark (see its AGENTS.md)
```

TypeScript/Bun benchmarks (`eliza-1`, `vision-language`, `configbench`,
`interrupt-bench`, `personality-bench`, `three-agent-dialogue`) test with
`bun test`; Rust components (HyperliquidBench runner) with `cargo test`.

## Conventions

- **One directory per benchmark.** All of a benchmark's code, data, tests, and
  docs live under its directory. Don't scatter benchmark code into shared dirs.
- **The registry is the source of truth.** A benchmark is "integrated" only when
  it has an entry in `registry/commands.py` and a scorer in `registry/scores.py`.
  Some directories are run-only / experimental and not yet registered — their
  `AGENTS.md` says so.
- **Results are generated, not committed.** Anything under `benchmark_results/`
  (and per-benchmark run output) is gitignored. Never commit result JSON, SQLite
  DBs, trajectories, logs, or coverage.
- **Every benchmark carries all three docs.** `README.md` (overview),
  `AGENTS.md` (how to run + smoke + test), `CLAUDE.md` (pointer to AGENTS.md).

## Add a benchmark

1. Create `<your-benchmark>/` (harness + tests + three docs).
2. Add a `BenchmarkDefinition` in `registry/commands.py` and a `_score_from_*`
   in `registry/scores.py`.
3. Verify with `python -m benchmarks.orchestrator list-benchmarks`.

Operator runbook (remote GPU, calibration/readiness gates, code-agent matrix):
[`ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md`](ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md),
[`orchestrator/README.md`](orchestrator/README.md).
