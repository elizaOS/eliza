# Discord Agent Examples

Full-featured Discord AI agents using elizaOS, available in **TypeScript**, **Python**, and **Rust**.

## Features

- 🤖 Responds to @mentions and replies
- ⚡ Slash commands (`/ping`, `/about`, `/help`)
- 💾 Persistent memory via SQL database
- 🧠 OpenAI-powered language understanding
- 🎯 Configurable response behavior

## Quick Start

### 1. Install Dependencies (from repo root)

```bash
# Install all dependencies
bun install
bun run build
```

### 2. Set Up Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section and create a bot
4. **Enable "Message Content Intent"** (required for reading messages)
5. Copy the Bot Token
6. Invite the bot to your server using OAuth2 URL Generator:
   - Select "bot" scope
   - Select permissions: Send Messages, Read Message History, Add Reactions

### 3. Configure Environment

```bash
cd examples/discord
cp env.example .env
# Edit .env with your credentials
```

Required variables:
- `DISCORD_APPLICATION_ID` - Your Discord application ID
- `DISCORD_API_TOKEN` - Your bot token
- `OPENAI_API_KEY` - Your OpenAI API key

### 4. Run the Agent

Choose your preferred language:

#### TypeScript
```bash
cd typescript
bun install
bun start
# or for development with hot reload:
bun dev
```

#### Python
```bash
cd python
pip install -r requirements.txt
python agent.py
```

#### Rust
```bash
cd rust/discord-agent
cargo run --release
```

## Project Structure

```
examples/discord/
├── env.example              # Environment template
├── README.md               # This file
├── typescript/             # TypeScript implementation
│   ├── agent.ts           # Main entry point
│   ├── character.ts       # Bot personality
│   ├── handlers.ts        # Event handlers
│   ├── package.json
│   └── __tests__/         # Tests
├── python/                 # Python implementation
│   ├── agent.py           # Main entry point
│   ├── character.py       # Bot personality
│   ├── handlers.py        # Event handlers
│   ├── requirements.txt
│   └── tests/             # Tests
└── rust/                   # Rust implementation
    └── discord-agent/
        ├── Cargo.toml
        ├── src/
        │   ├── main.rs    # Main entry point
        │   ├── character.rs # Bot personality
        │   └── handlers.rs  # Event handlers
        └── tests/         # Tests
```

## Customization

### Modify Bot Personality

Edit the character file for your language:
- TypeScript: `typescript/character.ts`
- Python: `python/character.py`
- Rust: `rust/discord-agent/src/character.rs`

### Add Custom Commands

Edit the handlers file to add new slash commands:
- TypeScript: `typescript/handlers.ts`
- Python: `python/handlers.py`
- Rust: `rust/discord-agent/src/handlers.rs`

### Discord Settings

Configure bot behavior in the character settings:
```json
{
  "discord": {
    "shouldIgnoreBotMessages": true,
    "shouldRespondOnlyToMentions": true
  }
}
```

## Commands

| Command | Description |
|---------|-------------|
| `/ping` | Check if the bot is online |
| `/about` | Learn about the bot |
| `/help` | Show available commands |

## Testing

```bash
# TypeScript
cd typescript && bun test

# Python
cd python && pytest

# Rust
cd rust/discord-agent && cargo test
```

## Troubleshooting

### Bot not responding to messages
- Ensure "Message Content Intent" is enabled in Discord Developer Portal
- Check that the bot has proper permissions in your server
- Verify `DISCORD_API_TOKEN` is correct

### Slash commands not appearing
- Commands may take up to an hour to propagate globally
- For instant testing, use guild-specific commands in development

### Rate limiting
- Discord has rate limits; the bot handles these automatically
- If you see 429 errors, reduce message frequency

## Multi-Platform Setup

This example can work alongside the Telegram example. Both share the same `.env` file and can run simultaneously for a multi-platform bot experience.

```bash
# Run Discord bot
cd examples/discord/typescript && bun start &

# Run Telegram bot (in another terminal)
cd examples/telegram/typescript && bun start &
```

## License

MIT
