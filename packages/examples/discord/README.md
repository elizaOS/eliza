# Discord Agent Example

Full-featured TypeScript Discord AI agent using elizaOS.

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
cd packages/examples/discord
cp env.example .env
# Edit .env with your credentials
```

Required variables:
- `DISCORD_APPLICATION_ID` - Your Discord application ID
- `DISCORD_API_TOKEN` - Your bot token
- `OPENAI_API_KEY` - Your OpenAI API key

### 4. Run the Agent

```bash
cd packages/examples/discord
bun install
bun run start
# or for development with hot reload:
bun run dev
```

## Project Structure

```
packages/examples/discord/
├── env.example              # Environment template
├── README.md               # This file
├── agent.ts                # Main entry point
├── character.ts            # Bot personality
├── handlers.ts             # Event handlers
├── package.json
└── tsconfig.json
```

## Customization

### Modify Bot Personality

Edit `character.ts`.

### Add Custom Commands

Edit `handlers.ts` to add new slash commands.

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
cd packages/examples/discord
bun run test
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
cd packages/examples/discord && bun start &

# Run Telegram bot (in another terminal)
cd packages/examples/telegram && bun start &
```

## License

MIT
