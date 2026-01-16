# elizaOS Rust Examples

This directory contains practical examples for the elizaOS Rust crate in both native
and WASM environments.

## Native Examples

Native examples run with Cargo and require the `native` feature.

### Basic Runtime

Creates a simple agent runtime with a character:

```bash
cargo run --example basic_runtime --features native
```

### With Handlers

Demonstrates registering a model handler:

```bash
cargo run --example with_handlers --features native
```

## WASM Examples

WASM examples run with Bun or Node.js and use the compiled WASM module.

### Build the WASM module

```bash
# From packages/rust directory
./build-wasm.sh

# Or just build for Node.js
wasm-pack build --target nodejs --out-dir pkg-node --no-default-features --features wasm
```

### Basic Example

Demonstrates UUID generation, character parsing, and memory operations:

```bash
bun run examples/wasm/basic.ts
```

### Runtime Example

Shows the full `WasmAgentRuntime` lifecycle with model handlers:

```bash
bun run examples/wasm/runtime.ts
```

### Interactive Chat

An interactive chat session with the agent:

```bash
bun run examples/wasm/chat.ts
```

Type messages to chat, type `exit` to quit.

### Benchmark

Measures JSON round-trips and handler throughput:

```bash
bun run examples/wasm/benchmark.ts
```
