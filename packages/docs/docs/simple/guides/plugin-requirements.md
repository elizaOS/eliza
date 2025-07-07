---
title: Plugin Requirements & Best Practices
description: Essential information about ElizaOS plugins and their requirements
---

## Plugin Requirements & Best Practices

Understanding how plugins work is crucial for ElizaOS success. This guide covers everything you need to know about plugins.

## Critical Plugin Information

### Plugin Order Matters! ⚠️

The order you list plugins in your character file is **extremely important**. ElizaOS loads plugins sequentially, and some plugins depend on others being loaded first.

**Always use this order:**

```json
{
  "plugins": [
    "@elizaos/plugin-sql", // 1. Database MUST be first
    "@elizaos/plugin-openai", // 2. AI provider second
    "@elizaos/plugin-bootstrap", // 3. Core functionality
    "@elizaos/plugin-discord", // 4. Platform plugins after
    "@elizaos/plugin-twitter" // 5. Additional features last
  ]
}
```

### Why Order Matters

1. **Database First**: `@elizaos/plugin-sql` sets up data storage that other plugins use
2. **AI Provider Second**: Your AI plugin (OpenAI, Anthropic, etc.) needs database access
3. **Bootstrap Third**: Core functionality depends on both database and AI
4. **Platform Plugins**: Discord, Twitter, etc. rely on all core systems
5. **Feature Plugins**: Additional capabilities come last

## Essential Plugins

### Always Required

These three plugins are required for every ElizaOS agent:

#### 1. Database Plugin (Choose One)

```json
"@elizaos/plugin-sql"


// Recommended - PostgreSQL/PGLite support
```

**Purpose**: Stores conversations, memory, and agent state

#### 2. AI Provider Plugin (Choose One)

```json
"@elizaos/plugin-openai"    // For OpenAI (GPT models)
// OR
"@elizaos/plugin-anthropic" // For Claude
// OR
"@elizaos/plugin-groq"      // For Groq
// OR
"@elizaos/plugin-local"     // For local models
```

**Purpose**: Provides the AI brain for your agent

#### 3. Bootstrap Plugin

```json
"@elizaos/plugin-bootstrap"


// Always required
```

**Purpose**: Core agent functionality, actions, and evaluators

## Platform Plugins

Add these based on where you want your agent to operate:

### Discord Integration

```json
"@elizaos/plugin-discord"
```

**Requirements**:

- Discord Application ID
- Discord Bot Token
- Proper bot permissions

### Twitter Integration

```json
"@elizaos/plugin-twitter"
```

**Requirements**:

- Twitter API v2 credentials
- OAuth tokens
- Approved developer account

### Telegram Integration

```json
"@elizaos/plugin-telegram"
```

**Requirements**:

- Telegram Bot Token from @BotFather

## Feature Plugins

Enhance your agent with additional capabilities:

### Voice Features

```json
"@elizaos/plugin-voice"
```

**Capabilities**:

- Speech synthesis
- Voice commands
- Audio responses

### Image Generation

```json
"@elizaos/plugin-image-generation"
```

**Requirements**:

- Additional API keys (OpenAI, Replicate, etc.)

### Web Search

```json
"@elizaos/plugin-web-search"
```

**Capabilities**:

- Real-time web information
- Current events awareness
- Fact checking

## Complete Plugin Example

Here's a fully configured multi-platform agent:

```json
{
  "name": "MultiPlatformAgent",
  "plugins": [
    "@elizaos/plugin-sql",
    "@elizaos/plugin-openai",
    "@elizaos/plugin-bootstrap",
    "@elizaos/plugin-discord",
    "@elizaos/plugin-twitter",
    "@elizaos/plugin-telegram",
    "@elizaos/plugin-voice",
    "@elizaos/plugin-web-search"
  ],
  "settings": {
    "voice": {
      "model": "en_US-female-medium"
    }
  }
}
```

## Installing Plugins

### Using the CLI

```bash
# Install a single plugin
bun add @elizaos/plugin-discord

# Install multiple plugins
bun add @elizaos/plugin-discord @elizaos/plugin-twitter
```

### Manual Installation

Add to your `package.json`:

```json
{
  "dependencies": {
    "@elizaos/plugin-discord": "latest",
    "@elizaos/plugin-twitter": "latest"
  }
}
```

Then run:

```bash
bun install
```

## Plugin Configuration

### Environment Variables

Most plugins require environment variables:

```bash
# AI Providers
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Platforms
DISCORD_APPLICATION_ID=...
DISCORD_API_TOKEN=...
TWITTER_API_KEY=...
TWITTER_API_SECRET=...
TELEGRAM_BOT_TOKEN=...

# Features
REPLICATE_API_KEY=...
```

### Plugin-Specific Settings

Some plugins have additional configuration in the character file:

```json
{
  "settings": {
    "voice": {
      "model": "en_US-female-medium",
      "speed": 1.0
    },
    "imageGeneration": {
      "provider": "openai",
      "model": "dall-e-3",
      "size": "1024x1024"
    }
  }
}
```

## Troubleshooting Plugins

### Common Issues

#### "Plugin not found"

**Solution**: Install the plugin first

```bash
bun add @elizaos/plugin-name
```

#### "Plugin failed to load"

**Causes**:

1. Wrong plugin order
2. Missing dependencies
3. Invalid configuration

**Fix**: Check plugin order and ensure all required environment variables are set

#### "Database error"

**Solution**: Ensure `@elizaos/plugin-sql` is the FIRST plugin

#### Platform not connecting

**Checklist**:

1. Plugin is installed
2. Plugin is in character file
3. Required environment variables are set
4. API keys/tokens are valid

## Creating Custom Plugins

For developers wanting to extend ElizaOS:

### Plugin Structure

```typescript
export const myPlugin: Plugin = {
  name: "my-custom-plugin",
  description: "Does something awesome",
  actions: [...],
  providers: [...],
  evaluators: [...],
  services: [...]
};
```

See [Plugin Development Guide](/docs/technical/development/plugin-development) for details.

## Plugin Best Practices

### Do's

- ✅ Always check plugin compatibility
- ✅ Keep plugins updated
- ✅ Test plugins individually
- ✅ Read plugin documentation
- ✅ Use environment variables for secrets

### Don'ts

- ❌ Never hardcode API keys
- ❌ Don't change plugin order randomly
- ❌ Avoid duplicate plugins
- ❌ Don't mix incompatible AI providers

## Plugin Registry

Browse available plugins at:

- [Official Plugins](/packages)
- [Community Registry](https://github.com/elizaos-plugins/registry)

## Getting Help

- Check plugin-specific documentation
- [Join Discord](https://discord.gg/elizaos) for plugin support
- Report issues on [GitHub](https://github.com/elizaOS/eliza/issues)

---

**Remember**: Proper plugin configuration is the key to a successful ElizaOS agent. When in doubt, start with the minimal required plugins and add features gradually.
