# Telegram Agent Example

TypeScript Telegram bot using elizaOS with the full message pipeline
(providers -> LLM -> actions -> ALWAYS_AFTER hook actions).

## Quick Start

```bash
export TELEGRAM_BOT_TOKEN="your-token"
export OPENAI_API_KEY="your-key"
# Optional: export POSTGRES_URL="postgresql://..."
```

```bash
cd packages/examples/telegram
bun install
bun run start
```

## How It Works

The `telegramPlugin` auto-integrates with the runtime. Include it and messages
flow through the full pipeline automatically.

## Message Pipeline

```
Message → Providers → LLM → Actions → Response
          (character,   (generate   (reply,
           entities,     response)   ignore,
           history)                  custom)
```

## Configuration

The character defines personality, system prompt, and settings:

```typescript
const character = {
  name: "TelegramEliza",
  bio: "A helpful AI assistant.",
  system: "Be friendly and concise...",
  settings: { model: "gpt-5-mini" },
  secrets: { TELEGRAM_BOT_TOKEN: "...", OPENAI_API_KEY: "..." },
};
```

## Env Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | From @BotFather |
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `POSTGRES_URL` | No | PostgreSQL URL (defaults to PGLite) |
