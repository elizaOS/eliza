# Telegram Agent Examples

Complete Telegram bot agents powered by elizaOS with SQL persistence, available in **TypeScript**, **Python**, and **Rust**.

## Overview

These examples demonstrate how to build a fully-featured Telegram bot using elizaOS. Each implementation includes:

- 🤖 **Full Telegram Integration** - Private chats, groups, reactions, inline buttons
- 💾 **SQL Persistence** - PostgreSQL for production, PGLite for development
- 🧠 **OpenAI Integration** - Language model capabilities for natural conversations
- 🔄 **Automatic Message Handling** - Built-in message processing pipeline
- 📝 **Conversation Memory** - Context retention across messages

## Quick Start

### Prerequisites

1. **Telegram Bot Token** - Get from [@BotFather](https://t.me/BotFather):
   - Open Telegram and search for `@BotFather`
   - Send `/newbot` and follow the prompts
   - Copy the bot token provided

2. **OpenAI API Key** - Get from [OpenAI Platform](https://platform.openai.com/api-keys)

3. **Environment Setup**:
```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
export OPENAI_API_KEY="your-openai-api-key"

# Optional: PostgreSQL (defaults to embedded PGLite)
export POSTGRES_URL="postgresql://user:pass@localhost:5432/eliza"
```

### Choose Your Language

| Language | Directory | Command |
|----------|-----------|---------|
| TypeScript | [`typescript/`](./typescript/) | `bun run start` |
| Python | [`python/`](./python/) | `python telegram_agent.py` |
| Rust | [`rust/telegram-agent/`](./rust/telegram-agent/) | `cargo run --release` |

## Implementation Comparison

### TypeScript
```typescript
import telegramPlugin from "@elizaos/plugin-telegram";
import sqlPlugin from "@elizaos/plugin-sql";

const runtime = new AgentRuntime({
  character,
  plugins: [sqlPlugin, openaiPlugin, telegramPlugin],
});
await runtime.initialize();
```

**Pros**: Fastest development, automatic plugin integration, hot reload support

### Python
```python
from elizaos_plugin_telegram import TelegramService, TelegramConfig

telegram_service = TelegramService(TelegramConfig.from_env())
telegram_service.on_message(message_handler)
await telegram_service.start()
```

**Pros**: Explicit control, familiar async/await, rich ecosystem

### Rust
```rust
use elizaos_plugin_telegram::{TelegramConfig, TelegramService};

let mut telegram_service = TelegramService::new(TelegramConfig::from_env()?);
telegram_service.set_message_callback(|chat_id, msg_id, user_id, text| { ... });
telegram_service.start().await?;
```

**Pros**: Maximum performance, memory safety, production-ready

## Architecture

All implementations share the same architecture:

```
┌─────────────────────────────────────────────────────────┐
│                    AgentRuntime                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   ┌─────────────────┐    ┌─────────────────────────┐   │
│   │    Telegram     │    │      SQL Plugin         │   │
│   │     Plugin      │    │   ┌─────────────────┐   │   │
│   │                 │    │   │   PostgreSQL    │   │   │
│   │  • Bot API      │    │   │       or        │   │   │
│   │  • Messages     │    │   │    PGLite       │   │   │
│   │  • Events       │    │   └─────────────────┘   │   │
│   └─────────────────┘    └─────────────────────────┘   │
│                                                         │
│   ┌─────────────────────────────────────────────────┐   │
│   │              OpenAI Plugin                       │   │
│   │                                                  │   │
│   │  • Chat completions    • Embeddings             │   │
│   │  • Function calling    • Vision (optional)      │   │
│   └─────────────────────────────────────────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Telegram Plugin Features

### Supported Chat Types
- **Private** - One-on-one direct messages
- **Group** - Basic Telegram groups
- **Supergroup** - Advanced groups with forum support
- **Channel** - Broadcast channels (receive-only)

### Event Types
| Event | Description |
|-------|-------------|
| `SLASH_START` | User sends `/start` command |
| `MESSAGE_RECEIVED` | New message in chat |
| `REACTION_RECEIVED` | Reaction added to message |
| `ENTITY_JOINED` | User joined chat |
| `ENTITY_LEFT` | User left chat |

### Inline Buttons
```typescript
// TypeScript
const content = {
  text: "Choose an option:",
  buttons: [
    { kind: "url", text: "Visit Website", url: "https://..." },
    { kind: "login", text: "Log In" },
  ],
};
```

## SQL Plugin Features

### Automatic Database Selection
- **PostgreSQL**: Used when `POSTGRES_URL` is set
- **PGLite**: Embedded database when no URL provided

### Stored Data
- Agent configurations
- Conversation memories
- Entity relationships
- Vector embeddings
- Cache and logs

### Data Isolation (Optional)
```bash
export ENABLE_DATA_ISOLATION=true
export ELIZA_SERVER_ID="your-server-id"
```

## Configuration Options

### Telegram Settings
| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather | Required |
| `TELEGRAM_API_ROOT` | Custom API endpoint | `https://api.telegram.org` |
| `TELEGRAM_ALLOWED_CHATS` | JSON array of chat IDs | All chats |

### Database Settings
| Variable | Description | Default |
|----------|-------------|---------|
| `POSTGRES_URL` | PostgreSQL connection string | None (uses PGLite) |
| `PGLITE_DATA_DIR` | PGLite data directory | `./pglite` |

## Troubleshooting

### Bot not receiving messages
1. Ensure bot token is correct
2. For groups: disable privacy mode in @BotFather settings
3. Verify bot was added to the chat correctly

### Database connection issues
1. Check `POSTGRES_URL` format: `postgresql://user:pass@host:port/db`
2. Ensure database server is running
3. Verify network connectivity

### OpenAI errors
1. Verify API key is valid
2. Check API usage limits on OpenAI dashboard
3. Ensure sufficient credits

## Next Steps

- Customize the character personality in each implementation
- Add custom actions and providers
- Integrate additional plugins (e.g., web search, image generation)
- Deploy to production with Docker or cloud services

## Related Examples

- [`../chat/`](../chat/) - Simple CLI chat example
- [`../aws/`](../aws/) - AWS Lambda deployment
- [`../gcp/`](../gcp/) - Google Cloud deployment

## License

MIT
