# Eliza Framework Benchmark

Performance benchmark for the elizaOS agent framework itself, running the
**TypeScript** runtime (Bun). Formerly a multi-runtime (TS/Python/Rust)
comparison; only the TypeScript runtime remains.

## What It Measures

By replacing the real LLM with a deterministic mock plugin that returns
instant, fixed responses, this benchmark isolates and measures the
**framework itself**:

- **Latency**: End-to-end message processing time (min/avg/median/p95/p99)
- **Throughput**: Messages per second (sequential and concurrent)
- **Pipeline breakdown**: Time in state composition, provider execution, model calls, action dispatch, evaluators, memory CRUD
- **Resource usage**: RSS memory (start/peak/delta)
- **Scaling behavior**: Performance vs provider count, conversation history size, concurrent load
- **Startup time**: Agent creation and initialization
- **DB throughput**: In-memory database read/write operations per second

## Quick Start

```bash
# Run default scenarios
./run.sh

# Run all scenarios (including stress tests)
./run.sh --all

# Run specific scenarios
./run.sh --scenarios=single-message,burst-100,startup-cold

# Just generate comparison from existing results
./run.sh --compare
```

`run.sh` ensures the workspace is installed and `@elizaos/core` is built, runs
the TypeScript harness, then generates the comparison report. The historical
`--ts-only` / `--py-only` / `--rs-only` flags exit with an error.

## TypeScript harness (direct)

Run from the **repo root** (the harness resolves `@elizaos/core` via the
workspace install):

```bash
bun run packages/benchmarks/framework/typescript/src/bench.ts
bun run packages/benchmarks/framework/typescript/src/bench.ts --all
bun run packages/benchmarks/framework/typescript/src/bench.ts --scenarios=single-message,startup-cold
```

Or use the package scripts in `typescript/package.json`: `bench`,
`bench:quick`, `bench:full`, `bench:real-llm`, `bench:real-llm:quick`.

### Real-LLM mode

`--real-llm` swaps the mock for a live model — useful for end-to-end sanity,
**not** for framework-overhead measurement (results include network/model
latency). Two routes, checked in order:

1. **CLI subscription**: `ELIZA_CHAT_VIA_CLI=claude|claude-sdk|codex|codex-sdk`
   loads `@elizaos/plugin-cli-inference` (works best with
   `ELIZA_PLANNER_NATIVE_TOOLS=0`).
2. **API key**: `OPENAI_API_KEY` or `CEREBRAS_API_KEY` loads
   `@elizaos/plugin-openai` (Cerebras via its OpenAI-compatible endpoint).

## Comparison Report

After running benchmarks, generate a side-by-side comparison of result files:

```bash
bun run compare.ts
```

`visualize.py` renders ASCII charts and summary tables from the same
`results/` JSON.

## Orchestrator integration

The suite orchestrator exposes this directory as the `framework` adapter
(`orchestrator/adapters.py`). It has two modes via `--extra`:

- `mode=harness` (default): runs `scripts/harness_runner.py`, which replays the
  shared scenario fixtures against a **real** agent-harness client (Eliza,
  Hermes, or OpenClaw adapter) and writes a compatible
  `framework-results.json` — the cross-harness counterpart to the local
  mock-LLM measurement.
- `mode=typescript`: runs the local TypeScript harness described above.

```bash
python -m benchmarks.orchestrator run --benchmarks framework --provider <p> --model <m>
```

## Architecture

```
benchmarks/framework/
├── README.md               # This file
├── run.sh                  # Orchestrator script (install/build checks + harness + compare)
├── compare.ts              # Comparison tool for result JSON files
├── visualize.py            # ASCII charts / summary tables from results JSON
├── scripts/
│   └── harness_runner.py   # Cross-harness runner (eliza/hermes/openclaw adapters)
├── shared/
│   ├── character.json      # Shared agent character definition
│   └── scenarios.json      # 21 test scenarios
├── typescript/
│   ├── package.json
│   └── src/
│       ├── bench.ts        # Benchmark harness
│       ├── mock-llm-plugin.ts  # Mock LLM model handlers
│       └── metrics.ts      # Measurement utilities
└── results/                # JSON output files (gitignored)
```

## Mock LLM Plugin

The harness uses a mock LLM plugin that:

1. Registers handlers for `TEXT_SMALL`, `TEXT_LARGE`, `TEXT_EMBEDDING`, `TEXT_COMPLETION`
2. Returns **deterministic, pre-computed XML responses** that pass the framework's validation pipeline
3. Detects which template is being evaluated (shouldRespond vs message handler vs reply action) by inspecting the prompt
4. Returns zero-latency responses (no artificial delay)
5. shouldRespond returns `RESPOND` for all messages (agent name is always included in benchmark messages)

## Scenarios (21 total)

| ID | Description | Messages | Notes |
|----|-------------|----------|-------|
| `single-message` | Baseline latency | 1 | 50 iterations |
| `conversation-10` | State growth | 10 | Sequential conversation |
| `conversation-100` | Large state | 100 | Generated messages |
| `burst-100` | Sequential throughput | 100 | As fast as possible |
| `burst-1000` | High throughput | 1000 | Stress test |
| `with-should-respond` | With name check | 5 | Agent name in messages |
| `with-should-respond-no-name` | LLM evaluation | 5 | No agent name |
| `with-actions` | Action execution | 3 | REPLY action |
| `provider-scaling-10/50/100` | Provider overhead | 1 | N dummy providers |
| `history-scaling-100/1K/10K` | Memory overhead | 1 | Pre-populated history |
| `concurrent-10/50` | Concurrent load | N | `Promise.all` |
| `db-write-throughput` | DB writes | 10K ops | In-memory adapter |
| `db-read-throughput` | DB reads | 10K ops | In-memory adapter |
| `startup-cold` | Initialization | 0 | 20 fresh inits |
| `multi-step` | Multi-step mode | 1 | Mock completes immediately |
| `minimal-bootstrap` | Minimal providers | 1 | CHARACTER only |
