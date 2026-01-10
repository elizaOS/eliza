# elizaOS Bootstrap Plugin (Rust)

Rust implementation of the elizaOS Bootstrap Plugin, providing core agent actions, providers, evaluators, and services.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-bootstrap = "2.0.0-alpha.0"
```

## Features

### Actions

- **REPLY** - Generate and send a response message
- **IGNORE** - Ignore the current message
- **NONE** - Take no action
- **FOLLOW_ROOM** - Follow a room for updates
- **UNFOLLOW_ROOM** - Stop following a room
- **MUTE_ROOM** - Mute notifications from a room
- **UNMUTE_ROOM** - Unmute a room
- **GENERATE_IMAGE** - Generate images using AI models
- **UPDATE_ROLE** - Update entity roles
- **UPDATE_SETTINGS** - Modify agent settings
- **SEND_MESSAGE** - Send a message to a specific target
- **UPDATE_ENTITY** - Update entity information
- **CHOOSE_OPTION** - Select from available options

### Providers

- **CHARACTER** - Agent character definition and personality
- **RECENT_MESSAGES** - Recent conversation history
- **CURRENT_TIME** - Current time and date
- **WORLD** - World context and settings
- **ENTITIES** - Information about participants
- **KNOWLEDGE** - Relevant knowledge from the knowledge base
- **FACTS** - Known facts about entities
- **ACTION_STATE** - Current action state
- **AGENT_SETTINGS** - Agent configuration

### Evaluators

- **GOAL** - Evaluate progress toward goals
- **REFLECTION** - Reflect on agent behavior

### Services

- **TaskService** - Task management and tracking
- **EmbeddingService** - Text embedding generation

## Usage

```rust
use elizaos_plugin_bootstrap::BootstrapPlugin;

// Create the plugin
let plugin = BootstrapPlugin::new();

// Register with the agent runtime
runtime.register_plugin(plugin).await?;
```

## Development

### Building

```bash
cargo build
```

### Testing

```bash
# Unit tests
cargo test

# Integration tests (requires running services)
cargo test --features integration-tests
```

### Linting

```bash
cargo clippy -- -D warnings
```

### Formatting

```bash
cargo fmt
```

## License

MIT License - see LICENSE file for details.

