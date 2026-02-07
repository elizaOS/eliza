# elizaOS Copilot Proxy Plugin (Rust)

Rust implementation of the Copilot Proxy model provider plugin for elizaOS.

## Features

- OpenAI-compatible API client for Copilot Proxy
- Support for text generation (small and large models)
- JSON object generation with automatic parsing
- Health check functionality
- Configurable timeouts and model parameters

## Usage

```rust
use elizaos_plugin_copilot_proxy::{CopilotProxyPlugin, CopilotProxyConfig};

// Create configuration
let config = CopilotProxyConfig::new()
    .base_url("http://localhost:3000/v1")
    .small_model("gpt-5-mini")
    .large_model("gpt-5.1");

// Create plugin
let plugin = CopilotProxyPlugin::new(config)?;

// Generate text
let response = plugin.generate_text("What is 2+2?").await?;
println!("{}", response);
```

## Environment Variables

- `COPILOT_PROXY_BASE_URL` - Base URL for the proxy server (default: `http://localhost:3000/v1`)
- `COPILOT_PROXY_ENABLED` - Enable/disable the plugin (default: `true`)
- `COPILOT_PROXY_SMALL_MODEL` - Small model ID (default: `gpt-5-mini`)
- `COPILOT_PROXY_LARGE_MODEL` - Large model ID (default: `gpt-5.1`)
- `COPILOT_PROXY_TIMEOUT_SECONDS` - Request timeout (default: `120`)
- `COPILOT_PROXY_MAX_TOKENS` - Maximum tokens (default: `8192`)
- `COPILOT_PROXY_CONTEXT_WINDOW` - Context window size (default: `128000`)

## License

MIT
