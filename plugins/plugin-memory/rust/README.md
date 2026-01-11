# elizaOS Memory Plugin - Rust

Advanced memory management plugin for elizaOS with conversation summarization and long-term persistent memory.

## Features

- **Short-term Memory (Conversation Summarization)**
  - Automatically summarizes long conversations to reduce context size
  - Retains recent messages while archiving older ones as summaries
  - Configurable thresholds for when to summarize

- **Long-term Memory (Persistent Facts)**
  - Extracts and stores persistent facts about users
  - Categorizes information using cognitive science principles:
    - **Episodic**: Specific events and experiences
    - **Semantic**: General facts and knowledge
    - **Procedural**: Skills and workflows
  - Provides context-aware user profiles across all conversations

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-memory = "1.0"
```

## Usage

```rust
use elizaos_plugin_memory::{MemoryService, MemoryConfig, LongTermMemoryCategory};
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Create configuration
    let config = MemoryConfig::default();

    // Initialize service
    let service = MemoryService::new(config);

    // Store a long-term memory
    let agent_id = Uuid::new_v4();
    let entity_id = Uuid::new_v4();

    let memory = service.store_long_term_memory(
        agent_id,
        entity_id,
        LongTermMemoryCategory::Semantic,
        "User is a Rust developer".to_string(),
        0.95,
        Some("conversation".to_string()),
        None,
        None,
    ).await?;

    println!("Stored memory: {:?}", memory);

    Ok(())
}
```

## Configuration

| Setting                          | Default | Description                   |
| -------------------------------- | ------- | ----------------------------- |
| `MEMORY_SUMMARIZATION_THRESHOLD` | 16      | Messages before summarization |
| `MEMORY_RETAIN_RECENT`           | 6       | Recent messages to keep       |
| `MEMORY_LONG_TERM_ENABLED`       | true    | Enable long-term extraction   |
| `MEMORY_CONFIDENCE_THRESHOLD`    | 0.85    | Minimum confidence to store   |

## Development

```bash
# Build
cargo build

# Run tests
cargo test

# Check lints
cargo clippy --all-targets -- -D warnings
```

## License

MIT



