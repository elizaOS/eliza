# Framework Benchmark — Agent Guide

Measures the overhead of the elizaOS framework itself: a TypeScript (Bun)
harness drives a real `AgentRuntime` with a deterministic mock-LLM plugin and
in-memory DB, reporting latency, throughput, pipeline breakdown, memory, and
startup across 20 scenarios. A Python cross-harness runner
(`scripts/harness_runner.py`) replays the same scenario fixtures against real
Eliza / Hermes / OpenClaw clients. Exposed to the suite orchestrator as the
`framework` adapter (public adapter, not a registry entry).

## Run

```bash
# Wrapper — install/build checks, TypeScript harness, comparison report
cd framework
./run.sh                 # default scenarios
./run.sh --all           # all 20 scenarios (includes stress tests)
./run.sh --scenarios=single-message,burst-100,startup-cold
./run.sh --compare       # comparison report only, from existing results/

# TypeScript harness directly (from the REPO ROOT — needs the workspace install)
bun run framework/typescript/src/bench.ts --scenarios=single-message

# Real-LLM mode (end-to-end sanity, NOT overhead measurement); needs
# OPENAI_API_KEY or CEREBRAS_API_KEY
bun run framework/typescript/src/bench.ts --real-llm

# Through the suite orchestrator (mode=harness replays fixtures against a real
# agent-harness client; mode=typescript runs the local mock-LLM harness)
python -m benchmarks.orchestrator run --benchmarks framework --provider <p> --model <m>
python -m benchmarks.orchestrator run --benchmarks framework --provider <p> --model <m> \
  --extra '{"mode": "typescript", "flags": "--scenarios=single-message"}'
```

## Smoke test (no API keys)

The default TypeScript harness uses the deterministic mock-LLM plugin and the
in-memory SQLite adapter — no keys, no network, no disk. This is the no-key smoke
path:

```bash
bun run framework/typescript/src/bench.ts \
  --scenarios=single-message --output=/tmp/framework-smoke.json
```

Expect a scenario summary (latency/throughput/memory/pipeline) on stdout and a
result JSON at `--output`.

## Test the harness

There is no dedicated test suite; the mock-LLM smoke run above is the
functional check. Static checks via the harness package scripts:

```bash
cd framework/typescript
bun run typecheck        # tsc --noEmit
bun run lint:check       # biome
bun run check            # typecheck + lint + format check
```

## Layout

| Path | Role |
| --- | --- |
| `run.sh` | Wrapper: workspace/core-build checks, TS harness, comparison report |
| `typescript/src/bench.ts` | Benchmark harness (scenario loop, flags, result JSON) |
| `typescript/src/mock-llm-plugin.ts` | Deterministic mock handlers for `TEXT_SMALL/LARGE/EMBEDDING/COMPLETION` + dummy providers |
| `typescript/src/metrics.ts` | Latency/throughput stats, RSS monitor, pipeline timer |
| `scripts/harness_runner.py` | Cross-harness runner over the shared fixtures (eliza / hermes / openclaw adapters) |
| `shared/scenarios.json` | 20 scenario fixtures shared by both runners |
| `shared/character.json` | Benchmark agent character |
| `compare.ts` | Side-by-side comparison of result JSON files |
| `visualize.py` | ASCII charts / summary tables from `results/` |
| `results/` | Timestamped result JSON (gitignored) |

## Notes

- The orchestrator adapter (`orchestrator/adapters.py`, `_command_framework`)
  defaults to `mode=harness` with `scenarios=single-message`; scored by
  `_score_from_framework` from `framework-results.json`. CI lane: `smoke`
  (`orchestrator/ci_coverage.py`).
- Mock-mode numbers measure framework overhead only; `--real-llm` results
  include network/model latency and must not be compared against them.
- `--ts-only` / `--py-only` / `--rs-only` are relics of the removed
  multi-runtime (Python/Rust) comparison and exit with an error.
- Harness-runner env knobs: `FRAMEWORK_HARNESS_TIMEOUT_S`,
  `FRAMEWORK_OPENCLAW_THINKING`, `ELIZA_BENCH_URL` + `ELIZA_BENCH_TOKEN`
  (reuse a running Eliza server instead of spawning one).
- Full background: [README.md](README.md).

