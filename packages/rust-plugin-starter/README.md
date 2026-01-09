# elizaOS Rust Plugin Starter

A template for creating elizaOS plugins in Rust that can be loaded by both the TypeScript and Python runtimes.

## Features

- 🦀 **Native Rust performance**
- 🌐 **WASM export** for TypeScript runtime
- 🐍 **FFI export** for Python runtime
- 📦 **Zero-copy JSON serialization** with serde
- 🧪 **Unit tests included**

## Building

### For TypeScript (WASM)

```bash
# Install wasm-pack if you haven't already
cargo install wasm-pack

# Build the WASM module
wasm-pack build --target web --features wasm

# Or manually:
cargo build --target wasm32-unknown-unknown --release --features wasm
wasm-bindgen target/wasm32-unknown-unknown/release/elizaos_plugin_starter.wasm --out-dir dist --target web
```

### For Python (FFI)

```bash
# Build the shared library
cargo build --release --features ffi

# The output will be in:
# - Linux: target/release/libelizaos_plugin_starter.so
# - macOS: target/release/libelizaos_plugin_starter.dylib
# - Windows: target/release/elizaos_plugin_starter.dll
```

## Usage

### In TypeScript

```typescript
import { loadWasmPlugin } from '@elizaos/core/interop';

const plugin = await loadWasmPlugin({
  wasmPath: './dist/elizaos_plugin_starter.wasm'
});

// Register with runtime
await runtime.registerPlugin(plugin);

// The HELLO_RUST action is now available
```

### In Python

```python
from elizaos.interop import load_rust_plugin

plugin = load_rust_plugin("./target/release/libelizaos_plugin_starter.so")
await runtime.register_plugin(plugin)

# The HELLO_RUST action is now available
```

## Plugin Structure

```
rust-plugin-starter/
├── Cargo.toml           # Rust dependencies and features
├── src/
│   └── lib.rs           # Main plugin implementation
├── dist/                # Built WASM files (after build)
└── README.md
```

## Creating Your Own Plugin

1. Copy this template
2. Update `Cargo.toml` with your plugin name
3. Implement your actions in `src/lib.rs`:

```rust
impl StarterPlugin {
    pub fn validate_action(&self, name: &str, memory: &Memory, state: Option<&State>) -> bool {
        match name {
            "MY_ACTION" => true,  // Add your action validation
            _ => false,
        }
    }

    pub fn invoke_action(
        &self,
        name: &str,
        memory: &Memory,
        state: Option<&State>,
        options: Option<&HandlerOptions>,
    ) -> ActionResult {
        match name {
            "MY_ACTION" => {
                // Your action logic here
                ActionResult::success_with_text("Done!")
            }
            _ => ActionResult::failure("Unknown action"),
        }
    }
}
```

4. Update the `manifest()` method to declare your actions:

```rust
pub fn manifest(&self) -> serde_json::Value {
    serde_json::json!({
        "name": "my-rust-plugin",
        "description": "My custom Rust plugin",
        "version": "1.0.0",
        "language": "rust",
        "actions": [
            {
                "name": "MY_ACTION",
                "description": "Does something cool"
            }
        ]
    })
}
```

## API Reference

### ActionResult

```rust
// Success with text
ActionResult::success_with_text("Hello!")

// Success with data
ActionResult {
    success: true,
    data: Some(your_data),
    ..Default::default()
}

// Failure
ActionResult::failure("Something went wrong")
```

### ProviderResult

```rust
ProviderResult {
    text: Some("Provider context text".to_string()),
    values: Some(key_value_map),
    data: Some(structured_data),
}
```

## Testing

```bash
cargo test
```

## License

MIT

