# Frequently Asked Questions (Simple)

Quick answers to common questions about ElizaOS agents.

## 🚀 Getting Started

### What is ElizaOS?

ElizaOS is a platform for creating AI agents - think of them as smart chatbots with personality! You can chat with them, have them help you with tasks, or integrate them into Discord, Twitter, and other platforms.

### Do I need to know how to code?

No! We provide templates and simple configuration files. You just need to:

- Copy and paste commands
- Edit text files (like writing in Notepad)
- Follow our step-by-step guides

### How much does it cost?

ElizaOS itself is **free and open source**! However, you'll need:

- An AI API key (OpenAI costs ~$5-20/month for casual use)
- Optional: Server hosting (~$5-20/month if you want 24/7 operation)
- Free option: Use Local AI (slower but completely free)

**Cost Breakdown Example (Monthly):**

| Usage Level      | AI API Cost      | Hosting    | Total   |
| ---------------- | ---------------- | ---------- | ------- |
| Testing/Learning | $0-5 (free tier) | $0 (local) | $0-5    |
| Personal Bot     | $5-15            | $0 (local) | $5-15   |
| Community Bot    | $15-50           | $5-20      | $20-70  |
| Business Bot     | $50-200          | $20-100    | $70-300 |

💡 **Tip**: Start with free local AI to learn, then upgrade when ready!

### What can my agent do?

Your agent can:

- 💬 Have conversations
- 📱 Post on social media
- 🎮 Join Discord servers
- 📧 Send messages
- 🎨 Generate creative content
- 🤖 Automate tasks
- And much more with plugins!

## ⚙️ Setup & Configuration

### Which AI provider should I choose?

| Provider     | Best For                | Cost                  | Speed |
| ------------ | ----------------------- | --------------------- | ----- |
| **OpenAI**   | Beginners, best quality | ~$0.01 per 1000 words | Fast  |
| **Claude**   | Long conversations      | ~$0.01 per 1000 words | Fast  |
| **Local AI** | Free usage              | Free                  | Slow  |

### Where do I get an API key?

**For OpenAI:**

1. Go to [platform.openai.com](https://platform.openai.com)
2. Sign up or log in
3. Click "API Keys" → "Create new secret key"
4. Copy the key (starts with `sk-` prefix)

**For Claude (Anthropic):**

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up or log in
3. Click "API Keys" → "Create Key"
4. Copy the key

### My agent won't start - help

Try these steps in order:

1. **Check your API key** - Make sure it's in the `.env` file
2. **Check for typos** - No extra spaces or quotes around the key
3. **Restart** - Stop (Ctrl+C) and run `bun start` again
4. **Check credits** - Make sure your API account has credits
5. **Try Local AI** - Remove API keys to use free local mode

### How do I change my agent's personality?

Edit the `character.json` file:

```json
{
  "name": "Your Agent Name",
  "plugins": ["@elizaos/plugin-sql", "@elizaos/plugin-openai", "@elizaos/plugin-bootstrap"],
  "bio": ["Write your agent's background here", "Add more personality details"],
  "style": {
    "all": ["friendly", "helpful", "creative"]
  }
}
```

Save the file and restart your agent!

## 💬 Using Your Agent

### How do I talk to my agent?

Three ways:

1. **Web Browser**: Go to `http://localhost:3000`
2. **Terminal**: Type directly where you started the agent
3. **Discord/Twitter**: If you've set up those integrations

### My agent keeps forgetting our conversation

Agents remember recent messages but not everything forever. To help:

- Keep conversations focused
- Remind the agent of important context
- Use the same chat room/thread
- Avoid very long conversations

### Can my agent learn about me?

Yes! Agents remember:

- Your name and preferences
- Recent conversations
- Important facts you share
- Your interaction patterns

### How do I make my agent stop?

Press `Ctrl+C` (or `Cmd+C` on Mac) in the terminal where it's running.

## 🔌 Features & Plugins

### How do I add Discord to my agent?

1. Get a Discord bot token from the Discord Developer Portal
2. Add to your `.env` file:

   ```env
   DISCORD_API_TOKEN=your-bot-token
   DISCORD_APPLICATION_ID=your-app-id
   ```

3. Restart your agent
4. Invite the bot to your server

For a complete Discord agent example, see our [Discord Agent Template](templates/discord-agent.md).

### Can my agent post on Twitter?

Yes! You need:

- Twitter API access (requires approval)
- Four API keys from Twitter
- Add them to your `.env` file

For a complete Twitter agent example, see our [Twitter Agent Template](templates/twitter-agent.md).

### What plugins are available?

Popular plugins:

- 🎮 **Discord** - Chat in Discord servers
- 🐦 **Twitter** - Post and reply on Twitter
- 💬 **Telegram** - Telegram bot integration
- 🎙️ **Voice** - Voice chat capabilities
- 🖼️ **Image Generation** - Create images
- And many more!

### How do I install plugins?

Simple command:

```bash
bun add @elizaos/plugin-name
```

Then add to your agent configuration!

## 🚨 Troubleshooting

### "API key not found" error

Check:

- ✅ Key is in `.env` file
- ✅ No quotes around the key
- ✅ File is saved
- ✅ You restarted the agent

### "Port already in use" error

Another program is using port 3000. Either:

- Stop the other program, OR
- Change port in `.env`:

  ```env
  PORT=3001
  ```

### Agent responses are slow

Possible causes:

- Using Local AI (it's slower but free)
- Poor internet connection
- API service is busy
- Try a different AI provider

### Agent gives weird responses

Try:

- Adjusting the temperature (lower = more focused)
- Providing clearer character description
- Using better examples in character file
- Switching AI models

## 🌐 Deployment

### How do I keep my agent running 24/7?

Options:

1. **Cloud Hosting** (Easiest) - Use services like:

   - **Railway.app**
     - ✅ One-click deploy
     - ✅ ~$5/month
     - ✅ No server knowledge needed
     - [Deploy Guide →](/docs/simple/guides/deployment-railway)
   - **Render.com**
     - ✅ Free tier available
     - ✅ Auto-deploy from GitHub
     - ✅ Great for beginners
     - [Deploy Guide →](/docs/simple/guides/deployment-render)
   - **Heroku**
     - ✅ Well-documented
     - ✅ ~$7/month
     - ✅ Lots of tutorials

2. **Home Server** - Use an old computer
   - ✅ Free (just electricity)
   - ❌ Need stable internet
   - ❌ Computer must stay on
3. **Raspberry Pi** - Low power, always on
   - ✅ ~$50 one-time cost
   - ✅ Very low power usage
   - ❌ Requires some setup

### Can multiple people use my agent?

Yes! Once deployed:

- Web chat supports multiple users
- Discord bot works for whole servers
- Each platform handles multiple conversations

### How do I update my agent?

```bash
bun install -g @elizaos/cli@latest
```

Then restart your agent!

## 💡 Tips & Best Practices

### Making your agent more interesting

1. **Give it a backstory** - More detail = better personality
2. **Add quirks** - Favorite phrases, topics, reactions
3. **Use examples** - Show how it should respond
4. **Set boundaries** - What it should/shouldn't discuss

### Saving money on API costs

- Use shorter conversations
- Set token limits in configuration
- Use Local AI for testing
- Monitor usage in your API dashboard

### Getting help

- 💬 [Join our Discord](https://discord.gg/elizaos)
- 📺 [Watch tutorials](https://www.youtube.com/@elizaOSDeveloper)
- 📖 Read guides in this documentation
- 🐛 [Report bugs](https://github.com/elizaOS/eliza/issues)

## 🎯 Quick Start Checklist

New to ElizaOS? Follow this order:

1. ⬜ Read the [5-minute quick start](/docs/simple/getting-started/quick-start)
2. ⬜ Get an API key (OpenAI recommended for beginners)
3. ⬜ Download and run your first agent
4. ⬜ Chat with it locally
5. ⬜ Pick a template from the [gallery](/docs/simple/templates/gallery)
6. ⬜ Customize the personality
7. ⬜ Choose a platform (Discord/Telegram/Twitter)
8. ⬜ Deploy online (optional)
9. ⬜ Join our community for help!

## 🆘 Emergency Help

### Nothing is working

**Reset everything:**

```bash
# Stop your agent (Ctrl+C)
# Delete and re-download
rm -rf your-agent-folder
bunx create-eliza-app your-agent-name
cd your-agent-name
# Follow setup again carefully
```

### I'm completely lost

1. **Watch a video walkthrough**: [YouTube Tutorial](https://www.youtube.com/@elizaOSDeveloper)
2. **Join Discord**: Get live help in #beginner-help
3. **Book office hours**: Free 15-min help sessions weekly

## ❓ Still Have Questions?

Can't find your answer here?

- Check our [detailed guides](/docs/simple/guides)
- Ask in [Discord](https://discord.gg/elizaos) - #beginner-help channel
- Watch [video tutorials](https://www.youtube.com/@elizaOSDeveloper)
- Email support: [support@elizaos.ai](mailto:support@elizaos.ai)

Remember: There are no stupid questions! We're here to help you succeed with your AI agent. 🚀

---

**🌟 Success Story**: "I had never coded before, but within an hour I had my own AI assistant helping manage my Discord server!" - Sarah, Community Manager
