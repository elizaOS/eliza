# elizaOS N8n Plugin - Rust

AI-powered plugin creation for ElizaOS using Claude models.

## Features

- `native` (default): Full async support with tokio
- `wasm`: WebAssembly support for browser environments

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-n8n = "1.0"
```

## Quick Start

```rust
use elizaos_plugin_n8n::{N8nConfig, PluginCreationClient, PluginSpecification};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create configuration from environment
    let config = N8nConfig::from_env()?;

    // Create client
    let client = PluginCreationClient::new(config)?;

    // Define plugin specification
    let spec = PluginSpecification::builder()
        .name("@elizaos/plugin-weather")
        .description("Weather information plugin")
        .build()?;

    // Create plugin
    let job_id = client.create_plugin(spec, None).await?;
    println!("Job started: {}", job_id);

    // Check status
    if let Some(job) = client.get_job_status(&job_id).await {
        println!("Status: {}", job.status);
    }

    Ok(())
}
```

## Configuration

Set the following environment variables:

- `ANTHROPIC_API_KEY` (required): Your Anthropic API key
- `PLUGIN_DATA_DIR` (optional): Directory for plugin workspace
- `CLAUDE_MODEL` (optional): Model to use (default: claude-3-opus-20240229)

## API Reference

### N8nConfig

Configuration for the plugin creation service.

```rust
let config = N8nConfig::new("your-api-key")
    .with_model(ClaudeModel::Opus3)
    .with_data_dir("./data");
```

### PluginCreationClient

Main client for creating plugins.

```rust
let client = PluginCreationClient::new(config)?;

// Create a plugin
let job_id = client.create_plugin(spec, None).await?;

// Get job status
let job = client.get_job_status(&job_id).await;

// Cancel a job
client.cancel_job(&job_id).await;

// Get all jobs
let jobs = client.get_all_jobs().await;

// Cleanup old jobs
let count = client.cleanup_old_jobs(7).await;
```

### PluginSpecification

Define your plugin specification using the builder:

```rust
let spec = PluginSpecification::builder()
    .name("@scope/plugin-name")
    .description("Plugin description")
    .version("1.0.0")
    .action(ActionSpecification {
        name: "actionName".to_string(),
        description: "Action description".to_string(),
        parameters: None,
    })
    .build()?;
```

## Development

```bash
# Build
cargo build

# Run tests
cargo test

# Clippy
cargo clippy --all-targets -- -D warnings

# Format
cargo fmt
```

## License

MIT



