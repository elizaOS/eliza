# elizaOS Cross-Language Plugin Interoperability Architecture

## Overview

elizaOS supports plugins written in **Rust**, **TypeScript**, and **Python**, with full cross-runtime loading capabilities. This document describes the architecture and implementation of the interop layer.

## Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         elizaOS Interop Architecture                        │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                     Plugin Interface Definition                       │  │
│  │                       (plugin.schema.json)                            │  │
│  │                                                                       │  │
│  │  • Unified JSON Schema for all languages                             │  │
│  │  • Defines: Actions, Providers, Evaluators, Services, Routes         │  │
│  │  • Serialization format for IPC messages                             │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│           ┌────────────────────────┼────────────────────────┐              │
│           │                        │                        │              │
│           ▼                        ▼                        ▼              │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐      │
│  │     RUST        │     │   TYPESCRIPT    │     │     PYTHON      │      │
│  │    Runtime      │     │    Runtime      │     │    Runtime      │      │
│  │                 │     │                 │     │                 │      │
│  │  ┌───────────┐  │     │  ┌───────────┐  │     │  ┌───────────┐  │      │
│  │  │  Native   │  │     │  │  Native   │  │     │  │  Native   │  │      │
│  │  │  Plugins  │  │     │  │  Plugins  │  │     │  │  Plugins  │  │      │
│  │  └───────────┘  │     │  └───────────┘  │     │  └───────────┘  │      │
│  │        │        │     │        │        │     │        │        │      │
│  └────────┼────────┘     └────────┼────────┘     └────────┼────────┘      │
│           │                       │                       │                │
│           │                       │                       │                │
│  ┌────────┴────────────────┬──────┴──────┬────────────────┴────────┐      │
│  │                         │             │                         │      │
│  ▼                         ▼             ▼                         ▼      │
│  ┌─────────┐         ┌─────────┐   ┌─────────┐         ┌─────────┐       │
│  │  WASM   │         │  FFI    │   │  WASM   │         │   IPC   │       │
│  │ Export  │         │ Export  │   │ Loader  │         │ Bridge  │       │
│  │(→TS/Py) │         │ (→Py)   │   │(←Rust)  │         │(←Py/TS) │       │
│  └─────────┘         └─────────┘   └─────────┘         └─────────┘       │
│       │                   │             │                   │             │
│       └───────────────────┴──────┬──────┴───────────────────┘             │
│                                  │                                         │
│                                  ▼                                         │
│                    ┌──────────────────────────┐                           │
│                    │    Cross-Language        │                           │
│                    │    Plugin Loading        │                           │
│                    └──────────────────────────┘                           │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

## Interop Methods

### 1. WASM (WebAssembly)

**Use Case**: Loading Rust plugins in TypeScript/Browser environments

**How it works**:
1. Rust plugin is compiled to `wasm32-unknown-unknown` target
2. `wasm-bindgen` generates JavaScript bindings
3. TypeScript runtime loads the WASM module
4. Function calls are made through WASM interface
5. Data is serialized as JSON for complex types

**Pros**:
- High performance (near-native speed)
- Sandboxed execution
- Works in browsers

**Cons**:
- No direct system access from WASM
- Async requires special handling

### 2. FFI (Foreign Function Interface)

**Use Case**: Loading Rust plugins in Python

**How it works**:
1. Rust plugin is compiled as a C-compatible shared library
2. Exports standard `elizaos_*` functions
3. Python loads via `ctypes`
4. Function calls are made directly
5. Data is serialized as JSON strings

**Pros**:
- Native performance
- No serialization overhead for simple types
- Direct memory access possible

**Cons**:
- Platform-specific builds required
- Memory management requires care

### 3. IPC (Inter-Process Communication)

**Use Case**: Loading Python plugins in TypeScript, or any cross-process scenario

**How it works**:
1. Plugin runs as a subprocess
2. Communication via stdin/stdout (or Unix sockets)
3. JSON-RPC protocol for messages
4. Async message handling

**Pros**:
- Complete isolation
- Language-agnostic
- Easy debugging

**Cons**:
- Higher latency (process spawning, serialization)
- More resource usage

## Data Flow

### Action Invocation (TS → Rust via WASM)

```
TypeScript Runtime                    WASM Module (Rust)
       │                                    │
       │  1. Serialize Memory to JSON       │
       │ ────────────────────────────────►  │
       │                                    │
       │                      2. Deserialize Memory
       │                      3. Call action handler
       │                      4. Serialize ActionResult
       │                                    │
       │  5. Return JSON result             │
       │ ◄────────────────────────────────  │
       │                                    │
       │  6. Deserialize ActionResult       │
       ▼                                    │
```

### Provider Request (Python → Rust via FFI)

```
Python Runtime                    Shared Library (Rust)
       │                                    │
       │  1. JSON encode Memory + State     │
       │  2. Call elizaos_get_provider()    │
       │ ────────────────────────────────►  │
       │                                    │
       │                      3. Parse JSON inputs
       │                      4. Call provider
       │                      5. Serialize result
       │                                    │
       │  6. Return *char (JSON)            │
       │ ◄────────────────────────────────  │
       │                                    │
       │  7. Decode JSON                    │
       │  8. Free returned string           │
       ▼                                    │
```

### Action Invocation (TS → Python via IPC)

```
TypeScript Runtime        Bridge Server        Python Plugin
       │                       │                     │
       │  1. spawn subprocess  │                     │
       │ ─────────────────────►│                     │
       │                       │                     │
       │                       │  2. Load module     │
       │                       │ ───────────────────►│
       │                       │                     │
       │  3. {"type":"ready"}  │                     │
       │ ◄─────────────────────│                     │
       │                       │                     │
       │  4. action.invoke     │                     │
       │ ─────────────────────►│                     │
       │                       │  5. Call handler    │
       │                       │ ───────────────────►│
       │                       │                     │
       │                       │  6. ActionResult    │
       │                       │ ◄───────────────────│
       │  7. action.result     │                     │
       │ ◄─────────────────────│                     │
       ▼                       ▼                     ▼
```

## Plugin Manifest

Every cross-language plugin must provide a manifest (either embedded or as `plugin.json`):

```json
{
  "name": "my-plugin",
  "description": "A cross-language plugin",
  "version": "1.0.0",
  "language": "rust",
  "interop": {
    "protocol": "wasm",
    "wasmPath": "./dist/my_plugin.wasm"
  },
  "actions": [
    {
      "name": "MY_ACTION",
      "description": "Does something"
    }
  ],
  "providers": [
    {
      "name": "MY_PROVIDER"
    }
  ]
}
```

## Loading Plugins

### TypeScript Runtime

```typescript
import { loadPlugin, loadWasmPlugin, loadPythonPlugin } from '@elizaos/core/interop';

// Auto-detect from manifest
const plugin1 = await loadPlugin({ manifestPath: './plugin.json' });

// Explicit WASM
const plugin2 = await loadWasmPlugin({ wasmPath: './plugin.wasm' });

// Explicit Python
const plugin3 = await loadPythonPlugin({ moduleName: 'my_plugin' });
```

### Python Runtime

```python
from elizaos.interop import load_rust_plugin
from elizaos_plugin_starter import plugin as python_plugin

# Load Rust plugin via FFI
rust_plugin = load_rust_plugin("./libmy_plugin.so")

# Native Python plugin
await runtime.register_plugin(python_plugin)
await runtime.register_plugin(rust_plugin)
```

### Rust Runtime

```rust
use elizaos::interop::WasmPluginLoader;

// Load WASM plugin (from TypeScript)
let plugin = WasmPluginLoader::load("./plugin.wasm").await?;
runtime.register_plugin(plugin);
```

## Building Cross-Language Plugins

### Rust Plugin (for TS + Python)

```bash
# For TypeScript (WASM)
cargo build --target wasm32-unknown-unknown --release --features wasm
wasm-bindgen target/wasm32-unknown-unknown/release/plugin.wasm --out-dir dist

# For Python (FFI)
cargo build --release --features ffi
```

### Python Plugin (for TS)

```bash
# Install the plugin
pip install my-plugin

# TypeScript will spawn it via IPC automatically
```

## Performance Considerations

| Method | Latency | Throughput | Memory |
|--------|---------|------------|--------|
| Native | ~1μs | Highest | Shared |
| WASM | ~10μs | High | Isolated |
| FFI | ~5μs | High | Shared |
| IPC | ~1ms | Medium | Separate |

## Security Considerations

1. **WASM**: Sandboxed execution, no direct system access
2. **FFI**: Full system access, requires trust
3. **IPC**: Process isolation, but can spawn with reduced privileges

## Future Work

1. **PyO3 integration**: Native Python ↔ Rust without FFI overhead
2. **Shared memory IPC**: Faster Python ↔ TypeScript communication
3. **Plugin marketplace**: Centralized discovery of cross-language plugins
4. **Hot reloading**: Reload plugins without runtime restart

