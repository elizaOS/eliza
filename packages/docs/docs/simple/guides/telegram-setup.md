# Telegram Bot Setup Guide

Create a Telegram bot with your ElizaOS agent for personal assistance and group management.

## Prerequisites

- Telegram account (mobile app or web version)
- ElizaOS installed and configured
- Basic understanding of Telegram bots

## Step 1: Create Telegram Bot

### Using BotFather

1. Open Telegram and search for `@BotFather`
2. Start a chat with BotFather by sending `/start`
3. Send `/newbot` command
4. Follow the prompts:
   - **Bot name**: Display name (e.g., "My ElizaOS Assistant")
   - **Bot username**: Must end with 'bot' (e.g., "my_eliza_bot")
5. **Save the bot token** - you'll need this for configuration

### Bot Configuration with BotFather

Optional settings you can configure:

```
/setdescription - Set bot description
/setabouttext - Set about text
/setuserpic - Set bot profile picture
/setcommands - Set command list
/setprivacy - Enable/disable group privacy
```

Example commands setup:

```
help - Get help with bot commands
status - Check bot status
settings - Configure bot settings
```

## Step 2: Environment Configuration

Add these Telegram-specific variables to your `.env` file:

### Basic Telegram Configuration

```bash
# Telegram Configuration
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz   # Bot token from BotFather
```

### Advanced Settings (Optional)

```bash
# Telegram Advanced Configuration
TELEGRAM_PARSE_MODE=Markdown          # Message parsing: Markdown, MarkdownV2, HTML
TELEGRAM_DISABLE_WEB_PAGE_PREVIEW=true # Disable link previews
TELEGRAM_DISABLE_NOTIFICATION=false   # Send messages silently
TELEGRAM_PROTECT_CONTENT=false        # Prevent forwarding/saving
```

## Step 3: Character Configuration

Configure your character file for Telegram:

```json
{
  "name": "TelegramAssistant",
  "clients": ["telegram"],
  "plugins": ["@elizaos/plugin-bootstrap", "@elizaos/plugin-sql"],
  "settings": {
    "allowDirectMessages": true,
    "shouldOnlyJoinInAllowedGroups": false,
    "allowedGroupIds": [],
    "messageTrackingLimit": 100,
    "templates": {
      "telegramMessageHandlerTemplate": "{{agentName}} received: {{messageText}}"
    },
    "secrets": {},
    "voice": {
      "model": "en_US-female-medium"
    }
  },
  "bio": [
    "I'm a helpful Telegram assistant powered by ElizaOS",
    "I can help with personal tasks, answer questions, and manage group conversations",
    "I'm available 24/7 to assist you through Telegram"
  ],
  "lore": [
    "Designed specifically for Telegram's unique messaging environment",
    "Optimized for both personal chats and group interactions",
    "Built with privacy and security in mind"
  ],
  "messageExamples": [
    [
      {
        "name": "{{user}}",
        "content": {
          "text": "Hey, can you help me with my schedule?"
        }
      },
      {
        "name": "TelegramAssistant",
        "content": {
          "text": "Of course! I'd be happy to help with your schedule. What would you like me to do? I can help you:\n\n• Set reminders\n• Plan your day\n• Check upcoming events\n• Organize tasks\n\nJust let me know what you need!"
        }
      }
    ],
    [
      {
        "name": "{{user}}",
        "content": {
          "text": "/help"
        }
      },
      {
        "name": "TelegramAssistant",
        "content": {
          "text": "🤖 **TelegramAssistant Help**\n\n**Available Commands:**\n/help - Show this help message\n/status - Check bot status\n/settings - Configure preferences\n\n**What I can do:**\n• Answer questions on any topic\n• Help with task management\n• Provide information and research\n• Assist with planning and organization\n\nJust message me naturally - no special commands needed!"
        }
      }
    ]
  ],
  "style": {
    "all": [
      "friendly and conversational",
      "uses Telegram formatting (bold, italic, code)",
      "helpful and informative",
      "responds quickly and concisely"
    ],
    "chat": [
      "adapts to user's communication style",
      "uses emojis appropriately",
      "maintains context across messages",
      "offers follow-up assistance"
    ],
    "group": [
      "only responds when mentioned or replied to",
      "contributes meaningfully to conversations",
      "respects group dynamics and rules"
    ]
  },
  "topics": [
    "personal assistance",
    "task management",
    "information research",
    "daily planning",
    "general knowledge",
    "technology support"
  ],
  "adjectives": ["helpful", "reliable", "intelligent", "responsive", "friendly"],
  "knowledge": [
    "Telegram platform features and etiquette",
    "Personal productivity and organization",
    "Information research and fact-checking",
    "Task and time management strategies"
  ]
}
```

## Step 4: Telegram-Specific Features

### Message Formatting

Telegram supports rich text formatting:

```markdown
**Bold text**
_Italic text_
`Inline code`
```

Multi-line code:

````
```language
code block
````

```

[Inline links](https://example.com)
```

### Command Handling

Set up custom commands in your character:

```json
{
  "messageExamples": [
    [
      {
        "name": "{{user}}",
        "content": { "text": "/remind me to call John at 3pm" }
      },
      {
        "name": "TelegramAssistant",
        "content": { "text": "✅ Reminder set! I'll remind you to call John at 3:00 PM today." }
      }
    ],
    [
      {
        "name": "{{user}}",
        "content": { "text": "/weather New York" }
      },
      {
        "name": "TelegramAssistant",
        "content": {
          "text": "🌤️ **Weather in New York:**\nTemperature: 72°F\nCondition: Partly cloudy\nHumidity: 65%\nWind: 8 mph"
        }
      }
    ]
  ]
}
```

### Group Management

Configure for group interactions:

```json
{
  "settings": {
    "allowDirectMessages": true,
    "shouldOnlyJoinInAllowedGroups": true,
    "allowedGroupIds": ["-1001234567890", "-1009876543210"],
    "messageTrackingLimit": 200
  },
  "style": {
    "group": [
      "only responds when mentioned with @username",
      "provides helpful information to group members",
      "moderates discussions when appropriate",
      "welcomes new members"
    ]
  }
}
```

### Privacy Settings

Configure privacy and security:

```json
{
  "settings": {
    "privacyMode": true,
    "storeMessages": false,
    "allowForwarding": false,
    "requireMention": true
  }
}
```

## Step 5: Testing Your Telegram Bot

### Initial Connection Test

1. Start your agent: `bun start`
2. Search for your bot on Telegram by username
3. Send `/start` to initiate conversation
4. Bot should respond with a welcome message

### Functionality Testing

Test various features:

```
/help - Check if help command works
Hello - Test natural conversation
@botname what time is it? - Test mentions (in groups)
/remind me test - Test custom commands
```

### Group Testing (if enabled)

1. Add bot to a test group
2. Test that bot only responds when mentioned
3. Verify group-specific behavior
4. Check message tracking limits

## Step 6: Advanced Configuration

### Webhook Setup (Optional)

For production deployments, use webhooks instead of polling:

```bash
# Webhook Configuration
TELEGRAM_USE_WEBHOOK=true
TELEGRAM_WEBHOOK_URL=https://yourdomain.com/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=your_webhook_secret
```

### File Handling

Enable file upload/download capabilities:

```json
{
  "settings": {
    "allowFileUploads": true,
    "maxFileSize": "50MB",
    "allowedFileTypes": ["image", "document", "audio"],
    "downloadPath": "./downloads"
  }
}
```

### Inline Keyboard Support

Add interactive buttons:

```json
{
  "messageExamples": [
    [
      {
        "name": "{{user}}",
        "content": { "text": "/menu" }
      },
      {
        "name": "TelegramAssistant",
        "content": {
          "text": "Choose an option:",
          "reply_markup": {
            "inline_keyboard": [
              [
                { "text": "📅 Schedule", "callback_data": "schedule" },
                { "text": "📝 Tasks", "callback_data": "tasks" }
              ],
              [
                { "text": "❓ Help", "callback_data": "help" },
                { "text": "⚙️ Settings", "callback_data": "settings" }
              ]
            ]
          }
        }
      }
    ]
  ]
}
```

## Troubleshooting Common Issues

### Bot Not Responding

**Symptoms**: Bot appears offline or doesn't respond to messages

**Solutions**:

- Verify `TELEGRAM_BOT_TOKEN` is correct
- Check that bot token hasn't been revoked
- Ensure ElizaOS is running without errors
- Check logs for authentication errors
- Verify character file has `"clients": ["telegram"]`

### Group Permission Issues

**Symptoms**: Bot doesn't respond in groups

**Solutions**:

- Check `shouldOnlyJoinInAllowedGroups` setting
- Verify group ID is in `allowedGroupIds` array
- Ensure bot has necessary group permissions
- Check if privacy mode is affecting responses
- Verify bot is mentioned correctly (@botname)

### Message Formatting Issues

**Symptoms**: Messages appear with raw markup

**Solutions**:

- Check `TELEGRAM_PARSE_MODE` setting
- Verify markdown/HTML syntax is correct
- Test with simple text first
- Check character encoding issues

### Rate Limiting

**Symptoms**: Bot becomes slow or stops responding temporarily

**Solutions**:

- Reduce message frequency
- Implement message queuing
- Check Telegram API limits
- Monitor bot usage patterns
- Add delays between bulk operations

## Best Practices

### User Experience

- **Quick responses**: Aim for sub-second response times
- **Clear communication**: Use formatting to improve readability
- **Helpful errors**: Provide actionable error messages
- **Context awareness**: Remember conversation history

### Security Best Practices

- **Token security**: Never share bot tokens publicly
- **Input validation**: Validate all user inputs
- **Rate limiting**: Implement protection against spam
- **Privacy compliance**: Follow data protection regulations

### Performance Optimization

- **Message batching**: Group related messages
- **Efficient polling**: Use appropriate polling intervals
- **Memory management**: Clean up old message history
- **Error handling**: Implement robust error recovery

### Content Guidelines

- **Telegram ToS**: Follow Telegram's Terms of Service
- **Spam prevention**: Avoid unsolicited messages
- **User consent**: Respect user preferences
- **Content quality**: Ensure messages provide value

## Advanced Features

### Multi-language Support

Configure language detection and responses:

```json
{
  "settings": {
    "autoDetectLanguage": true,
    "supportedLanguages": ["en", "es", "fr", "de"],
    "defaultLanguage": "en"
  },
  "style": {
    "multilingual": [
      "responds in user's detected language",
      "asks for clarification if language unclear",
      "maintains consistency within conversation"
    ]
  }
}
```

### Bot Analytics

Track usage and performance:

```json
{
  "settings": {
    "analytics": {
      "trackMessages": true,
      "trackCommands": true,
      "trackUsers": false,
      "retentionDays": 30
    }
  }
}
```

### Custom Keyboards

Create persistent menu keyboards:

```json
{
  "settings": {
    "customKeyboard": {
      "keyboard": [
        ["📅 Schedule", "📝 Tasks"],
        ["❓ Help", "⚙️ Settings"],
        ["📊 Stats", "🔄 Refresh"]
      ],
      "resize_keyboard": true,
      "persistent": true
    }
  }
}
```

## Integration with Other Services

### Calendar Integration

Connect with calendar services:

```json
{
  "plugins": ["@elizaos/plugin-bootstrap", "@elizaos/plugin-calendar"],
  "knowledge": [
    "Calendar management and scheduling",
    "Time zone handling and conversion",
    "Meeting coordination and planning"
  ]
}
```

### File Storage Integration

Connect with cloud storage:

```json
{
  "plugins": ["@elizaos/plugin-bootstrap", "@elizaos/plugin-file-storage"],
  "settings": {
    "fileStorage": {
      "provider": "aws-s3",
      "autoUpload": true,
      "generateLinks": true
    }
  }
}
```

## Support and Resources

- **Telegram Bot API**: [core.telegram.org/bots/api](https://core.telegram.org/bots/api)
- **BotFather Commands**: [core.telegram.org/bots#botfather](https://core.telegram.org/bots#botfather)
- **ElizaOS Community**: [Discord Server](https://discord.gg/elizaos)
- **Bot Examples**: [Telegram Bot Examples](https://core.telegram.org/bots/samples)

## Compliance and Legal

### Data Protection

- **GDPR Compliance**: Handle EU user data appropriately
- **Data Retention**: Implement appropriate retention policies
- **User Rights**: Allow data access, correction, and deletion
- **Consent Management**: Obtain proper user consent

### Terms of Service

- **Telegram ToS**: Follow Telegram's platform rules
- **Bot Guidelines**: Adhere to bot-specific policies
- **Content Policies**: Ensure appropriate content only
- **User Safety**: Implement safety and reporting features

---

**🤖 Pro Tip**: Start with direct messages to test functionality, then gradually add group features. Telegram's inline keyboards and rich formatting can significantly enhance user experience.
