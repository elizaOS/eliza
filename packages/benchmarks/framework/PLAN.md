# Framework Benchmark Plan: TypeScript vs Python vs Rust

## 1. Goal

Build a cross-language performance benchmark that measures and compares the **core agent framework** overhead across the three Eliza runtimes (TypeScript, Python, Rust). By replacing the real LLM with a deterministic mock plugin that returns fixed responses in constant time, we isolate and measure the **framework itself**: state composition, provider execution, message pipeline orchestration, action dispatch, memory operations, and serialization overhead.

The benchmark answers: "If the LLM is infinitely fast, which runtime processes agent messages fastest, scales best, and uses the least resources?"

---

## 2. Architecture Overview

```
benchmarks/framework/
├── README.md                        # Usage documentation
├── run.sh                           # Orchestrator script (runs all three, collects results)
├── compare.ts                       # Results comparison & report generator
├── shared/
│   ├── scenarios.json               # Scripted message sequences & expected responses
│   ├── character.json               # Shared character definition for all runtimes
│   └── types.ts                     # Shared result schema (BenchmarkResult)
├── typescript/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── bench.ts                 # Benchmark harness entry point
│   │   ├── mock-llm-plugin.ts       # Mock LLM model handler plugin
│   │   ├── mock-inmemory-adapter.ts # Lightweight in-memory DB (reuses core)
│   │   ├── metrics.ts               # Metric collection utilities
│   │   └── scenarios.ts             # Scenario runner
├── python/
│   ├── pyproject.toml
│   ├── src/
│   │   ├── bench.py                 # Benchmark harness entry point
│   │   ├── mock_llm_plugin.py       # Mock LLM model handler plugin
│   │   ├── mock_inmemory_adapter.py # Lightweight in-memory DB (reuses core)
│   │   ├── metrics.py               # Metric collection utilities
│   │   └── scenarios.py             # Scenario runner
├── rust/
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs                  # Benchmark harness entry point
│   │   ├── mock_llm_plugin.rs       # Mock LLM model handler plugin
│   │   ├── mock_inmemory_adapter.rs # Lightweight in-memory DB (reuses core)
│   │   ├── metrics.rs               # Metric collection utilities
│   │   └── scenarios.rs             # Scenario runner
└── results/                         # Output directory for benchmark runs
    └── .gitkeep
```

---

## 3. Mock LLM Response Handler Plugin

### 3.1 Purpose

The mock plugin replaces all LLM model handlers (`TEXT_SMALL`, `TEXT_LARGE`, `TEXT_EMBEDDING`, etc.) with deterministic handlers that return pre-computed responses matching the expected XML/JSON schema. This eliminates network latency, API rate limits, and non-determinism from measurements.

### 3.2 Response Strategy

The message handler template expects responses in this structure:

```xml
<thought>I should respond to the user's message.</thought>
<providers></providers>
<actions>REPLY</actions>
<text>This is a fixed benchmark response.</text>
<simple>true</simple>
```

The mock plugin will:
- **Parse the incoming prompt** to identify the expected response schema (from the `schema` param or template analysis)
- **Return a static valid response** that satisfies the schema validation codes
- **`TEXT_SMALL`**: Used for `shouldRespond` — returns `"RESPOND"` (or the appropriate enum)
- **`TEXT_LARGE`**: Used for main message handling — returns the fixed XML response above
- **`TEXT_EMBEDDING`**: Returns a fixed 384-dimension zero vector (matching EphemeralHNSW default dimension)
- **No artificial delay**: The handler returns immediately (`0ms` latency) to measure pure framework overhead. An optional configurable delay parameter will be available for simulating realistic LLM latency in throughput tests.

### 3.3 Implementation Per Runtime

**TypeScript:**
```typescript
const mockLlmPlugin: Plugin = {
  name: "mock-llm-benchmark",
  description: "Deterministic mock LLM for benchmarking",
  models: {
    [ModelType.TEXT_SMALL]: async (_runtime, params) => MOCK_RESPONSES.textSmall,
    [ModelType.TEXT_LARGE]: async (_runtime, params) => MOCK_RESPONSES.textLarge,
    [ModelType.TEXT_EMBEDDING]: async (_runtime, params) => new Array(384).fill(0),
  },
};
```

**Python:**
```python
mock_llm_plugin = Plugin(
    name="mock-llm-benchmark",
    description="Deterministic mock LLM for benchmarking",
    models={
        ModelType.TEXT_SMALL: mock_text_small_handler,
        ModelType.TEXT_LARGE: mock_text_large_handler,
        ModelType.TEXT_EMBEDDING: mock_embedding_handler,
    },
)
```

**Rust:**
```rust
let mut model_handlers: HashMap<String, ModelHandlerFn> = HashMap::new();
model_handlers.insert("TEXT_SMALL".to_string(), Box::new(|_params| {
    Box::pin(async { Ok(MOCK_TEXT_SMALL_RESPONSE.to_string()) })
}));
model_handlers.insert("TEXT_LARGE".to_string(), Box::new(|_params| {
    Box::pin(async { Ok(MOCK_TEXT_LARGE_RESPONSE.to_string()) })
}));
```

### 3.4 Response Matching

The mock must return responses that pass the `dynamic_prompt_exec_from_state` validation pipeline. This requires:
1. **Correct XML structure** matching the message handler template fields
2. **Valid action names** (e.g., `REPLY` from bootstrap plugin)
3. **Valid `simple` boolean** (`true` to avoid multi-step follow-up)
4. **Empty `providers` list** (to avoid re-composition loops)
5. **shouldRespond format**: Return `"RESPOND"` for TEXT_SMALL calls during shouldRespond checks

The mock will detect which template is being used by inspecting the `prompt` or `context` parameter key and returning the appropriate response format.

---

## 4. In-Memory Database Adapter

### 4.1 Strategy

Each runtime already has an in-memory database adapter:
- **TypeScript**: `InMemoryDatabaseAdapter` built into core (`packages/typescript/src/database/inMemoryAdapter.ts`)
- **Python**: `plugin-inmemorydb` package (`plugins/plugin-inmemorydb/python/`)
- **Rust**: `plugin-inmemorydb` crate (`plugins/plugin-inmemorydb/rust/`)

We will **reuse these existing adapters** rather than building new ones. This ensures the benchmark measures realistic framework behavior while avoiding disk I/O.

### 4.2 Warm-Up Data

Before benchmarking, we pre-populate:
- 1 agent entity
- 1 world + 1 room
- 1 user entity as conversation partner
- Optionally: N historical messages (configurable, for "conversation history" scaling tests)

---

## 5. Performance Metrics

### 5.1 Latency Metrics

| Metric | Description | How Measured |
|--------|-------------|--------------|
| `startup_time_ms` | Time from `new AgentRuntime()` to `initialize()` complete | Timer around constructor + initialize |
| `first_message_latency_ms` | Time to process first message (cold path, includes JIT) | Timer around first `handleMessage` |
| `message_latency_p50_ms` | Median message processing time | Percentile of all `handleMessage` calls |
| `message_latency_p95_ms` | 95th percentile message processing time | Percentile calculation |
| `message_latency_p99_ms` | 99th percentile message processing time | Percentile calculation |
| `message_latency_avg_ms` | Mean message processing time | Average of all `handleMessage` calls |
| `message_latency_min_ms` | Minimum message processing time | Min of all calls |
| `message_latency_max_ms` | Maximum message processing time | Max of all calls |

### 5.2 Throughput Metrics

| Metric | Description | How Measured |
|--------|-------------|--------------|
| `messages_per_second` | Sequential message throughput | N messages / total time |
| `concurrent_throughput` | Messages/sec with concurrent senders | Concurrent message submission, measure total time |
| `actions_per_second` | Action dispatch throughput | Timed action execution across messages |

### 5.3 Pipeline Breakdown Metrics

| Metric | Description | How Measured |
|--------|-------------|--------------|
| `compose_state_avg_ms` | Average state composition time | Instrument `composeState` / `compose_state` |
| `provider_execution_avg_ms` | Average total provider execution time | Instrument provider loop |
| `provider_count` | Number of registered providers | Count at runtime |
| `should_respond_avg_ms` | Average shouldRespond decision time | Instrument shouldRespond call |
| `model_call_avg_ms` | Average model handler call time (should be ~0ms) | Instrument useModel |
| `action_dispatch_avg_ms` | Average action processing time | Instrument processActions |
| `evaluator_avg_ms` | Average evaluator execution time | Instrument evaluate |
| `memory_create_avg_ms` | Average memory creation time | Instrument createMemory |
| `memory_get_avg_ms` | Average memory retrieval time | Instrument getMemories |
| `state_serialization_avg_ms` | Time spent in JSON/proto serialization | Instrument serialization points |

### 5.4 Resource Metrics

| Metric | Description | How Measured |
|--------|-------------|--------------|
| `memory_rss_start_mb` | RSS before benchmark | OS process stats |
| `memory_rss_peak_mb` | Peak RSS during benchmark | OS process stats (polled) |
| `memory_rss_end_mb` | RSS after benchmark | OS process stats |
| `memory_heap_mb` | Heap usage (where available) | Runtime-specific heap stats |
| `gc_pauses_count` | GC pause count (TS/Python only) | Runtime GC hooks |
| `gc_pause_total_ms` | Total GC pause time | Runtime GC hooks |

### 5.5 Scale Metrics

| Metric | Description | How Measured |
|--------|-------------|--------------|
| `latency_at_10_providers` | Message latency with 10 providers | Run scenario with N dummy providers |
| `latency_at_50_providers` | Message latency with 50 providers | Run scenario with N dummy providers |
| `latency_at_100_providers` | Message latency with 100 providers | Run scenario with N dummy providers |
| `latency_at_100_history` | Message latency with 100 messages in history | Pre-populate memory |
| `latency_at_1000_history` | Message latency with 1000 messages in history | Pre-populate memory |
| `latency_at_10000_history` | Message latency with 10000 messages in history | Pre-populate memory |
| `inmemdb_write_ops_per_sec` | In-memory DB write throughput | Timed bulk writes |
| `inmemdb_read_ops_per_sec` | In-memory DB read throughput | Timed bulk reads |

---

## 6. Test Scenarios

### 6.1 Scenario Format (`shared/scenarios.json`)

```json
{
  "scenarios": [
    {
      "id": "single-message",
      "name": "Single Message Processing",
      "description": "Process one message end-to-end",
      "messages": [
        {
          "role": "user",
          "content": "Hello, how are you?",
          "entityId": "user-entity-uuid",
          "roomId": "benchmark-room-uuid"
        }
      ],
      "config": {
        "checkShouldRespond": false,
        "multiStep": false
      }
    }
  ]
}
```

### 6.2 Scenarios

1. **`single-message`** — One message, baseline latency
2. **`conversation-10`** — 10-message back-and-forth conversation
3. **`conversation-100`** — 100-message conversation (measures state growth impact)
4. **`burst-100`** — 100 messages sent as fast as possible (sequential throughput)
5. **`burst-1000`** — 1000 messages sent as fast as possible
6. **`with-should-respond`** — Messages with shouldRespond check enabled (adds LLM call)
7. **`with-actions`** — Messages that trigger action execution (REPLY + custom benchmark action)
8. **`provider-scaling-10`** — 10 registered dummy providers
9. **`provider-scaling-50`** — 50 registered dummy providers
10. **`provider-scaling-100`** — 100 registered dummy providers
11. **`history-scaling-100`** — Pre-populated with 100 memory entries
12. **`history-scaling-1000`** — Pre-populated with 1000 memory entries
13. **`history-scaling-10000`** — Pre-populated with 10000 memory entries
14. **`concurrent-10`** — 10 simultaneous message submissions
15. **`concurrent-50`** — 50 simultaneous message submissions
16. **`db-write-throughput`** — Bulk memory creation (10000 writes)
17. **`db-read-throughput`** — Bulk memory retrieval (10000 reads)
18. **`startup-cold`** — Agent creation + initialization time (measured separately, 10 iterations)

---

## 7. Benchmark Harness Design

### 7.1 Common Flow (all runtimes)

```
1. Parse CLI args (scenario filter, iterations, warmup count, output path)
2. Load shared scenarios from scenarios.json
3. Load shared character from character.json
4. For each selected scenario:
   a. Run warmup iterations (discarded)
   b. Start resource monitoring (RSS polling thread/task)
   c. For each iteration:
      i.   Create AgentRuntime with mock plugin + in-memory DB
      ii.  Initialize runtime
      iii. Pre-populate data (if scenario requires)
      iv.  Instrument pipeline entry points
      v.   Execute scenario messages
      vi.  Collect timing + resource metrics
      vii. Tear down runtime
   d. Stop resource monitoring
   e. Aggregate results (percentiles, averages, min/max)
   f. Write results to JSON
5. Output summary to stdout
```

### 7.2 Instrumentation Strategy

Rather than modifying the core framework code, each benchmark harness will:

**TypeScript**: Use high-resolution `performance.now()` timers wrapping calls to `handleMessage`, and monkey-patch or wrap `composeState`, `useModel`, `processActions` on the runtime instance to add timing.

**Python**: Use `time.perf_counter_ns()` timers. Wrap runtime methods using decorator/wrapper pattern on the instance to add timing around `compose_state`, `use_model`, `process_actions`.

**Rust**: Use `std::time::Instant` timers. Wrap the runtime's public methods or use the existing trajectory logging hooks to capture timing data. Alternatively, implement a thin wrapper struct around `AgentRuntime` that delegates and times.

### 7.3 Warm-Up

- 3 warm-up iterations before each scenario (configurable)
- Allows JIT compilation (V8/Bun for TS, no JIT for Python, no JIT for Rust but allows cache warming)
- Warm-up results are discarded

### 7.4 Iteration Count

- Default: 10 iterations per scenario (configurable via CLI)
- Statistical metrics computed: min, max, mean, median, p95, p99, stddev
- Outlier detection: flag results > 3 standard deviations from mean

---

## 8. Comparison & Output

### 8.1 Result Schema

```typescript
interface BenchmarkResult {
  runtime: "typescript" | "python" | "rust";
  timestamp: string;
  system: {
    os: string;
    arch: string;
    cpus: number;
    memory_gb: number;
    runtime_version: string; // bun version, python version, rustc version
  };
  scenarios: {
    [scenarioId: string]: {
      iterations: number;
      warmup: number;
      latency: {
        min_ms: number;
        max_ms: number;
        avg_ms: number;
        median_ms: number;
        p95_ms: number;
        p99_ms: number;
        stddev_ms: number;
        raw_ms: number[]; // all iteration timings
      };
      throughput: {
        messages_per_second: number;
        total_messages: number;
        total_time_ms: number;
      };
      pipeline: {
        compose_state_avg_ms: number;
        provider_execution_avg_ms: number;
        should_respond_avg_ms: number;
        model_call_avg_ms: number;
        action_dispatch_avg_ms: number;
        evaluator_avg_ms: number;
        memory_create_avg_ms: number;
        memory_get_avg_ms: number;
      };
      resources: {
        memory_rss_start_mb: number;
        memory_rss_peak_mb: number;
        memory_rss_end_mb: number;
        memory_delta_mb: number;
      };
    };
  };
}
```

### 8.2 Comparison Report (`compare.ts`)

Reads result JSON files from all three runtimes and generates:

1. **Console table**: Side-by-side comparison per scenario
2. **Relative performance**: Each metric shown as ratio to fastest runtime (e.g., "TS: 1.0x, Python: 3.2x, Rust: 0.8x")
3. **Category winners**: Which runtime wins in latency, throughput, memory, startup, scale
4. **Pipeline heatmap**: Shows where each runtime spends time (state composition, model calls, action dispatch, etc.)
5. **JSON output**: Machine-readable comparison for CI integration

Example console output:
```
╔══════════════════════════════════════════════════════════════════╗
║              Eliza Framework Benchmark Results                  ║
║              2026-02-06 | macOS arm64 | 10 cores | 32GB       ║
╠══════════════════════════════════════════════════════════════════╣
║ Scenario: single-message (10 iterations, 3 warmup)             ║
╠════════════════════╦════════════╦════════════╦══════════════════╣
║ Metric             ║ TypeScript ║   Python   ║       Rust       ║
╠════════════════════╬════════════╬════════════╬══════════════════╣
║ Avg latency        ║   2.3ms    ║   8.7ms    ║     0.4ms        ║
║ P95 latency        ║   3.1ms    ║  12.1ms    ║     0.6ms        ║
║ Throughput (msg/s) ║    435     ║    115     ║     2500          ║
║ RSS peak (MB)      ║    82      ║    145     ║      12           ║
║ Startup (ms)       ║    45      ║    120     ║       8           ║
╠════════════════════╬════════════╬════════════╬══════════════════╣
║ Pipeline Breakdown ║            ║            ║                   ║
║  compose_state     ║   0.8ms    ║   3.2ms    ║     0.15ms       ║
║  model_call        ║   0.01ms   ║   0.02ms   ║     0.001ms      ║
║  action_dispatch   ║   0.3ms    ║   1.1ms    ║     0.05ms       ║
║  memory_ops        ║   0.2ms    ║   0.8ms    ║     0.03ms       ║
╚════════════════════╩════════════╩════════════╩══════════════════╝
```

---

## 9. Dependencies & Constraints

### 9.1 Runtime Requirements

| Runtime | Version | Build Tool | Notes |
|---------|---------|------------|-------|
| TypeScript | Bun 1.x | Bun | Uses Bun APIs for perf timing and process stats |
| Python | 3.11+ | pip/hatch | Uses `time.perf_counter_ns()`, `resource` module |
| Rust | 1.75+ | Cargo | Uses `std::time::Instant`, `sysinfo` crate for RSS |

### 9.2 Dependencies Per Runtime

**TypeScript:**
- `@elizaos/core` (from `packages/typescript`) — the agent framework
- No additional deps (Bun built-in perf APIs)

**Python:**
- `elizaos` (from `packages/python`) — the agent framework
- `elizaos-plugin-inmemorydb` (from `plugins/plugin-inmemorydb/python`) — in-memory DB
- `psutil` — cross-platform process stats (RSS monitoring)

**Rust:**
- `elizaos` (from `packages/rust`) — the agent framework
- `elizaos-plugin-inmemorydb` (from `plugins/plugin-inmemorydb/rust`) — in-memory DB
- `sysinfo` — RSS monitoring
- `criterion` or `divan` — statistical benchmarking (optional, for micro-benchmarks)
- `serde_json` — result serialization
- `tokio` — async runtime

### 9.3 Constraints

1. **No real LLM calls**: All model handlers are mocked
2. **No disk I/O**: In-memory DB only
3. **No network I/O**: No HTTP/WebSocket servers started
4. **Deterministic**: Same input always produces same output
5. **Single-machine**: All runtimes benchmarked on the same machine in the same session
6. **Sequential runtimes**: Run TS, then Python, then Rust (not concurrent) to avoid resource contention

---

## 10. Risks & Unknowns

### 10.1 Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Mock response validation failure | Benchmark cannot run | Pre-validate mock responses against each runtime's validation pipeline before benchmarking |
| Bootstrap plugin requires real services | Startup failure | Audit bootstrap plugin init; disable services that require external resources (HTTP, etc.) |
| Python GIL limits concurrency tests | Unfair comparison | Use `asyncio` concurrency (not threads); document that Python concurrency is cooperative |
| Rust compilation time | Slow iteration | Use `cargo build --release` once; run binary directly for benchmarks |
| Runtime version differences | Incomparable results | Lock versions in benchmark config; report exact versions in output |
| In-memory DB implementations differ | Unfair comparison | Document differences; focus on total pipeline time rather than DB-only metrics |

### 10.2 Unknowns

1. **Bootstrap plugin side effects**: Each runtime's bootstrap plugin may start background services (autonomy, task scheduling). We need to audit and disable these for benchmarking, or use a minimal character config that disables them.

2. **`dynamic_prompt_exec_from_state` validation**: This function performs schema validation on LLM responses with retry logic. The mock must return responses that pass on the first attempt to avoid measuring retry overhead. Need to determine the exact validation codes expected.

3. **Rust `compose_state` provider execution**: Need to confirm whether Rust actually supports parallel provider execution via tokio or if it's strictly sequential. The current code shows sequential, but there may be a parallel path.

4. **Python import time**: Python's import overhead for the `elizaos` package may dominate startup benchmarks. Need to separate import time from agent initialization time.

5. **Streaming behavior**: If `handleMessage` activates streaming by default, the mock must handle that code path. Need to verify whether streaming is mandatory or opt-in.

---

## 11. Key Architectural Differences to Highlight

The benchmark should prominently surface these known architectural differences:

1. **Provider execution model**: TypeScript runs providers in parallel (`Promise.all`), Python and Rust run them sequentially. This will show up dramatically in `provider-scaling-*` scenarios.

2. **State caching**: TypeScript and Python cache composed state; Rust does not appear to. This affects repeated messages to the same room.

3. **Model handler priority**: TypeScript and Python support multiple handlers per model type with priority-based selection. Rust overwrites with a single handler. This affects handler lookup time (negligible but measurable at scale).

4. **Memory model**: Rust uses `Arc<RwLock<...>>` for thread-safe concurrent access. TypeScript uses single-threaded event loop. Python uses cooperative async with GIL. This fundamentally affects concurrency behavior.

5. **Serialization**: Rust uses protobuf-backed types with serde_json serialization. TypeScript and Python use native JSON. Serialization overhead differs significantly.

6. **GC vs manual memory**: Rust has no GC; TypeScript (V8/Bun) and Python have GC. This affects latency consistency (GC pauses) and memory usage patterns.

---

## 12. Implementation Order

1. **Shared artifacts** — `scenarios.json`, `character.json`, result schema types
2. **TypeScript benchmark** — Most familiar codebase, use as reference implementation
3. **Python benchmark** — Port from TypeScript, adapt to Python idioms
4. **Rust benchmark** — Port from TypeScript, adapt to Rust idioms
5. **Comparison tool** — `compare.ts` that reads all three result files
6. **Orchestrator script** — `run.sh` that builds and runs all three sequentially
7. **Validation** — Run end-to-end, verify mock responses work, verify metrics are captured

Estimated effort: This is a substantial project. Each runtime benchmark is ~500-800 lines of code. The mock plugins are ~100-200 lines each. The comparison tool is ~300-500 lines. Total: ~2500-4000 lines across all files.

---

## 13. Resolved Decisions

1. **shouldRespond**: Test both with and without. When enabled, shouldRespond always returns `RESPOND` if the agent's name is in the message (which it is for all benchmark messages). A separate `with-should-respond-no-name` scenario tests the LLM evaluation path.

2. **Multi-step mode**: Yes, included as a separate scenario (`multi-step`). No real LLM calls — the mock completes the task immediately with `isFinish: true`.

3. **Rust criterion**: Yes, Cargo.toml includes criterion as an optional dependency (`micro` feature) for pipeline micro-benchmarks.

4. **Binary/bundle size**: Yes, measured and included in the output. TypeScript reports the `@elizaos/core` bundle size, Rust reports the compiled binary size.

5. **Python concurrency**: Uses `asyncio.gather` to match the runtime's actual cooperative concurrency model.

6. **Bootstrap providers**: Both — `single-message` uses full bootstrap, `minimal-bootstrap` uses only the CHARACTER provider.
