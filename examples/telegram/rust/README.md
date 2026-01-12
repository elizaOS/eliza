# Telegram Agent - Rust

A complete Telegram bot agent using elizaOS with SQL persistence.

## Features

- 🤖 Full Telegram bot integration (private chats, groups, reactions)
- 💾 PostgreSQL or PGLite database persistence
- 🧠 OpenAI-powered language model
- 🔄 Automatic message handling and responses
- 📝 Conversation memory and context
- ⚡ High-performance async Rust implementation

## Prerequisites

1. **Rust 1.75+** with Cargo
2. **Telegram Bot Token**: Get one from [@BotFather](https://t.me/BotFather)
3. **OpenAI API Key**: Get one from [OpenAI Platform](https://platform.openai.com)

## Setup

1. Set environment variables:
```bash
export TELEGRAM_BOT_TOKEN="your-bot-token-from-botfather"
export OPENAI_API_KEY="your-openai-api-key"

# Optional: Use PostgreSQL instead of embedded PGLite
export POSTGRES_URL="postgresql://user:password@localhost:5432/eliza"
```

Or create a `.env` file in the project root:
```env
TELEGRAM_BOT_TOKEN=your-bot-token-from-botfather
OPENAI_API_KEY=your-openai-api-key
```

## Building

```bash
cd telegram-agent

# Debug build
cargo build

# Release build (optimized)
cargo build --release
```

## Running

```bash
# Run directly
cargo run

# Run release build
cargo run --release

# Or run the compiled binary
./target/release/telegram-agent
```

## Configuration

### Character Customization

Edit the `CHARACTER_JSON` constant in `src/main.rs`:

```rust
const CHARACTER_JSON: &str = r#"{
    "name": "YourBotName",
    "bio": "Your bot's description",
    "system": "System prompt defining behavior"
}"#;
```

### Telegram Configuration

The `TelegramConfig` struct supports additional options:

```rust
let telegram_config = TelegramConfig::new(bot_token)
    .with_allowed_chat_ids(vec![123456789, -987654321])
    .with_ignore_bot_messages(true)
    .with_respond_only_to_mentions(false);
```

### Event Callbacks

Register custom event handlers:

```rust
telegram_service.set_event_callback(|event_type, payload| {
    match event_type {
        TelegramEventType::SlashStart => { /* handle /start */ }
        TelegramEventType::ReactionReceived => { /* handle reactions */ }
        _ => {}
    }
});
```

## Architecture

```
┌─────────────────────────────────────────┐
│             AgentRuntime                │
├─────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────────┐  │
│  │  Telegram   │  │    SQL Plugin    │  │
│  │   Service   │  │  (PostgreSQL/    │  │
│  │  (teloxide) │  │   SQLx)          │  │
│  └─────────────┘  └──────────────────┘  │
│  ┌─────────────────────────────────────┐│
│  │         OpenAI Plugin               ││
│  │    (Language Model Provider)        ││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

## Dependencies

| Crate | Purpose |
|-------|---------|
| `elizaos` | Core runtime |
| `elizaos-plugin-openai` | LLM integration |
| `elizaos-plugin-sql` | Database persistence |
| `elizaos-plugin-telegram` | Telegram API (via teloxide) |
| `tokio` | Async runtime |
| `tracing` | Structured logging |

## Troubleshooting

### Compilation errors
- Ensure Rust 1.75+ is installed: `rustup update`
- Check all plugin paths in `Cargo.toml` are correct

### Bot not responding
- Verify `TELEGRAM_BOT_TOKEN` is correct
- Check bot privacy settings in @BotFather
- Enable debug logging: `RUST_LOG=debug cargo run`

### Database errors
- For PostgreSQL: verify connection string
- Check SQLx is compiled with PostgreSQL feature

## Performance

The Rust implementation offers:
- **Zero-cost abstractions** for async operations
- **Memory safety** without garbage collection
- **Native performance** for message processing
- **Efficient connection pooling** for database operations

## License

MIT
