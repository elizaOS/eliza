# elizaOS Roblox Plugin - Rust Implementation

Rust implementation of the Roblox plugin for elizaOS, providing high-performance game communication via the Roblox Open Cloud API.

## Features

- **Messaging Service**: Cross-server communication with Roblox games
- **DataStore**: Persistent data storage operations
- **User Lookup**: Get player information by ID or username
- **Experience Info**: Retrieve universe/experience metadata
- **Dry Run Mode**: Test without making actual API calls

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-roblox = "2.0"
```

## Usage

```rust
use elizaos_plugin_roblox::{RobloxClient, RobloxConfig, RobloxService};
use uuid::Uuid;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create config from environment or manually
    let config = RobloxConfig::from_env()?;
    // Or: RobloxConfig::new("your-api-key", "universe-id")

    // Create and start service
    let service = RobloxService::new(config, Uuid::new_v4(), "MyAgent")?;
    service.start().await?;

    // Send a message to the game
    service.send_message("Hello from Eliza!", None).await?;

    // Execute a game action
    service.execute_action(
        "spawn_item",
        serde_json::json!({ "item": "sword", "rarity": "legendary" }),
        Some(vec![12345678]), // Target specific player
    ).await?;

    Ok(())
}
```

## Configuration

### Environment Variables

| Variable                 | Required | Description                              |
| ------------------------ | -------- | ---------------------------------------- |
| `ROBLOX_API_KEY`         | Yes      | Roblox Open Cloud API key                |
| `ROBLOX_UNIVERSE_ID`     | Yes      | Universe ID of the experience            |
| `ROBLOX_PLACE_ID`        | No       | Specific place ID                        |
| `ROBLOX_WEBHOOK_SECRET`  | No       | Secret for webhook validation            |
| `ROBLOX_MESSAGING_TOPIC` | No       | Messaging topic (default: "eliza-agent") |
| `ROBLOX_POLL_INTERVAL`   | No       | Poll interval in seconds (default: 30)   |
| `ROBLOX_DRY_RUN`         | No       | Enable dry run mode (default: false)     |

## API Reference

### RobloxClient

The low-level API client for Roblox Open Cloud:

```rust
// Messaging
client.publish_message("topic", data, None).await?;
client.send_agent_message(&message).await?;

// DataStore
let entry = client.get_datastore_entry::<MyData>("store", "key", None).await?;
client.set_datastore_entry("store", "key", &value, None).await?;
client.delete_datastore_entry("store", "key", None).await?;

// Users
let user = client.get_user_by_id(12345678).await?;
let user = client.get_user_by_username("PlayerName").await?;
let avatar = client.get_avatar_url(12345678, None).await?;

// Experience
let info = client.get_experience_info(None).await?;
```

### RobloxService

High-level service for elizaOS integration:

```rust
let service = RobloxService::new(config, agent_id, "AgentName")?;

service.start().await?;
service.send_message("Hello!", None).await?;
service.execute_action("action_name", params, None).await?;
service.stop().await?;
```

## Testing

```bash
cargo test
```

## Building

```bash
# Native build
cargo build --release

# WebAssembly build
cargo build --release --target wasm32-unknown-unknown --features wasm --no-default-features
```

## License

MIT



