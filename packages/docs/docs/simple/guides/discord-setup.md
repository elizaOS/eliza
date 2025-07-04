# Discord Bot Setup Guide

Create a Discord bot with your ElizaOS agent for server interaction and management.

## Prerequisites

- Discord account
- Server with admin permissions (or ability to create one)
- ElizaOS installed and configured
- Basic understanding of Discord permissions

## Step 1: Discord Application Setup

### Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Name your application (e.g., "My ElizaOS Agent")
4. Click "Create"

### Configure Bot Settings

1. Navigate to "Bot" section in sidebar
2. Click "Add Bot" → "Yes, do it!"
3. Under "Token" section, click "Copy" to get your bot token
4. **Important**: Keep this token secure - treat it like a password

### Bot Permissions

Configure these settings for optimal functionality:

**Privileged Gateway Intents** (Bot → Privileged Gateway Intents):

- ✅ Message Content Intent (required for reading messages)
- ⚠️ Server Members Intent (optional, for member management)
- ⚠️ Presence Intent (optional, for status features)

**Bot Permissions** (OAuth2 → URL Generator → Bot):

- ✅ Read Messages/View Channels
- ✅ Send Messages
- ✅ Send Messages in Threads
- ✅ Embed Links
- ✅ Attach Files
- ✅ Read Message History
- ✅ Add Reactions
- ✅ Use Slash Commands
- ⚠️ Manage Messages (for moderation features)
- ⚠️ Connect & Speak (for voice features)

## Step 2: Environment Configuration

Add these Discord-specific variables to your `.env` file:

### Basic Discord Configuration

```bash
# Discord Configuration
DISCORD_APPLICATION_ID=123456789012345678    # From Discord Developer Portal → General Information
DISCORD_API_TOKEN=your_bot_token_here        # From Discord Developer Portal → Bot → Token
```

### Voice Features (Optional)

```bash
# Discord Voice Configuration
DISCORD_VOICE_CHANNEL_ID=123456789012345678  # Specific voice channel ID for voice features
```

To get your Application ID:

1. Go to Discord Developer Portal → Your Application
2. Navigate to "General Information"
3. Copy the "Application ID"

To get Voice Channel ID:

1. Enable Developer Mode in Discord (Settings → Advanced → Developer Mode)
2. Right-click on the voice channel
3. Select "Copy ID"

## Step 3: Server Setup and Bot Invitation

### Generate Invitation Link

1. In Discord Developer Portal, go to OAuth2 → URL Generator
2. Select Scopes:
   - ✅ `bot`
   - ✅ `applications.commands` (for slash commands)
3. Select Bot Permissions (see permissions list above)
4. Copy the generated URL
5. Open URL in browser and select your server
6. Click "Authorize"

### Test Bot Presence

1. Check that your bot appears in the member list (offline initially)
2. Note the bot's user ID for reference
3. Verify bot has correct roles and permissions

## Step 4: Character Configuration

Configure your character file for Discord:

```json
{
  "name": "DiscordAssistant",
  "clients": ["discord"],
  "plugins": ["@elizaos/plugin-bootstrap", "@elizaos/plugin-sql"],
  "settings": {
    "secrets": {},
    "voice": {
      "model": "en_US-female-medium"
    },
    "imageVision": false
  },
  "bio": [
    "I'm a helpful Discord bot powered by ElizaOS",
    "I can assist with server management, answer questions, and engage in conversations",
    "I'm designed to be friendly, helpful, and respectful to all server members"
  ],
  "lore": [
    "Created to enhance Discord server communities",
    "Trained on best practices for Discord moderation and engagement",
    "Continuously learning from interactions to provide better assistance"
  ],
  "messageExamples": [
    [
      {
        "name": "{{user}}",
        "content": {
          "text": "Hey bot, can you help me with server rules?"
        }
      },
      {
        "name": "DiscordAssistant",
        "content": {
          "text": "Of course! I'd be happy to help explain the server rules. What specific rule would you like me to clarify?"
        }
      }
    ],
    [
      {
        "name": "{{user}}",
        "content": {
          "text": "What's the best way to organize channels?"
        }
      },
      {
        "name": "DiscordAssistant",
        "content": {
          "text": "Great question! Here are some best practices for channel organization:\n\n• Group related channels into categories\n• Use descriptive names with prefixes (e.g., #general-chat, #help-support)\n• Set clear channel topics and descriptions\n• Consider voice/text channel balance\n\nWould you like specific suggestions for your server type?"
        }
      }
    ]
  ],
  "style": {
    "all": [
      "friendly and approachable",
      "uses Discord-appropriate formatting",
      "helpful and informative",
      "respects server culture and rules"
    ],
    "chat": [
      "responds promptly to mentions and direct messages",
      "uses reactions and emojis appropriately",
      "maintains conversation context",
      "offers assistance proactively when appropriate"
    ]
  },
  "topics": [
    "Discord server management",
    "community building",
    "bot features and capabilities",
    "server moderation",
    "channel organization",
    "role management"
  ],
  "adjectives": ["helpful", "friendly", "knowledgeable", "reliable", "respectful"],
  "knowledge": [
    "Discord platform features and best practices",
    "Server management and moderation techniques",
    "Community building strategies",
    "Bot integration and automation",
    "Discord API capabilities and limitations"
  ]
}
```

## Step 5: Testing Your Discord Bot

### Initial Connection Test

1. Start your agent: `bun start`
2. Check Discord - your bot should appear online
3. Look for connection logs in your terminal
4. Verify bot responds to @mentions

### Basic Interaction Test

1. In a channel where the bot has permissions, type: `@YourBot hello`
2. Bot should respond within a few seconds
3. Try a few different messages to test responsiveness
4. Check that bot maintains conversation context

### Permission Testing

Test various bot capabilities:

- **Message sending**: Bot can reply to messages
- **Reactions**: Bot can add reactions to messages
- **Embeds**: Bot can send rich embeds
- **File uploads**: Bot can send images/files (if configured)

## Step 6: Advanced Discord Features

### Slash Commands Integration

Enable slash commands for more interactive experiences:

```json
{
  "settings": {
    "slashCommands": true,
    "commandPrefix": "!"
  }
}
```

### Voice Channel Integration

For voice features, add voice channel configuration:

```bash
# Voice Channel Configuration
DISCORD_VOICE_CHANNEL_ID=987654321098765432
```

Then update character settings:

```json
{
  "settings": {
    "voice": {
      "model": "en_US-female-medium",
      "enabled": true,
      "autoJoin": false
    }
  }
}
```

### Moderation Features

Configure moderation capabilities:

```json
{
  "knowledge": [
    "Discord community guidelines",
    "Server-specific rules and enforcement",
    "Conflict resolution techniques"
  ],
  "style": {
    "moderation": [
      "fair and consistent",
      "explains decisions clearly",
      "escalates complex issues to human moderators"
    ]
  }
}
```

## Step 7: Discord-Specific Best Practices

### Message Formatting

Use Discord markdown for better formatting:

- **Bold text**: `**bold**`
- _Italic text_: `*italic*`
- `Code`: `` `code` ``
- Code blocks: ` ```language\ncode\n``` `
- Spoilers: `||spoiler||`

### Embed Usage

Create rich embeds for important information:

```json
{
  "postExamples": [
    {
      "content": {
        "embeds": [
          {
            "title": "Server Announcement",
            "description": "Welcome to our community!",
            "color": 0x00ff00,
            "fields": [
              {
                "name": "Rules",
                "value": "Please read #rules channel",
                "inline": true
              }
            ]
          }
        ]
      }
    }
  ]
}
```

### Reaction Management

Use reactions for interactive features:

- ✅ Agreement/approval
- ❌ Disagreement/denial
- 🤔 Thinking/processing
- 📌 Important information
- 🎉 Celebration/welcome

## Troubleshooting Common Issues

### Bot Not Responding

**Symptoms**: Bot appears online but doesn't respond to messages

**Solutions**:

- Verify Message Content Intent is enabled
- Check bot has "Read Messages" permission in channel
- Ensure bot isn't muted or restricted
- Review logs for error messages
- Verify character file is properly configured

### Permission Errors

**Symptoms**: "Missing Permissions" errors in logs

**Solutions**:

- Check bot role is high enough in hierarchy
- Verify specific channel permissions
- Ensure bot has required permissions (Send Messages, Read Message History)
- Check if channel is restricted to certain roles

### Connection Issues

**Symptoms**: Bot appears offline or frequently disconnects

**Solutions**:

- Verify `DISCORD_API_TOKEN` is correct and valid
- Check internet connection stability
- Review Discord API status
- Ensure token hasn't been regenerated in Developer Portal

### Rate Limiting

**Symptoms**: Bot becomes slow or stops responding temporarily

**Solutions**:

- Reduce message frequency
- Implement proper rate limiting in character behavior
- Avoid spam-like patterns
- Check for loops in conversation logic

## Advanced Configuration

### Multi-Server Setup

Configure bot for multiple servers:

```json
{
  "settings": {
    "servers": {
      "123456789": {
        "name": "Main Server",
        "prefix": "!",
        "features": ["moderation", "music"]
      },
      "987654321": {
        "name": "Dev Server",
        "prefix": "?",
        "features": ["testing"]
      }
    }
  }
}
```

### Custom Commands

Add server-specific commands:

```json
{
  "messageExamples": [
    [
      {
        "name": "{{user}}",
        "content": { "text": "!serverinfo" }
      },
      {
        "name": "DiscordAssistant",
        "content": {
          "text": "**Server Information**\n• Name: {{server.name}}\n• Members: {{server.memberCount}}\n• Created: {{server.createdAt}}"
        }
      }
    ]
  ]
}
```

### Scheduled Messages

Configure automatic scheduled messages:

```json
{
  "settings": {
    "scheduledMessages": [
      {
        "cron": "0 9 * * *",
        "channel": "general",
        "message": "Good morning everyone! Hope you have a great day! ☀️"
      },
      {
        "cron": "0 0 * * 0",
        "channel": "announcements",
        "message": "Weekly server stats and updates coming soon!"
      }
    ]
  }
}
```

## Security and Compliance

### Token Security

- **Never share your bot token** publicly
- **Regenerate token** if compromised
- **Use environment variables** for storage
- **Restrict bot permissions** to minimum required

### Data Privacy

- **Respect user privacy** and Discord's privacy policy
- **Don't log sensitive information** unnecessarily
- **Implement data retention policies**
- **Allow users to request data deletion**

### Content Moderation

- **Follow Discord Community Guidelines**
- **Implement appropriate content filters**
- **Report serious violations** to Discord
- **Maintain moderation logs** for accountability

## Performance Optimization

### Resource Management

- **Monitor memory usage** for long-running bots
- **Implement graceful shutdowns**
- **Use connection pooling** for database operations
- **Cache frequently accessed data**

### Response Times

- **Optimize character response generation**
- **Use typing indicators** for longer responses
- **Implement command cooldowns** to prevent spam
- **Cache common responses** when appropriate

## Support and Resources

- **Discord Developer Docs**: [discord.com/developers/docs](https://discord.com/developers/docs)
- **ElizaOS Community**: [Discord Server](https://discord.gg/elizaos)
- **Bot Best Practices**: [Discord Developer Best Practices](https://discord.com/developers/docs/topics/community-resources#bots-and-apps)
- **API Reference**: [Discord API Documentation](https://discord.com/developers/docs/reference)

## Legal Considerations

- **Bot Terms of Service**: Comply with Discord's Bot Terms
- **Rate Limiting**: Respect API rate limits
- **User Consent**: Obtain consent for data processing
- **Content Guidelines**: Follow platform content policies

---

**🚀 Pro Tip**: Start with basic functionality and gradually add advanced features. Monitor your bot's performance and user feedback to guide feature development.
