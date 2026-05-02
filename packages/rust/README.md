# elizaOS Core - Rust Implementation

This is the Rust implementation of the elizaOS core runtime. It provides a fully compatible implementation that can be compiled to both native binaries and WebAssembly.

## Features

- **Full Type Compatibility**: All types serialize to JSON in a format identical to the TypeScript implementation
- **Native Performance**: Compile to native code for maximum performance
- **WASM Support**: Compile to WebAssembly for browser and Node.js environments
- **Character Loading**: Parse and validate character files matching TypeScript behavior
- **Plugin System**: Load, validate, and resolve plugin dependencies
- **Agent Runtime**: Core runtime for elizaOS agents

## Runtime Settings (cross-language parity)

These settings are read by the runtime/message loop to keep behavior aligned with the TypeScript and Python implementations:

- `ALLOW_NO_DATABASE`: when truthy, allow running without a persistent database adapter (benchmarks/tests).
- `USE_MULTI_STEP`: when truthy, enable the iterative multi-step workflow.
- `MAX_MULTISTEP_ITERATIONS`: maximum iterations for multi-step mode (default: `6`).

### Benchmark & Trajectory Tracing

Benchmarks and harnesses can attach metadata to inbound messages (stored under `Memory.metadata` as custom JSON):

- `trajectoryStepId`: enables trajectory tracing for provider access + model calls.
- `benchmarkContext`: enables the `CONTEXT_BENCH` provider and sets `state.values["benchmark_has_context"]=true`, which forces action-based execution to exercise the full loop.

## Model output contract (XML preferred, plain text tolerated)

The canonical message loop expects model outputs in the `<response>...</response>` XML format (with `<actions>`, `<providers>`, and `<text>` fields).

Some deterministic/offline backends may return **plain text** instead. In that case, the runtime will treat the raw output as a simple **`REPLY`** so the system remains usable even when strict XML formatting is unavailable.

## Building

### Prerequisites

- Rust 1.70 or later
- wasm-pack (for WASM builds)

### Native Build

```bash
cargo build --release
```

### WASM Build

```bash
# For web browsers
wasm-pack build --target web --out-dir pkg/web --features wasm

# For Node.js
wasm-pack build --target nodejs --out-dir pkg/node --features wasm
```

### Build Script

```bash
./build.sh
```

## Testing

```bash
cargo test
```

## Usage

### Rust (Native)

```rust
use elizaos::{AgentRuntime, Character, parse_character};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let json = r#"{"name": "TestAgent", "bio": "A test agent"}"#;
    let character = parse_character(json)?;

    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(character),
        ..Default::default()
    }).await?;

    runtime.initialize().await?;

    Ok(())
}
```

### JavaScript (WASM)

```javascript
import init, {
  WasmAgentRuntime,
  parse_character,
  validate_character,
} from "@elizaos/core/rust";

// Initialize WASM module
await init();

// Create a runtime
const runtime = await new WasmAgentRuntime(
  '{"name": "TestAgent", "bio": "A test agent"}',
);
await runtime.initialize();

console.log(`Agent ID: ${runtime.agent_id}`);
console.log(`Character: ${runtime.character_name}`);
```

## Architecture

```
src/
├── lib.rs           # Library entry point
├── types/           # Core type definitions
│   ├── mod.rs       # Type module exports
│   ├── primitives.rs # UUID, Content, etc.
│   ├── memory.rs    # Memory types
│   ├── agent.rs     # Character, Agent types
│   ├── plugin.rs    # Plugin types
│   ├── components.rs # Action, Provider, Evaluator
│   ├── environment.rs # Entity, Room, World
│   ├── events.rs    # Event system types
│   ├── database.rs  # Database types
│   ├── model.rs     # Model types
│   ├── service.rs   # Service types
│   ├── state.rs     # State types
│   └── ...
├── character.rs     # Character parsing/validation
├── plugin.rs        # Plugin loading/resolution
├── runtime.rs       # AgentRuntime implementation
└── wasm.rs          # WASM bindings
```

## Compatibility

This implementation is designed to be 100% compatible with the TypeScript version:

- **JSON Serialization**: All types use `#[serde(rename_all = "camelCase")]` to match TypeScript
- **UUID Format**: UUIDs are validated and stored in lowercase format
- **Character Files**: Existing character files work without modification
- **Plugin Loading**: Plugins are resolved using the same dependency algorithm

## License

MIT
