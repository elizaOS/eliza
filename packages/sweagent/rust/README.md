# SWE-agent Rust Implementation

Rust implementation of SWE-agent with native and WebAssembly support.

## Features

- **Native Feature** (default): Full async support with Tokio
- **WASM Feature**: WebAssembly support for browser environments

## Usage

```rust
use elizaos_sweagent::run::{RunSingle, RunSingleConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = RunSingleConfig::default();
    let mut runner = RunSingle::from_config(config)?;
    let result = runner.run().await?;
    println!("Exit status: {:?}", result.info.exit_status);
    Ok(())
}
```

## Building

```bash
# Build native
cargo build --release

# Build for WASM
cargo build --target wasm32-unknown-unknown --features wasm --no-default-features
```

## Testing

```bash
cargo test
```

## CLI

```bash
cargo run --bin sweagent -- run --help
```

## License

MIT
