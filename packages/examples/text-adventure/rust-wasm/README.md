# Rust-WASM Examples

This directory contains examples demonstrating elizaOS with the **Rust core compiled to WebAssembly**.

## Examples

| File                | Description                                                                            |
| ------------------- | -------------------------------------------------------------------------------------- |
| `chat.ts`           | CLI chat using the **full Rust AgentRuntime** in WASM with comprehensive binding tests |
| `adventure-game.ts` | Text adventure game with AI-powered decision making                                    |

## Key Features

### chat.ts - Rust Runtime in WebAssembly

This example demonstrates:

1. **Full Rust Runtime in WASM**: The agent logic runs in Rust compiled to WebAssembly
2. **TypeScript Plugin Bridge**: Model inference uses TypeScript/OpenAI via JavaScript callbacks
3. **Comprehensive Binding Tests**: Tests all WASM type bindings on startup
4. **Cross-Language Type Compatibility**: Same UUIDs and types across Rust, TypeScript, Python

**Tested WASM Bindings:**

- `WasmAgentRuntime` - Full agent runtime
- `WasmCharacter` - Character parsing and validation
- `WasmMemory` - Memory/message handling
- `WasmAgent` - Agent wrapper
- `WasmPlugin` - Plugin definitions
- `WasmState` - State management
- `WasmRoom` - Room handling
- `WasmEntity` - Entity management
- `WasmUUID` - UUID generation and validation
- UUID utilities (`stringToUuid`, `generateUUID`, `validateUUID`)
- Round-trip serialization tests

## Prerequisites

1. **Build the WASM module** (required):

   ```bash
   cd packages/rust
   wasm-pack build --target nodejs --features wasm --no-default-features
   ```

2. **Set environment variables**:
   ```bash
   export OPENAI_API_KEY=your_key_here
   ```

## Run

### Chat

```bash
OPENAI_API_KEY=your_key bun run examples/rust-wasm/chat.ts
```

### Adventure Game

```bash
# Normal mode
LOG_LEVEL=fatal bun run examples/rust-wasm/adventure-game.ts

# With persistent storage
PGLITE_DATA_DIR=./adventure-db LOG_LEVEL=fatal bun run examples/rust-wasm/adventure-game.ts
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TypeScript Application                    │
│  (orchestration, I/O, plugin loading)                       │
├─────────────────────────────────────────────────────────────┤
│                    TypeScript Plugin Bridge                  │
│  (@elizaos/plugin-openai → JS model handler)                │
├─────────────────────────────────────────────────────────────┤
│                    Rust WASM Module                          │
│  WasmAgentRuntime: Character, State, Message Processing     │
│  Type Validation, UUID Generation, Serialization            │
└─────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Rust Runtime**: The `WasmAgentRuntime` handles:
   - Character management
   - Message processing
   - State management
   - UUID generation (deterministic, cross-language)
   - Type validation

2. **JavaScript Bridge**: Model handlers are registered from JS:

   ```typescript
   runtime.registerModelHandler("TEXT_LARGE", async (paramsJson) => {
     const params = JSON.parse(paramsJson);
     // Call OpenAI or any LLM API
     return await callOpenAI(params);
   });
   ```

3. **Type Safety**: All types are validated through Rust:
   - Characters, Memories, Agents, Plugins, Rooms, Entities
   - UUIDs are validated and deterministically generated
   - JSON serialization is consistent across languages

## Environment Variables

| Variable          | Default                     | Description                     |
| ----------------- | --------------------------- | ------------------------------- |
| `OPENAI_API_KEY`  | (required)                  | OpenAI API key                  |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API base URL                    |
| `LOG_LEVEL`       | `info`                      | Set to `fatal` to suppress logs |
| `PGLITE_DATA_DIR` | `memory://`                 | PGLite storage directory        |

## Building WASM

```bash
cd packages/rust

# For Node.js (used by this example)
wasm-pack build --target nodejs --features wasm --no-default-features

# For web browsers
wasm-pack build --target web --features wasm --no-default-features

# For bundlers (webpack, etc.)
wasm-pack build --target bundler --features wasm --no-default-features

# All targets
./build-wasm.sh
```

## Comparing Implementations

| Feature         | rust-wasm/chat.ts | typescript/chat.ts | rust/chat   |
| --------------- | ----------------- | ------------------ | ----------- |
| Runtime         | Rust/WASM         | TypeScript         | Native Rust |
| Model Inference | JS (OpenAI)       | TypeScript         | Native Rust |
| Type Validation | Rust/WASM         | TypeScript         | Native Rust |
| UUID Generation | Rust/WASM         | TypeScript         | Native Rust |
| Database        | None (stateless)  | PGLite             | Optional    |

## Troubleshooting

### WASM module not found

```
Error: WASM module not found. Build it first:
  cd packages/rust && wasm-pack build --target nodejs --features wasm --no-default-features
```

### Binding test failures

If binding tests fail, ensure:

1. WASM module is freshly built
2. Rust code compiles without errors
3. No breaking changes in type definitions

### API key errors

Ensure `OPENAI_API_KEY` is set and valid:

```bash
export OPENAI_API_KEY=sk-...
```

## Related Examples

- `../typescript/` - Pure TypeScript examples (no WASM)
- `../rust/` - Pure Rust examples (native, no WASM)
- `../python/` - Python examples
