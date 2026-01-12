# Telegram Agent - Python

A complete Telegram bot agent using elizaOS with SQL persistence.

## Features

- 🤖 Full Telegram bot integration (private chats, groups, reactions)
- 💾 PostgreSQL or PGLite database persistence
- 🧠 OpenAI-powered language model
- 🔄 Automatic message handling and responses
- 📝 Conversation memory and context

## Prerequisites

1. **Python 3.11+**
2. **Telegram Bot Token**: Get one from [@BotFather](https://t.me/BotFather)
3. **OpenAI API Key**: Get one from [OpenAI Platform](https://platform.openai.com)

## Setup

1. Create and activate a virtual environment:
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Set environment variables:
```bash
export TELEGRAM_BOT_TOKEN="your-bot-token-from-botfather"
export OPENAI_API_KEY="your-openai-api-key"

# Optional: Use PostgreSQL instead of embedded PGLite
export POSTGRES_URL="postgresql://user:password@localhost:5432/eliza"
```

Or create a `.env` file:
```env
TELEGRAM_BOT_TOKEN=your-bot-token-from-botfather
OPENAI_API_KEY=your-openai-api-key
```

## Running

```bash
python telegram_agent.py
```

## Configuration

### Character Customization

Edit the `create_character()` function in `telegram_agent.py`:

```python
def create_character() -> Character:
    return Character(
        name="YourBotName",
        username="your_bot",
        bio="Your bot's description",
        system="System prompt defining behavior",
    )
```

### Telegram Configuration

The `TelegramConfig` class supports additional options:

```python
telegram_config = TelegramConfig(
    bot_token="your-token",
    api_root="https://api.telegram.org",  # Custom API endpoint
    allowed_chats=[123456789, -987654321],  # Restrict to specific chats
)
```

### Event Handlers

Register custom event handlers:

```python
# Handle reactions
async def on_reaction(chat_id: int, message_id: int, emoji: str):
    logger.info(f"Reaction: {emoji}")

telegram_service.on_event(TelegramEventType.REACTION_RECEIVED, on_reaction)
```

## Architecture

```
┌─────────────────────────────────────────┐
│             AgentRuntime                │
├─────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────────┐  │
│  │  Telegram   │  │    SQL Plugin    │  │
│  │   Service   │  │  (PostgreSQL/    │  │
│  │             │  │   PGLite)        │  │
│  └─────────────┘  └──────────────────┘  │
│  ┌─────────────────────────────────────┐│
│  │         OpenAI Plugin               ││
│  │    (Language Model Provider)        ││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

## Troubleshooting

### Bot not responding
- Verify `TELEGRAM_BOT_TOKEN` is correct
- Check bot privacy settings in @BotFather (disable privacy mode for groups)
- Ensure the bot has been added to the chat

### Database errors
- For PostgreSQL: verify connection string and that the database exists
- For PGLite: ensure write permissions in the data directory

## License

MIT
