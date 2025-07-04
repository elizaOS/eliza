
# Customize Your ElizaOS Agent

Welcome to the Customize track! You've got your agent running and now you want to make it uniquely yours. This section covers the real tools and features available in ElizaOS for customizing your agent's personality, behavior, and platform integrations.

## 🎯 What You'll Accomplish

By the end of this track, you'll know how to:

- ✨ Create a unique agent personality using character files
- 🔧 Configure environment variables for multiple platforms
- 🧩 Install and configure plugins to extend functionality
- 📱 Deploy your agent across Discord, Telegram, and other platforms
- 🛠️ Use CLI tools for environment and character management

## 🚀 Your Customization Options

<div className="cards-container">

### 🎭 Character Configuration

**Define your agent's personality and behavior**

- JSON-based character definitions
- Personality traits, bio, and conversation style
- Message examples and response templates
- Knowledge topics and expertise areas

[Learn Character Configuration →](/docs/customize/character-builder)

---

### 🌍 Environment Configuration

**Set up platform integrations and API keys**

- Interactive CLI environment tools
- Multi-platform credentials management
- Database configuration (PostgreSQL/PGLite)
- Model provider setup (OpenAI, Anthropic, etc.)

[Configure Environment →](/docs/customize/environment-builder)

---

### 🧩 Plugin System

**Extend your agent with additional capabilities**

- Core plugins: bootstrap, sql
- Actions, providers, and evaluators
- Plugin installation via CLI
- Custom plugin development

[Explore Plugins →](/docs/customize/feature-workshop)

---

### 📊 Logging & Monitoring

**Track your agent's performance**

- Structured logging with multiple levels
- In-memory log buffer
- Sentry error tracking integration
- Performance monitoring

[Setup Monitoring →](/docs/customize/analytics)

</div>

## 🎨 ElizaOS Architecture

ElizaOS is built with a modular, extensible architecture that allows deep customization:

### Core Components

- **Character System** - JSON/TypeScript-based personality definitions
- **Plugin Architecture** - Modular extensions for actions, providers, and services
- **Multi-Platform Support** - Unified runtime with platform-specific clients
- **Environment Management** - Flexible configuration system

## 🛠️ Available Tools & Features

### Character File System

Create rich agent personalities using the character file format:

**Core Properties:**

- 🎭 **Identity** - Name, bio, and description
- 💬 **Communication Style** - Tone, response patterns, and quirks
- 🧠 **Knowledge & Topics** - Areas of expertise and interests
- 📝 **Message Examples** - Training data for consistent responses

**Advanced Features:**

- Plugin configuration per character
- Platform-specific settings
- Custom secrets and environment variables
- Response templates and post guidelines

### Environment Configuration Tools

Manage your agent's configuration with CLI tools:

**Available Commands:**

- 🔧 **`elizaos env interactive`** - Interactive configuration wizard
- 📋 **`elizaos env list`** - View all environment variables
- ✏️ **`elizaos env edit-local`** - Edit local .env file
- 🔄 **`elizaos env reset`** - Reset to defaults

### Plugin Ecosystem

Extend your agent with available plugins:

**Core Plugins:**

- 📦 **@elizaos/plugin-bootstrap** - Essential actions and providers
  - Actions: reply, followRoom, sendMessage, updateSettings
  - Providers: time, facts, relationships, recentMessages
  - Services: TaskService for deferred operations
- 🗄️ **@elizaos/plugin-sql** - Database connectivity
  - PostgreSQL and PGLite support
  - Migration management

## 🚦 Getting Started

### Prerequisites

Before diving into customization, ensure you have:

- ✅ A working ElizaOS agent (complete the [Quick Start](/docs/simple/getting-started/quick-start) first)
- ✅ The ElizaOS CLI installed (`bun install -g @elizaos/cli`)
- ✅ API keys for your chosen platforms (Discord, Telegram, etc.)
- ✅ A text editor for modifying JSON character files

### Recommended Path

#### Phase 1: Character Definition (20 minutes)

1. **Copy a template** - Start with `packages/cli/src/characters/eliza.ts`
2. **Customize personality** - Edit name, bio, and style properties
3. **Add message examples** - Provide training conversations
4. **Configure plugins** - Select which plugins to use

#### Phase 2: Environment Setup (15 minutes)

1. **Run setup wizard** - `elizaos env interactive`
2. **Add API keys** - Configure model providers (OpenAI, Anthropic)
3. **Add platform tokens** - Set up Discord, Telegram credentials
4. **Configure database** - Choose PostgreSQL or PGLite

#### Phase 3: Platform Deployment (30 minutes)

1. **Choose platforms** - Add to character's `clients` array
2. **Platform setup** - Follow platform-specific guides
3. **Test connections** - Verify bot appears online
4. **Fine-tune behavior** - Adjust based on platform needs

#### Phase 4: Plugin Configuration (20 minutes)

1. **Review available plugins** - Check `packages/plugin-*`
2. **Install needed plugins** - `elizaos plugin install <name>`
3. **Configure in character** - Add to plugins array
4. **Test functionality** - Verify actions work as expected

## 🎯 Monitoring Your Agent

Track your agent's performance using built-in tools:

### Logging System

- **Log Levels** - fatal, error, warn, info, debug, trace
- **Custom Levels** - success, progress for specific events
- **In-Memory Buffer** - Last 1000 log entries accessible
- **Format Options** - JSON or pretty-printed output

### Error Tracking

- **Sentry Integration** - Automatic error reporting
- **Stack Traces** - Detailed error information
- **Performance Metrics** - Response times and throughput

### Platform-Specific Monitoring

- **Discord** - Member count, message volume, reaction rates
- **Telegram** - Group activity, command usage
- **Direct API** - Request/response logging

## 🌟 Advanced Customization

### Multi-Agent Configuration

Run multiple agents with different personalities:

#### Character Arrays

```bash
# Run multiple agents
elizaos start --characters="path/to/agent1.json,path/to/agent2.json"
```

#### Namespaced Environment Variables

```bash
# Agent-specific credentials
AGENT1_DISCORD_API_TOKEN=xxx
AGENT2_TELEGRAM_BOT_TOKEN=yyy
```

### Custom Plugin Development

Create your own plugins using the starter template:

```bash
# Use the plugin starter
cp -r packages/plugin-starter packages/plugin-myfeature
```

**Plugin Structure:**
- Actions - Define new commands and responses
- Providers - Supply contextual information
- Evaluators - Process interactions
- Services - Manage state and integrations

## 🔬 Testing & Validation

Ensure your customizations work correctly:

### Character Validation

- **JSON Schema Validation** - Automatic checking of character files
- **Plugin Compatibility** - Verify plugin requirements are met
- **Environment Checks** - Validate API keys and credentials

### Testing Tools

```bash
# Test your character file
elizaos test character path/to/character.json

# Run in development mode
elizaos dev --character path/to/character.json
```

### Platform Testing

- **Discord** - Create test server for safe experimentation
- **Telegram** - Use test groups before production
- **Direct API** - Test with curl or API clients

## 🌍 Community Resources

### Example Characters

Learn from existing character implementations:

- **Default Eliza** - `packages/cli/src/characters/eliza.ts`
- **Test Characters** - `packages/cli/tests/test-characters/`
- **Community Examples** - Discord #character-showcase channel

### Plugin Development

- **Plugin Starter** - `packages/plugin-starter/`
- **Core Plugins** - Study `packages/plugin-bootstrap/` for examples
- **Documentation** - Plugin development guide in technical docs

### Get Support

- **Discord Community** - https://discord.gg/elizaos
- **GitHub Issues** - Report bugs and request features
- **Documentation** - Comprehensive guides and API reference

## 📺 Platform Setup Guides

### Quick Setup Videos

1. **Discord Bot Setup** - Create bot, get token, configure permissions
2. **Telegram Bot Creation** - BotFather setup and group configuration  
3. **Environment Configuration** - Using the CLI interactive setup
4. **Character File Basics** - Structure and common patterns

### Advanced Topics

1. **Multi-Agent Setup** - Running multiple personalities
2. **Plugin Development** - Creating custom actions
3. **Database Configuration** - PostgreSQL vs PGLite
4. **Production Deployment** - Best practices for hosting

## 📚 Quick Reference

### Essential CLI Commands

```bash
elizaos env interactive    # Configure environment
elizaos start             # Start with default character
elizaos dev              # Development mode with hot reload
elizaos test             # Run tests
```

### Character File Structure

```json
{
  "name": "MyAgent",
  "bio": "A helpful AI assistant",
  "clients": ["discord", "telegram"],
  "plugins": ["@elizaos/plugin-bootstrap"],
  "settings": {
    "response_length": "medium"
  }
}
```

### Common Issues

- **Bot not responding** → Check API keys in .env
- **Character not loading** → Validate JSON syntax
- **Plugin errors** → Ensure plugin is installed
- **Platform connection failed** → Verify credentials

---

## 🚀 Ready to Start Customizing?

Choose your first step based on what you want to achieve:

<div className="action-grid">

**🎭 Create a unique personality?**  
[Learn Character Configuration →](/docs/customize/character-builder)

**🔧 Set up platform integrations?**  
[Configure Environment →](/docs/customize/environment-builder)

**🧩 Add more capabilities?**  
[Explore Plugin System →](/docs/customize/feature-workshop)

**📊 Monitor performance?**  
[Setup Logging & Analytics →](/docs/customize/analytics)

</div>

---

**💡 Pro Tip**: Start by running `elizaos env interactive` to set up your environment variables. This interactive wizard will guide you through configuring API keys and platform credentials.

**🎯 Real Example**: The default Eliza character in `packages/cli/src/characters/eliza.ts` is a great starting point. Copy it, modify the personality traits, and you'll have your own unique agent in minutes!
