# elizaOS Cross-Language Plugin Interoperability

This module provides seamless interoperability between elizaOS runtimes written in different languages (Rust, TypeScript, Python). **Any runtime can load any plugin**, regardless of the language it was written in.

## Architecture Overview

```
                          ┌─────────────────────────────────────┐
                          │     Protocol Buffer Schemas          │
                          │   (Single source of truth for types) │
                          └──────────────────┬──────────────────┘
                                             │
              ┌──────────────────────────────┼──────────────────────────────┐
              ▼                              ▼                              ▼
    ┌─────────────────┐            ┌─────────────────┐            ┌─────────────────┐
    │   RUST RUNTIME  │            │   TS RUNTIME    │            │  PYTHON RUNTIME │
    │                 │            │                 │            │                 │
    │ • Native Rust   │            │ • Native TS     │            │ • Native Python │
    │ • TS via IPC    │◄──────────►│ • Rust via WASM │◄──────────►│ • Rust via FFI  │
    │ • Python via IPC│            │ • Python via IPC│            │ • TS via IPC    │
    └─────────────────┘            └─────────────────┘            └─────────────────┘
              │                              │                              │
              └──────────────────────────────┴──────────────────────────────┘
                                             │
                                    ┌────────┴────────┐
                                    ▼                 ▼
                          ┌─────────────┐   ┌─────────────────┐
                          │   PLUGINS   │   │  TEST PLUGINS   │
                          │             │   │                 │
                          │ • Rust      │   │ • eliza-classic │
                          │ • TypeScript│   │ • inmemorydb    │
                          │ • Python    │   │                 │
                          └─────────────┘   └─────────────────┘
```

## Complete Interop Matrix

Every combination is supported:

| Host Runtime   | Plugin Language | Method | Performance | Sandboxed |
| -------------- | --------------- | ------ | ----------- | --------- |
| **TypeScript** | Rust            | WASM   | High        | ✅ Yes    |
| **TypeScript** | Python          | IPC    | Medium      | ✅ Yes    |
| **TypeScript** | TypeScript      | Direct | Native      | ❌ No     |
| **Python**     | Rust            | FFI    | Native      | ❌ No     |
| **Python**     | Rust            | WASM   | High        | ✅ Yes    |
| **Python**     | TypeScript      | IPC    | Medium      | ✅ Yes    |
| **Python**     | Python          | Direct | Native      | ❌ No     |
| **Rust**       | TypeScript      | IPC    | Medium      | ✅ Yes    |
| **Rust**       | Python          | IPC    | Medium      | ✅ Yes    |
| **Rust**       | Rust            | Direct | Native      | ❌ No     |

## Interop Methods

### 1. **WASM (WebAssembly)** - Rust ↔ TypeScript

- Rust plugins compile to WASM via `wasm-bindgen`
- TypeScript runtime loads WASM modules dynamically
- High performance, sandboxed execution

### 2. **PyO3/FFI** - Rust ↔ Python

- Rust plugins expose Python bindings via PyO3
- Python can call Rust code directly via FFI
- Native performance, type-safe

### 3. **IPC (Inter-Process Communication)** - Any ↔ Any

- JSON-RPC over Unix sockets or TCP
- Works for all language combinations
- Flexible but has serialization overhead

### 4. **subprocess** - TypeScript/Python host ↔ Rust/Python plugin

- Spawn plugin as subprocess
- Communicate via stdin/stdout JSON
- Simplest to implement, good isolation

## Usage

### Loading a Rust Plugin in TypeScript

```typescript
import { loadWasmPlugin } from "@elizaos/interop";

const plugin = await loadWasmPlugin("./my-rust-plugin.wasm");
runtime.registerPlugin(plugin);
```

### Loading a TypeScript Plugin in Rust

```rust
use elizaos::interop::WasmPluginLoader;

let plugin = WasmPluginLoader::load("./my-ts-plugin.wasm").await?;
runtime.register_plugin(plugin);
```

### Loading a Python Plugin in TypeScript

```typescript
import { loadPythonPlugin } from "@elizaos/interop";

const plugin = await loadPythonPlugin("my_python_plugin");
runtime.registerPlugin(plugin);
```

### Loading a Rust Plugin in Python

```python
from elizaos.interop import load_rust_plugin

plugin = load_rust_plugin("./my_rust_plugin.so")
await runtime.register_plugin(plugin)
```

## Plugin Manifest

Every cross-language plugin must include a `plugin.json` manifest:

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
      "description": "Does something cool"
    }
  ]
}
```

## Building Cross-Language Plugins

### Rust → WASM (for TypeScript)

```bash
cd packages/my-rust-plugin
cargo build --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/my_plugin.wasm --out-dir dist
```

### Rust → Python Extension

```bash
cd packages/my-rust-plugin
maturin build --release
pip install target/wheels/my_plugin-*.whl
```

### TypeScript → WASM (experimental)

```bash
# Using AssemblyScript or similar
cd packages/my-ts-plugin
asc src/index.ts -o dist/plugin.wasm
```

## Protocol Messages

All interop communication uses JSON-serialized messages:

### Action Invocation

```json
{
  "type": "action.invoke",
  "id": "uuid",
  "action": "MY_ACTION",
  "memory": { ... },
  "state": { ... },
  "options": { ... }
}
```

### Action Response

```json
{
  "type": "action.result",
  "id": "uuid",
  "result": {
    "success": true,
    "text": "Action completed",
    "data": { ... }
  }
}
```

### Provider Request

```json
{
  "type": "provider.get",
  "id": "uuid",
  "provider": "MY_PROVIDER",
  "memory": { ... },
  "state": { ... }
}
```

### Provider Response

```json
{
  "type": "provider.result",
  "id": "uuid",
  "result": {
    "text": "Provider data",
    "values": { ... },
    "data": { ... }
  }
}
```

## Quick Start Examples

### TypeScript Loading Any Plugin

```typescript
import { loadPlugin, loadWasmPlugin, loadPythonPlugin } from "@elizaos/interop";

// Universal loader (auto-detects from manifest)
const plugin = await loadPlugin("./path/to/plugin");

// Or be explicit:
const rustPlugin = await loadWasmPlugin("./rust-plugin.wasm");
const pythonPlugin = await loadPythonPlugin("./python-plugin");

// Use like any native plugin
runtime.registerPlugin(plugin);
```

### Python Loading Any Plugin

```python
from elizaos.interop import load_plugin, load_rust_plugin, load_ts_plugin, load_wasm_plugin

# Universal loader
plugin = load_plugin('./path/to/plugin')

# Or be explicit:
rust_ffi_plugin = load_rust_plugin('./libplugin.so')     # FFI
rust_wasm_plugin = load_wasm_plugin('./plugin.wasm')     # WASM
ts_plugin = load_ts_plugin('./typescript-plugin')        # IPC

# Use like any native plugin
await runtime.register_plugin(plugin)
```

### Rust Loading Any Plugin

```rust
use elizaos::interop::{load_plugin, TypeScriptPluginLoader, PythonPluginLoader};

// Via IPC subprocess
let ts_plugin = TypeScriptPluginLoader::new().load("./ts-plugin")?;
let py_plugin = PythonPluginLoader::new().load("./python-plugin")?;

// Native Rust - just use directly!
use my_rust_plugin::plugin;
runtime.register_plugin(plugin);
```

## Test Plugins

Two reference plugins demonstrate all interop paths:

### plugin-eliza-classic

Classic ELIZA pattern matching chatbot, implemented in all three languages:

```bash
# Rust (with WASM + FFI + IPC support)
cd plugins/plugin-eliza-classic/rust
cargo build --features wasm,ffi,ipc

# Python
cd plugins/plugin-eliza-classic/python
pip install -e .

# TypeScript
cd plugins/plugin-eliza-classic/typescript
pnpm build
```

### plugin-inmemorydb

Ephemeral in-memory database adapter with vector search:

```bash
# Available in all three languages with identical API
plugins/plugin-inmemorydb/
├── rust/       # Native Rust implementation
├── python/     # Native Python implementation
└── typescript/ # Native TypeScript implementation
```

## Building Plugins for Interop

### Rust Plugin (WASM + FFI + IPC)

```toml
# Cargo.toml
[features]
wasm = ["wasm-bindgen"]
ffi = []
ipc = ["tokio"]

[lib]
crate-type = ["cdylib", "rlib"]
```

```bash
# WASM for TypeScript
cargo build --target wasm32-unknown-unknown --features wasm

# Shared lib for Python FFI
cargo build --release --features ffi

# IPC server binary
cargo build --features ipc --bin my-plugin-ipc
```

### Python Plugin (IPC)

```python
# my_plugin/__init__.py
from elizaos import Plugin

plugin = Plugin(
    name="my-plugin",
    actions=[...],
    providers=[...],
)

# Can be loaded via:
# python -m elizaos.interop.bridge_server my_plugin
```

### TypeScript Plugin (IPC)

```typescript
// index.ts
export const plugin: Plugin = {
  name: 'my-plugin',
  actions: [...],
  providers: [...],
};

// Can be loaded via ts-bridge-server
```

## File Structure

```
packages/interop/
├── README.md                 # This file
├── examples/                 # Complete examples for all interop paths
│   ├── README.md            # Example documentation
│   ├── ts-loads-all.ts      # TypeScript loading all languages
│   ├── py_loads_all.py      # Python loading all languages
│   └── rust_loads_all.rs    # Rust loading all languages
├── typescript/               # TypeScript interop implementations
│   ├── index.ts             # Main exports
│   ├── wasm-loader.ts       # Load Rust WASM plugins
│   ├── python-bridge.ts     # IPC bridge to Python plugins
│   └── types.ts             # Interop types
├── rust/                     # Rust interop implementations
│   ├── mod.rs               # Module exports
│   ├── wasm_plugin.rs       # WASM export traits/macros
│   ├── ffi_exports.rs       # FFI export for Python
│   ├── ts_loader.rs         # Load TypeScript via IPC
│   └── py_loader.rs         # Load Python via IPC
└── python/                   # Python interop implementations
    ├── __init__.py          # Package exports
    ├── rust_ffi.py          # Load Rust via ctypes FFI
    ├── wasm_loader.py       # Load Rust via wasmtime
    ├── ts_bridge.py         # Load TypeScript via IPC
    └── bridge_server.py     # IPC server for Python plugins
```

## Performance Comparison

| Method     | Latency | Throughput | Memory   | Use Case                   |
| ---------- | ------- | ---------- | -------- | -------------------------- |
| **Direct** | ~1ns    | Highest    | Shared   | Same language              |
| **WASM**   | ~1μs    | High       | Isolated | TS↔Rust, sandboxed         |
| **FFI**    | ~10ns   | Very High  | Shared   | Python↔Rust, perf-critical |
| **IPC**    | ~1ms    | Medium     | Isolated | Any↔Any, maximum isolation |

**Recommendations:**

- Use **Direct** when host and plugin are same language
- Use **WASM** for TypeScript↔Rust when sandboxing is important
- Use **FFI** for Python↔Rust when performance is critical
- Use **IPC** for maximum flexibility and isolation

## Security & SOC2 Readiness Notes

This package is often used at a trust boundary (loading plugins). For SOC 2–aligned deployments:

### Sandbox boundaries (be explicit)

- **Direct (same-language)**: no sandbox. Plugin code runs with full process privileges.
- **FFI (Python↔Rust shared library)**: **no sandbox**. This is native code execution in the host process.
- **IPC (subprocess stdin/stdout)**: isolates memory space, but **does not prevent exfiltration** (plugins can still perform network/file I/O unless the operator constrains the process).
- **WASM**: provides isolation from host memory, but security depends on the host runtime imports and resource limits. It is not an automatic “secure enclave.”

### Resource limits (recommended defaults)

- **TypeScript→Python IPC** (`packages/interop/typescript/python-bridge.ts`)
  - Supports `maxPendingRequests`, `maxMessageBytes`, and `maxBufferBytes` to prevent unbounded memory growth from malformed or hostile plugin output.
  - Supports `inheritEnv` and `envDenylist` to reduce accidental secret exposure to subprocesses.

- **WASM loading**
  - TypeScript loader supports `maxWasmBytes` and `maxMemoryBytes` to limit module and initial memory footprint, and provides a secure `random_get` implementation for WASI.
  - Python loader supports `max_module_bytes`, `max_memory_bytes`, and `fuel` (wasmtime fuel) for coarse CPU budgeting.

### Logging

Interop subprocess/WASM output is routed through the core logger (when used from the TypeScript runtime) so existing redaction rules apply. Operators should still treat plugin logs as potentially sensitive and configure log retention accordingly.

## See Also

- [Examples README](./examples/README.md) - Complete working examples
- [Protocol Buffers Schemas](../@schemas/README.md) - Type definitions
- [plugin-eliza-classic](../../plugins/plugin-eliza-classic/) - Reference implementation
- [plugin-inmemorydb](../../plugins/plugin-inmemorydb/) - Database adapter example
