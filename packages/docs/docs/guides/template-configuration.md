# 🔧 Template and Client Configuration

This guide covers how to configure custom templates and client behaviors for your AI agent. We'll walk through all available template options and configuration settings.

## Template Configuration

### Overview

You can customize your character's behavior by overriding default prompt templates in your character's JSON file. elizaos/eliza provides default prompts for standard behaviors, making all template fields optional.

### Available Template Options

Here are all the template options you can configure:

```json
{
    "templates": {
        "goalsTemplate": "", // Define character goals
        "factsTemplate": "", // Specify character knowledge
        "messageHandlerTemplate": "", // Handle general messages
        "shouldRespondTemplate": "", // Control response triggers
        "continueMessageHandlerTemplate": "", // Manage conversation flow
        "evaluationTemplate": "", // Handle response evaluation
        "twitterSearchTemplate": "", // Process Twitter searches
        "twitterPostTemplate": "", // Format Twitter posts
        "twitterMessageHandlerTemplate": "", // Handle Twitter messages
        "twitterShouldRespondTemplate": "", // Control Twitter responses
        "telegramMessageHandlerTemplate": "", // Handle Telegram messages
        "telegramShouldRespondTemplate": "", // Control Telegram responses
        "discordVoiceHandlerTemplate": "", // Manage Discord voice
        "discordShouldRespondTemplate": "", // Control Discord responses
        "discordMessageHandlerTemplate": "" // Handle Discord messages
    }
}
```

### Example Usage

```json
{
    "templates": {
        "discordMessageHandlerTemplate": "",
        "discordShouldRespondTemplate": "",
        "telegramShouldRespondTemplate": "",
        "twitterPostTemplate": ""
    }
}
```

## Client Configuration

### Overview

Configure platform-specific behaviors for your character, such as handling direct messages and bot interactions.

### Available Options

```json
{
    "clientConfig": {
        "telegram": {
            "shouldIgnoreDirectMessages": true, // Ignore DMs
            "shouldIgnoreBotMessages": true // Ignore bot messages
        },
        "discord": {
            "shouldIgnoreBotMessages": true, // Ignore bot messages
            "shouldIgnoreDirectMessages": true // Ignore DMs
        }
    }
}
```

## Best Practices

1. **Template Management**

    - Keep templates focused and specific
    - Use clear, consistent formatting
    - Document custom template behavior

2. **Client Configuration**

    - Configure per platform as needed
    - Test behavior in development
    - Monitor interaction patterns

3. **Performance Considerations**
    - Keep templates concise
    - Avoid redundant configurations
    - Test with expected message volumes
