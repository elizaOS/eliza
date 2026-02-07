# elizaos-plugin-acp

Rust implementation of the ACP (Agentic Commerce Protocol) plugin for elizaOS.

## Features

- `native` (default): Full async support with tokio and reqwest
- `wasm`: WebAssembly support with JavaScript interop

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-acp = "2.0.0"
```

For WASM support:

```toml
[dependencies]
elizaos-plugin-acp = { version = "2.0.0", default-features = false, features = ["wasm"] }
```

## Usage

```rust
use elizaos_plugin_acp::{AcpClient, AcpClientConfig, CreateCheckoutSessionRequest, Item};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create client from environment
    let config = AcpClientConfig::from_env()?;
    let client = AcpClient::new(config)?;
    
    // Create a checkout session
    let request = CreateCheckoutSessionRequest {
        currency: "USD".to_string(),
        line_items: vec![Item {
            id: "item_123".to_string(),
            name: Some("Widget".to_string()),
            unit_amount: Some(1000),
            quantity: Some(2),
        }],
        ..Default::default()
    };
    
    let session = client.create_checkout_session(request, None).await?;
    println!("Session ID: {}", session.id);
    println!("Status: {:?}", session.status);
    
    Ok(())
}
```

## Environment Variables

- `ACP_MERCHANT_BASE_URL` (required): Base URL of the merchant API
- `ACP_MERCHANT_API_KEY` (optional): API key for authentication
- `ACP_REQUEST_TIMEOUT` (optional): Request timeout in seconds (default: 30)
- `ACP_API_VERSION` (optional): API version (default: 2026-01-30)

## Running Tests

```bash
cargo test
```

With all features:

```bash
cargo test --all-features
```

## License

MIT
