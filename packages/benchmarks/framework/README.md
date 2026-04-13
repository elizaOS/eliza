# Eliza Framework Benchmark

Cross-language performance benchmark comparing the Eliza agent framework across **TypeScript**, **Python**, and **Rust** runtimes.

## What It Measures

By replacing the real LLM with a deterministic mock plugin that returns instant, fixed responses, this benchmark isolates and measures the **framework itself**:

- **Latency**: End-to-end message processing time (min/avg/median/p95/p99)
- **Throughput**: Messages per second (sequential and concurrent)
- **Pipeline breakdown**: Time in state composition, provider execution, model calls, action dispatch, evaluators, memory CRUD
- **Resource usage**: RSS memory (start/peak/delta)
- **Scaling behavior**: Performance vs provider count, conversation history size, concurrent load
- **Startup time**: Agent creation and initialization
- **DB throughput**: In-memory database read/write operations per second

## Quick Start

```bash
# Run all three runtimes with default scenarios
./run.sh

# Run only TypeScript
./run.sh --ts-only

# Run all scenarios (including stress tests)
./run.sh --all

# Run specific scenarios
./run.sh --scenarios=single-message,burst-100,startup-cold

# Just generate comparison from existing results
./run.sh --compare
```

## Individual Runtime Benchmarks

### TypeScript (Bun)
```bash
cd typescript
bun install
bun run src/bench.ts
bun run src/bench.ts --all
bun run src/bench.ts --scenarios=single-message,startup-cold
```

### Python
```bash
cd python
pip install -e ../../packages/python psutil
python -m src.bench
python -m src.bench --all
```

### Rust
```bash
cd rust
cargo build --release
./target/release/bench
./target/release/bench --all
```

## Comparison Report

After running benchmarks, generate a side-by-side comparison:

```bash
bun run compare.ts
```

## Architecture

```
benchmarks/framework/
├── README.md               # This file
├── PLAN.md                 # Detailed design document
├── run.sh                  # Orchestrator script
├── compare.ts              # Cross-runtime comparison tool
├── shared/
│   ├── character.json      # Shared agent character definition
│   └── scenarios.json      # 20 test scenarios
├── typescript/
│   ├── package.json
│   └── src/
│       ├── bench.ts        # Benchmark harness
│       ├── mock-llm-plugin.ts  # Mock LLM model handlers
│       └── metrics.ts      # Measurement utilities
├── python/
│   ├── pyproject.toml
│   └── src/
│       ├── bench.py        # Benchmark harness
│       ├── mock_llm_plugin.py  # Mock LLM model handlers
│       └── metrics.py      # Measurement utilities
├── rust/
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs         # Benchmark harness
│       ├── mock_llm_plugin.rs  # Mock LLM model handlers
│       └── metrics.rs      # Measurement utilities
└── results/                # JSON output files
```

## Mock LLM Plugin

Each runtime includes a mock LLM plugin that:

1. Registers handlers for `TEXT_SMALL`, `TEXT_LARGE`, `TEXT_EMBEDDING`, `TEXT_COMPLETION`, `OBJECT_SMALL`, `OBJECT_LARGE`
2. Returns **deterministic, pre-computed XML responses** that pass the framework's validation pipeline
3. Detects which template is being evaluated (shouldRespond vs message handler vs reply action) by inspecting the prompt
4. Returns zero-latency responses (no artificial delay)
5. shouldRespond returns `RESPOND` for all messages (agent name is always included in benchmark messages)

## Scenarios (20 total)

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
| `concurrent-10/50` | Concurrent load | N | asyncio.gather / Promise.all |
| `db-write-throughput` | DB writes | 10K ops | In-memory adapter |
| `db-read-throughput` | DB reads | 10K ops | In-memory adapter |
| `startup-cold` | Initialization | 0 | 20 fresh inits |
| `multi-step` | Multi-step mode | 1 | Mock completes immediately |
| `minimal-bootstrap` | Minimal providers | 1 | CHARACTER only |

## Key Architectural Differences Surfaced

1. **Provider execution**: TypeScript runs providers in parallel (`Promise.all`), Python and Rust run sequentially
2. **GC vs manual memory**: Rust has no GC; TypeScript (V8) and Python have GC pauses
3. **Concurrency model**: Rust uses `Arc<RwLock>`, TypeScript uses single-threaded event loop, Python uses cooperative async with GIL
4. **Serialization**: Rust uses protobuf-backed types; TypeScript/Python use native JSON
5. **State caching**: TypeScript and Python cache composed state; Rust does not
