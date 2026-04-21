# Telegram Agent Examples

Telegram bots using elizaOS with the full message pipeline (providers → LLM → actions → evaluators).

## Quick Start

```bash
export TELEGRAM_BOT_TOKEN="your-token"
export OPENAI_API_KEY="your-key"
# Optional: export POSTGRES_URL="postgresql://..."
```

| Language | Command |
|----------|---------|
| TypeScript | `cd typescript && bun install && bun run start` |
| Python | `cd python && pip install -r requirements.txt && python telegram_agent.py` |
| Rust | `cd rust/telegram-agent && cargo run --release` |

## How It Works

**TypeScript**: The `telegramPlugin` auto-integrates with the runtime - just include it and messages flow through the full pipeline automatically.

**Python/Rust**: Manually bridge Telegram to `runtime.message_service.handle_message()` which runs the full pipeline.

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
