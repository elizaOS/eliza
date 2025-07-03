# 5-Minute Quick Start Guide

Get your first ElizaOS agent running in just 5 minutes! No coding required.

## 📋 What You'll Need

Before starting, make sure you have:
- A computer (Windows, Mac, or Linux)
- Internet connection
- An AI API key (we'll help you get one)

## 🚀 Step 1: Install ElizaOS (2 minutes)

Open your terminal (Command Prompt on Windows, Terminal on Mac/Linux) and run:

```bash
npx @elizaos/cli create my-first-agent
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
4. Copy your key (starts with `sk-`)

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
   ```
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
  "modelProvider": "openai",
  "settings": {
    "voice": "alloy",
    "model": "gpt-4o-mini"
  },
  "bio": [
    "I'm here to help you with anything you need!",
    "I love learning new things and chatting with people."
  ],
  "style": {
    "all": [
      "friendly",
      "helpful",
      "encouraging"
    ]
  }
}
```

Change the name, bio, and style to create your unique agent!

## ▶️ Step 5: Start Your Agent (30 seconds)

Run this command:

```bash
npm start
```

Your agent is now running! You'll see:
```
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

## 🎉 Congratulations!

You've successfully created and launched your first ElizaOS agent! 

## 📚 What's Next?

Now that your agent is running, explore these options:

### 🎨 [Customize Your Agent](/docs/simple/guides/character-creation)
- Change personality and behavior
- Add custom responses
- Create unique characters

### 🔌 [Add Features with Plugins](/docs/simple/guides/plugin-usage)
- Connect to Discord
- Add Twitter integration
- Enable voice chat
- And much more!

### 🚀 [Deploy Your Agent](/docs/simple/guides/deployment)
- Keep your agent running 24/7
- Share it with the world
- Scale to handle more users

## ❓ Need Help?

### Common Issues

<details>
<summary><b>Error: "API key not found"</b></summary>

Make sure you:
1. Added your API key to the `.env` file
2. Saved the file
3. Used the correct format (no extra spaces or quotes)
4. Restarted the agent after adding the key
</details>

<details>
<summary><b>Error: "Port 3000 already in use"</b></summary>

Another program is using port 3000. Either:
1. Stop the other program, or
2. Change the port in your `.env` file:
   ```
   PORT=3001
   ```
</details>

<details>
<summary><b>Agent not responding</b></summary>

Check that:
1. Your API key is valid and has credits
2. You have internet connection
3. The terminal shows no error messages
4. Try restarting with `npm start`
</details>

### Get Support

- 💬 [Join our Discord](https://discord.gg/elizaos)
- 📖 [Read the FAQ](/docs/simple/faq)
- 🎥 [Watch video tutorials](https://youtube.com/@elizaos)

---

🎊 **You did it!** Your agent is alive and ready to chat. Have fun exploring all the possibilities with ElizaOS!