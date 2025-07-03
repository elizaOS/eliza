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

| Provider | Best For | Cost | Speed |
|----------|----------|------|-------|
| **OpenAI** | Beginners, best quality | ~$0.01 per 1000 words | Fast |
| **Claude** | Long conversations | ~$0.01 per 1000 words | Fast |
| **Local AI** | Free usage | Free | Slow |

### Where do I get an API key?

**For OpenAI:**
1. Go to [platform.openai.com](https://platform.openai.com)
2. Sign up or log in
3. Click "API Keys" → "Create new secret key"
4. Copy the key (starts with `sk-`)

**For Claude (Anthropic):**
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up or log in
3. Click "API Keys" → "Create Key"
4. Copy the key

### My agent won't start - help!

Try these steps in order:
1. **Check your API key** - Make sure it's in the `.env` file
2. **Check for typos** - No extra spaces or quotes around the key
3. **Restart** - Stop (Ctrl+C) and run `npm start` again
4. **Check credits** - Make sure your API account has credits
5. **Try Local AI** - Remove API keys to use free local mode

### How do I change my agent's personality?

Edit the `character.json` file:
```json
{
  "name": "Your Agent Name",
  "bio": [
    "Write your agent's background here",
    "Add more personality details"
  ],
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

1. Get a Discord bot token (see our [Discord guide](/docs/simple/guides/discord-setup))
2. Add to your `.env` file:
   ```
   DISCORD_API_TOKEN=your-bot-token
   DISCORD_APPLICATION_ID=your-app-id
   ```
3. Restart your agent
4. Invite the bot to your server

### Can my agent post on Twitter?

Yes! You need:
- Twitter API access (requires approval)
- Four API keys from Twitter
- Add them to your `.env` file
- See our [Twitter guide](/docs/simple/guides/twitter-setup)

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
npm install @elizaos/plugin-name
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
  ```
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
1. **Cloud Hosting** - Use services like:
   - Railway.app (easy, ~$5/month)
   - Heroku (free tier available)
   - DigitalOcean (~$6/month)

2. **Home Server** - Use an old computer

3. **Raspberry Pi** - Low power, always on

### Can multiple people use my agent?

Yes! Once deployed:
- Web chat supports multiple users
- Discord bot works for whole servers
- Each platform handles multiple conversations

### How do I update my agent?

```bash
npm update @elizaos/cli
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
- 📺 [Watch tutorials](https://youtube.com/@elizaos)
- 📖 Read guides in this documentation
- 🐛 [Report bugs](https://github.com/elizaOS/eliza/issues)

## ❓ Still Have Questions?

Can't find your answer here? 
- Check our [detailed guides](/docs/simple/guides)
- Ask in [Discord](https://discord.gg/elizaos)
- Watch [video tutorials](https://youtube.com/@elizaos)

Remember: There are no stupid questions! We're here to help you succeed with your AI agent. 🚀