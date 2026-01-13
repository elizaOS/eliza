# elizaOS Rust Examples

This directory contains examples demonstrating how to use the elizaOS Rust crate in both native and WASM environments.

## Native Examples

Native examples run directly with Cargo and require the `native` feature.

### Basic Runtime

Creates a simple agent runtime with a character:

```bash
cargo run --example basic_runtime --features native
```

### With Handlers

Demonstrates registering model handlers:

```bash
cargo run --example with_handlers --features native
```

## WASM Examples

WASM examples run with Bun (or Node.js) and use the compiled WASM module.

### Prerequisites

First, build the WASM module:

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

Shows the full WasmAgentRuntime lifecycle with model handlers:

```bash
bun run examples/wasm/runtime.ts
```

### Interactive Chat

An interactive chat session with the agent:

```bash
bun run examples/wasm/chat.ts
```

Type messages to chat, type `exit` to quit.

## Adding to package.json Scripts

You can also run examples via npm/bun scripts by adding to `package.json`:

```json
{
  "scripts": {
    "example:basic": "bun run examples/wasm/basic.ts",
    "example:runtime": "bun run examples/wasm/runtime.ts",
    "example:chat": "bun run examples/wasm/chat.ts"
  }
}
```

## Example Output

### Basic Example

```
=== elizaOS WASM Basic Example ===

Version: 2.0.0

--- UUID Operations ---
Generated UUID: 550e8400-e29b-41d4-a716-446655440000
Is valid: true
Deterministic UUID for 'my-agent-name': 7f8a9b2c-1234-5678-9abc-def012345678

--- Character Parsing ---
Character name: BunAgent
Character system: You are a helpful assistant running in a JavaScript runtime.

--- Memory Operations ---
Memory entity ID: 123e4567-e89b-12d3-a456-426614174000
Memory content: {"text":"Hello from Bun!","source":"example"}

--- Round-Trip Test ---
Memory round-trip: ✓ PASS
Character round-trip: ✓ PASS

=== Example Complete ===
```

### Chat Example

```
=== elizaOS Interactive Chat ===

Starting up...

ChatBot is ready to chat!
Type your messages below. Type "exit" to quit.

You: Hello!
ChatBot: Hello! I'm ChatBot. How can I help you today?

You: What's your name?
ChatBot: My name is ChatBot. Nice to meet you!

You: exit

ChatBot: Goodbye! 👋
```

