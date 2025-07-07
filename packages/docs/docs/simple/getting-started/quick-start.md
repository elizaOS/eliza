# 5-Minute Quick Start Guide

Get your first ElizaOS agent running in just 5 minutes! No coding required.

## 📋 What You'll Need

Before starting, make sure you have:

- A computer (Windows, Mac, or Linux)
- Internet connection
- An AI API key (we'll help you get one)

## 🚀 Step 1: Install ElizaOS (2 minutes)

Open your terminal (Command Prompt on Windows, Terminal on Mac/Linux) and follow these steps:

### Install the ElizaOS CLI globally

```bash
bun install -g @elizaos/cli
```

### Create your first agent

```bash
elizaos create my-first-agent
```

When prompted, select:

- **Project Type**: `project` (for a complete agent)
- **Template**: `basic` (simplest template)
- **Install dependencies**: `yes`

The installer will create your agent and set everything up automatically!

## 🔑 Step 2: Get Your AI Key (1 minute)

Your agent needs an AI service to think and respond. Choose one:

### Option A: OpenAI (Recommended for beginners)

1. Go to [platform.openai.com](https://platform.openai.com)
2. Sign up or log in
3. Click "API Keys" → "Create new secret key"
4. Copy your key (starts with `sk-` prefix)

### Option B: Claude (Anthropic)

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up or log in
3. Go to "API Keys" → "Create Key"
4. Copy your key

### Option C: Local AI (Free, no API key needed)

- The agent will use a local AI model (slower but free)
- No additional setup required!

## ⚙️ Step 3: Configure Your Agent (1 minute)

1. Navigate to your agent folder:

   ```bash
   cd my-first-agent
   ```

2. Open the `.env` file in any text editor

3. Add your API key:

   ```env
   # For OpenAI
   OPENAI_API_KEY=your-key-here

   # OR for Claude
   ANTHROPIC_API_KEY=your-key-here

   # OR for Local AI - leave empty
   ```

4. Save the file

## 🎭 Step 4: Customize Your Agent (Optional - 30 seconds)

Open `agent/eliza.character.json` to customize your agent's personality:

```json
{
  "name": "Eliza",
  "description": "A helpful AI assistant",
  "plugins": ["@elizaos/plugin-sql", "@elizaos/plugin-openai", "@elizaos/plugin-bootstrap"],
  "settings": {
    "voice": "alloy"
  },
  "bio": [
    "I'm here to help you with anything you need!",
    "I love learning new things and chatting with people."
  ],
  "style": {
    "all": ["friendly", "helpful", "encouraging"]
  }
}
```

> **Note:** The plugins must be in this exact order:
>
> 1. `@elizaos/plugin-sql` - Database (always first!)
> 2. `@elizaos/plugin-openai` - AI provider (or use `@elizaos/plugin-anthropic`)
> 3. `@elizaos/plugin-bootstrap` - Core functionality

Change the name, bio, and style to create your unique agent!

## ▶️ Step 5: Start Your Agent (30 seconds)

Run this command:

```bash
bun start
```

Your agent is now running! You'll see:

```text
🤖 Agent "Eliza" is starting...
✅ Connected to OpenAI
🌐 Chat interface available at: http://localhost:3000
💬 Discord bot online (if configured)
🐦 Twitter bot online (if configured)
```

## 💬 Step 6: Chat with Your Agent

### Web Chat (Easiest)

1. Open your web browser
2. Go to `http://localhost:3000`
3. Start chatting with your agent!

### Terminal Chat

Type messages directly in the terminal where you started the agent.

## 🎉 Congratulations

You've successfully created and launched your first ElizaOS agent!

## 📚 What's Next?

Now that your agent is running, explore these options:

### 🎨 [Customize Your Agent](../guides/character-creation.md)

- Change personality and behavior
- Add custom responses
- Create unique characters

### 🔌 Connect to Platforms

To connect your agent to platforms like Discord, Twitter, or Telegram, check out the platform-specific templates in our [Templates section](../templates/quick-start.md).

### 🚀 Advanced Features

For more advanced configuration and monitoring options, check out our [Technical Documentation](../../technical/architecture/overview.md).

### 🛠️ For Developers

- **[Technical Documentation](../../technical/architecture/overview.md)** - System architecture
- **[Twitter Technical Guide](../../technical/integrations/twitter-technical.md)** - API implementation details

## ❓ Need Help?

### Common Issues

**Error: "API key not found"**

Make sure you:

1. Added your API key to the `.env` file
2. Saved the file
3. Used the correct format (no extra spaces or quotes)
4. Restarted the agent after adding the key

**Error: "Port 3000 already in use"**

Another program is using port 3000. Either:

1. Stop the other program, or
2. Change the port in your `.env` file:

   ```env
   PORT=3001
   ```

**Agent not responding**

Check that:

1. Your API key is valid and has credits
2. You have internet connection
3. The terminal shows no error messages
4. Try restarting with `bun start`

### Get Support

- 💬 [Join our Discord](https://discord.gg/elizaos)
- 📖 [Read the FAQ](/docs/simple/faq)
- 🎥 [Watch video tutorials](https://www.youtube.com/@elizaOSDeveloper)

---

🎊 **You did it!** Your agent is alive and ready to chat. Have fun exploring all the possibilities with ElizaOS!
