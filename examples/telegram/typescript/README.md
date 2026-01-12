# Telegram Agent - TypeScript

A complete Telegram bot agent using elizaOS with SQL persistence.

## Features

- 🤖 Full Telegram bot integration (private chats, groups, reactions)
- 💾 PostgreSQL or PGLite database persistence
- 🧠 OpenAI-powered language model
- 🔄 Automatic message handling and responses
- 📝 Conversation memory and context

## Prerequisites

1. **Telegram Bot Token**: Get one from [@BotFather](https://t.me/BotFather)
2. **OpenAI API Key**: Get one from [OpenAI Platform](https://platform.openai.com)

## Setup

1. Install dependencies:
```bash
bun install
```

2. Set environment variables:
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

## Running

```bash
# Start the bot
bun run start

# Development mode with hot reload
bun run dev
```

## Configuration

### Character Customization

Edit the `character` object in `telegram-agent.ts` to customize your bot's personality:

```typescript
const character: Character = {
  name: "YourBotName",
  bio: "Your bot's description",
  system: "System prompt defining behavior",
  messageExamples: [...],
};
```

### Allowed Chats (Optional)

To restrict the bot to specific chats:

```bash
export TELEGRAM_ALLOWED_CHATS='["-123456789", "987654321"]'
```

## Architecture

```
┌─────────────────────────────────────────┐
│             AgentRuntime                │
├─────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────────┐  │
│  │  Telegram   │  │    SQL Plugin    │  │
│  │   Plugin    │  │  (PostgreSQL/    │  │
│  │             │  │   PGLite)        │  │
│  └─────────────┘  └──────────────────┘  │
│  ┌─────────────────────────────────────┐│
│  │         OpenAI Plugin               ││
│  │    (Language Model Provider)        ││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

## License

MIT
