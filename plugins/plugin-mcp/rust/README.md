# elizaOS MCP Plugin (Rust)

A Rust implementation of the Model Context Protocol (MCP) client for elizaOS agents.

## Features

- **Stdio Transport**: Connect to MCP servers via stdio (subprocess)
- **Strong Typing**: Full type safety with Rust's type system
- **Fail-Fast Validation**: Strict validation with no error swallowing
- **Async/Await**: Built on Tokio for efficient async operations
- **WASM Support**: Optional WebAssembly compilation target

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-mcp = "1.7.0"
```

## Usage

```rust
use elizaos_plugin_mcp::{McpClient, StdioTransport, StdioServerConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Create a stdio transport
    let config = StdioServerConfig {
        command: "npx".to_string(),
        args: vec!["-y".to_string(), "@modelcontextprotocol/server-memory".to_string()],
        env: Default::default(),
        cwd: None,
        timeout_ms: 60000,
    };

    let transport = StdioTransport::new(config);
    let mut client = McpClient::new(Box::new(transport));

    // Connect to the server
    client.connect().await?;

    // List available tools
    let tools = client.list_tools().await?;
    for tool in &tools {
        println!("Tool: {} - {}", tool.name, tool.description);
    }

    // Call a tool
    let result = client.call_tool(
        "store_memory",
        serde_json::json!({
            "key": "greeting",
            "value": "Hello, World!"
        }),
    ).await?;
    println!("Result: {:?}", result);

    // Close the connection
    client.close().await?;

    Ok(())
}
```

## Building

```bash
# Build for native
cargo build --release

# Build for WASM (requires wasm-pack)
wasm-pack build --target nodejs --out-dir pkg/node --features wasm
```

## Testing

```bash
# Run tests
cargo test

# Run tests with output
cargo test -- --nocapture
```

## License

MIT License - see LICENSE file for details.
