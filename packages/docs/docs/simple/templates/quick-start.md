# Quick Start

Start your first Eliza agent in 60 seconds.

## Create Your First Agent

### Step 1: Install ElizaOS

```bash
bun install -g @elizaos/cli
```

### Step 2: Create a New Project

```bash
elizaos create my-agent
cd my-agent
```

### Step 3: Start Your Agent

```bash
elizaos start
```

That's it! Your agent is now running at http://localhost:3000

## Understanding Your Agent

When you created your project, ElizaOS generated this character file:

**`agent/eliza.character.json`**

```json
{
  "name": "Eliza",
  "bio": "A friendly AI assistant who loves to chat",
  "plugins": ["@elizaos/plugin-pgvector", "@elizaos/plugin-bootstrap"]
}
```

This minimal configuration:

- **name** - Your agent's identity
- **bio** - Personality description
- **plugins** - Core functionality (pgvector for memory, bootstrap for basic chat)

## Customize Your Agent

### Add Personality

Edit `agent/eliza.character.json`:

```json
{
  "name": "Eliza",
  "bio": "A friendly AI assistant who loves to chat",
  "plugins": ["@elizaos/plugin-pgvector", "@elizaos/plugin-bootstrap"],
  "style": {
    "all": ["friendly", "curious", "helpful"]
  },
  "topics": ["technology", "philosophy", "daily life"],
  "adjectives": ["thoughtful", "engaging", "witty"]
}
```

### Configure AI Model

Create `.env` file in your project root:

```
# Choose your AI provider:

# OpenAI
OPENAI_API_KEY=sk-...

# OR Anthropic Claude
ANTHROPIC_API_KEY=sk-ant-...

# OR run without API key for local model
```

### Connect to Discord

1. Update your character file:

```json
{
  "name": "Eliza",
  "bio": "A friendly Discord community member",
  "plugins": ["@elizaos/plugin-bootstrap", "@elizaos/plugin-discord"]
}
```

2. Add Discord credentials to `.env`:

```
DISCORD_API_TOKEN=your-bot-token
DISCORD_APPLICATION_ID=your-app-id
```

3. Install the Discord plugin:

```bash
bun add @elizaos/plugin-discord
```

4. Restart your agent:

```bash
elizaos start
```

## Essential Commands

```bash
# Create new project
elizaos create <project-name>

# Start agent (from project directory)
elizaos start

# Start with specific character
elizaos start --character path/to/character.json

# Development mode with auto-reload
elizaos dev

# Update ElizaOS
elizaos update
```

## Project Structure

```
my-agent/
├── agent/
│   └── eliza.character.json    # Your agent's personality
├── .env                        # API keys and secrets
├── package.json               # Project configuration
└── bun.lockb                  # Dependencies
```

## Next Steps

- **[Discord Agent →](./discord-agent)** - Full Discord integration
- **[Twitter Agent →](./twitter-agent)** - Social media presence
- **[Telegram Agent →](./telegram-agent)** - Chat companion
- **[Multi-Platform →](./multi-platform-agent)** - Deploy everywhere

---

**💡 Tip:** Start simple, test often. You can always add more features later!
