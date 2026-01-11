# Interop Guide (TypeScript / Rust / Python)

## Overview

ElizaOS supports **cross-language plugins** and runtime interoperability via the `packages/interop/` package.

The design goals are:

- A **language-neutral plugin contract** (schema + manifest)
- Multiple transport options depending on environment constraints:
  - **WASM** for Rust ↔ TypeScript
  - **FFI** for Rust ↔ Python
  - **subprocess IPC** for TypeScript ↔ Python (and generally “any ↔ any” with JSON messages)

## Key files

- **IDL / schema**
  - `packages/interop/plugin.schema.json` (referenced by `packages/interop/README.md`)
- **TypeScript interop**
  - `packages/interop/typescript/wasm-loader.ts`
  - `packages/interop/typescript/python-bridge.ts`
  - `packages/interop/typescript/types.ts`
- **Rust interop**
  - `packages/interop/rust/wasm_plugin.rs`
  - `packages/interop/rust/ffi_exports.rs`
- **Python interop**
  - `packages/interop/python/bridge_server.py`
  - `packages/interop/python/rust_ffi.py`

## The plugin contract (what crosses the boundary)

At a minimum, interop requires a **plugin manifest** that can describe a plugin’s name, version, language, and the capabilities it exposes (actions/providers/evaluators/services/routes).

In practice, interop implementations in this repo exchange:

- **Manifest/metadata** (to discover capabilities)
- **Invocation requests** (invoke action, get provider result, etc.)
- **Invocation results** (action result, provider result, evaluator result)

All transports serialize **inputs and outputs as JSON** so the same data model can be shared across TypeScript, Rust, and Python.

## WASM: Rust ↔ TypeScript

When using WASM:

- Rust plugins compile to `wasm32-unknown-unknown` and export functions via `wasm-bindgen`.
- TypeScript loads the `.wasm` module and wraps exports into a `Plugin`-shaped adapter that the runtime can register.

See:

- Conceptual architecture + example usage in `packages/interop/README.md`
- Loader implementation in `packages/interop/typescript/wasm-loader.ts`
- Rust-side exports and glue in `packages/interop/rust/wasm_plugin.rs`

## FFI: Rust ↔ Python

When using FFI:

- Rust exposes a C ABI (returning JSON strings) via `packages/interop/rust/ffi_exports.rs`.
- Python uses `ctypes` to load a shared library and call those functions (`packages/interop/python/rust_ffi.py`).
- Memory ownership is explicit: Rust allocates returned strings and exports a free function so Python can release them.

## Subprocess IPC: TypeScript ↔ Python

When using subprocess IPC:

- TypeScript spawns a Python process and communicates over stdin/stdout.
- Messages are newline-delimited JSON objects, supporting request/response correlation with an `id`.

Reference:

- Protocol examples in `packages/interop/README.md` (“Protocol Messages”)
- Python server implementation: `packages/interop/python/bridge_server.py`
- TypeScript client: `packages/interop/typescript/python-bridge.ts`

## When to choose which language

- **TypeScript**: primary runtime implementation and plugin ecosystem; best for integrations and I/O-heavy plugins.
- **Rust**: performance-critical logic; sandboxable and portable via WASM; good for crypto, parsing, CPU-heavy transforms.
- **Python**: best access to ML/data ecosystem; good when you want to leverage Python-native libraries (PyTorch, etc.).

## Testing interop

Interop unit tests live in:

- `packages/interop/typescript/__tests__/`
- `packages/rust/__tests__/` (including interop equivalence tests)

