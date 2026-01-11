# elizaos-plugin-anthropic

Rust implementation of the Anthropic Claude API client for elizaOS.

## Features

- Text generation with Claude models
- Structured JSON object generation
- Strong types with no `any` or `unknown` equivalents
- Fail-fast error handling
- Support for chain-of-thought (thinking) responses
- Both native and WASM targets

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-anthropic = "1.0"
```

## Usage

### Text Generation

```rust
use elizaos_plugin_anthropic::{AnthropicClient, AnthropicConfig, TextGenerationParams};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AnthropicConfig::from_env()?;
    let client = AnthropicClient::new(config)?;

    let params = TextGenerationParams::new("What is the meaning of life?")
        .with_max_tokens(1024)
        .with_temperature(0.7);

    let response = client.generate_text_large(params).await?;
    println!("Response: {}", response.text);
    println!("Tokens used: {}", response.usage.total_tokens());

    Ok(())
}
```

### JSON Object Generation

```rust
use elizaos_plugin_anthropic::{AnthropicClient, AnthropicConfig, ObjectGenerationParams};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AnthropicConfig::from_env()?;
    let client = AnthropicClient::new(config)?;

    let params = ObjectGenerationParams::new(
        "Create a JSON object with name, age, and email fields"
    );

    let response = client.generate_object_small(params).await?;
    println!("Generated: {}", serde_json::to_string_pretty(&response.object)?);

    Ok(())
}
```

## Configuration

Environment variables:

| Variable                    | Required | Default                     | Description            |
| --------------------------- | -------- | --------------------------- | ---------------------- |
| `ANTHROPIC_API_KEY`         | Yes      | -                           | Your Anthropic API key |
| `ANTHROPIC_BASE_URL`        | No       | `https://api.anthropic.com` | API base URL           |
| `ANTHROPIC_SMALL_MODEL`     | No       | `claude-3-5-haiku-20241022` | Small model ID         |
| `ANTHROPIC_LARGE_MODEL`     | No       | `claude-sonnet-4-20250514`  | Large model ID         |
| `ANTHROPIC_TIMEOUT_SECONDS` | No       | `60`                        | Request timeout        |

## Models

Available models:

| Model                        | Size  | Description          |
| ---------------------------- | ----- | -------------------- |
| `claude-3-5-haiku-20241022`  | Small | Fast and efficient   |
| `claude-sonnet-4-20250514`   | Large | Most capable         |
| `claude-3-5-sonnet-20241022` | Large | Balanced performance |
| `claude-3-opus-20240229`     | Large | Previous flagship    |

## Testing

Run unit tests:

```bash
cargo test
```

Run integration tests (requires API key):

```bash
# Create .env file with your API key
echo "ANTHROPIC_API_KEY=your-key" > .env

# Run integration tests
cargo test --features native -- --ignored
```

## License

MIT
