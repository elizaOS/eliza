# ElizaOS Agent Project Development Guide for Claude

> **Optimized for Claude LLM** - Complete reference for building ElizaOS agent projects

## 📋 Project Overview

| Property            | Value                         |
| ------------------- | ----------------------------- |
| **Project Type**    | ElizaOS Agent Project         |
| **Package Manager** | `bun` (REQUIRED)              |
| **Runtime**         | ElizaOS with plugin ecosystem |
| **Configuration**   | Character-based agent setup   |
| **Architecture**    | Plugin composition pattern    |

## 🏗️ Project Architecture

ElizaOS projects are **character-driven agent systems** that compose functionality through plugins:

```
📦 Your Agent Project
├── 🤖 Character Definition (personality, behavior)
├── 🔌 Plugin Ecosystem (functionality)
├── 🌍 Environment Config (APIs, secrets)
└── 🚀 Runtime Orchestration (ElizaOS)
```

## 📁 Project Structure

```
your-agent-project/
├── 📂 src/
│   ├── 📄 character.ts          # Agent personality & config
│   ├── 📄 index.ts             # Main entry point
│   └── 📄 plugin.ts            # Custom plugin (optional)
├── 📂 characters/              # Character JSON files
│   ├── 📄 production.json      # Production character
│   ├── 📄 development.json     # Dev/testing character
│   └── 📄 specialized.json     # Specialized variants
├── 📂 data/                    # Agent memory & storage
├── 📄 .env                     # Environment variables
├── 📄 .env.local              # Local overrides (gitignored)
├── 📄 package.json            # Dependencies & scripts
└── 📄 tsconfig.json           # TypeScript configuration
```

## 🤖 Character Configuration

### Core Character Definition

```typescript
// src/character.ts
import { Character } from '@elizaos/core';

export const character: Character = {
  // Basic Identity
  name: 'AssistantAgent',
  username: 'assistant',

  // Personality & Behavior
  bio: 'A helpful AI assistant created to provide assistance and engage in meaningful conversations.',

  system: `You are a helpful, harmless, and honest AI assistant.
Core principles:
- Always strive to provide accurate and useful information
- Be respectful and considerate in all interactions  
- Admit when you don't know something
- Ask clarifying questions when requests are ambiguous`,

  // Conversation Examples (Training Data)
  messageExamples: [
    [
      { name: 'user', content: { text: 'Hello! How are you today?' } },
      {
        name: 'AssistantAgent',
        content: {
          text: "Hello! I'm doing well, thank you for asking. I'm here and ready to help you with whatever you need. How can I assist you today?",
        },
      },
    ],
    [
      { name: 'user', content: { text: 'Can you help me understand a complex topic?' } },
      {
        name: 'AssistantAgent',
        content: {
          text: "Absolutely! I'd be happy to help you understand any topic. Could you tell me which specific topic you'd like to explore? I'll break it down in a clear, easy-to-understand way.",
        },
      },
    ],
  ],

  // Communication Style
  style: {
    all: [
      'Be helpful and friendly',
      'Use clear and concise language',
      'Show genuine interest in helping',
      'Maintain a professional yet approachable tone',
    ],
    chat: [
      'Respond naturally and conversationally',
      'Use appropriate emojis sparingly for warmth',
      'Ask follow-up questions to better understand needs',
    ],
    post: [
      'Be informative and engaging',
      'Structure information clearly',
      'Include actionable insights when possible',
    ],
  },

  // Plugin Configuration
  plugins: [
    // REQUIRED: Core functionality
    '@elizaos/plugin-bootstrap', // Essential actions & handlers
    '@elizaos/plugin-sql', // Memory & database management

    // REQUIRED: Model provider (choose one or more)
    '@elizaos/plugin-openai', // GPT-4, GPT-3.5, etc.
    // "@elizaos/plugin-anthropic", // Claude models
    // "@elizaos/plugin-groq",      // Fast inference

    // OPTIONAL: Communication channels
    // "@elizaos/plugin-discord",   // Discord integration
    // "@elizaos/plugin-twitter",   // Twitter/X integration
    // "@elizaos/plugin-telegram",  // Telegram bot

    // OPTIONAL: Specialized capabilities
    // "@elizaos/plugin-solana",    // Solana blockchain
    // "@elizaos/plugin-evm",       // Ethereum/EVM chains
  ],

  // Agent Settings
  settings: {
    voice: 'en-US-Neural2-F',
    model: 'gpt-4o-mini',
    embeddingModel: 'text-embedding-3-small',
    secrets: {},
    intiface: false,
    chains: [],
  },
};

export default character;
```

### Character Variants Pattern

```typescript
// characters/variants.ts
import { Character } from '@elizaos/core';
import { baseCharacter } from '../src/character';

// Production character
export const productionCharacter: Character = {
  ...baseCharacter,
  name: 'ProductionAgent',
  settings: {
    ...baseCharacter.settings,
    model: 'gpt-4', // More capable model for production
  },
};

// Development character
export const devCharacter: Character = {
  ...baseCharacter,
  name: 'DevAgent',
  settings: {
    ...baseCharacter.settings,
    model: 'gpt-4o-mini', // Faster/cheaper for development
  },
  plugins: [
    ...baseCharacter.plugins,
    // Add development-only plugins
  ],
};

// Specialized character
export const cryptoCharacter: Character = {
  ...baseCharacter,
  name: 'CryptoAgent',
  bio: 'A cryptocurrency and blockchain expert assistant',
  plugins: [...baseCharacter.plugins, '@elizaos/plugin-solana', '@elizaos/plugin-evm'],
};
```

## 🔌 Plugin Ecosystem

### Required Plugins

| Plugin                      | Purpose                        | Status       |
| --------------------------- | ------------------------------ | ------------ |
| `@elizaos/plugin-bootstrap` | Core actions, message handling | **REQUIRED** |
| `@elizaos/plugin-sql`       | Memory, database management    | **REQUIRED** |

### Model Provider Plugins (Choose One or More)

| Plugin                      | Models                   | Use Case                       |
| --------------------------- | ------------------------ | ------------------------------ |
| `@elizaos/plugin-openai`    | GPT-4, GPT-3.5, GPT-4o   | General purpose, reliable      |
| `@elizaos/plugin-anthropic` | Claude 3.5 Sonnet, Haiku | Reasoning, analysis            |
| `@elizaos/plugin-groq`      | Llama, Mixtral           | Fast inference, cost-effective |
| `@elizaos/plugin-llama`     | Local Llama models       | Privacy, offline operation     |

### Communication Plugins (Optional)

```bash
# Social platforms
bun add @elizaos/plugin-discord      # Discord bot integration
bun add @elizaos/plugin-twitter      # Twitter/X posting & monitoring
bun add @elizaos/plugin-telegram     # Telegram bot functionality

# Web interfaces
bun add @elizaos/plugin-web          # Web UI for agent interaction
bun add @elizaos/plugin-rest         # REST API endpoints
```

### Specialized Plugins (Optional)

```bash
# Blockchain & Crypto
bun add @elizaos/plugin-solana       # Solana transactions & data
bun add @elizaos/plugin-evm          # Ethereum & EVM chains

# Data & Tools
bun add @elizaos/plugin-web-search   # Web search capabilities
bun add @elizaos/plugin-image        # Image generation & analysis
```

## 🌍 Environment Configuration

### Environment Variables Template

```bash
# .env
# ================================
# MODEL PROVIDERS (Required - choose one or more)
# ================================

# OpenAI (recommended for general use)
OPENAI_API_KEY=sk-your-openai-key-here

# Anthropic (for Claude models)
ANTHROPIC_API_KEY=your-anthropic-key-here

# Groq (for fast inference)
GROQ_API_KEY=gsk_your-groq-key-here

# ================================
# COMMUNICATION CHANNELS (Optional)
# ================================

# Discord Bot
DISCORD_APPLICATION_ID=your-app-id
DISCORD_API_TOKEN=your-bot-token

# Twitter/X
TWITTER_USERNAME=your-username
TWITTER_PASSWORD=your-password
TWITTER_EMAIL=your-email

# Telegram
TELEGRAM_BOT_TOKEN=your-telegram-token

# ================================
# BLOCKCHAIN (Optional)
# ================================

# Solana
SOLANA_PUBLIC_KEY=your-solana-public-key
SOLANA_PRIVATE_KEY=your-solana-private-key

# Ethereum
EVM_PUBLIC_KEY=your-ethereum-public-key
EVM_PRIVATE_KEY=your-ethereum-private-key

# ================================
# SYSTEM CONFIGURATION
# ================================

# Logging level
LOG_LEVEL=info  # debug, info, warn, error

# Database
DATABASE_URL=sqlite://./data/db.sqlite

# Server settings
SERVER_PORT=3000
```

### Environment Best Practices

```bash
# .env.example (commit this)
OPENAI_API_KEY=sk-your-key-here
DISCORD_API_TOKEN=your-token-here
LOG_LEVEL=info

# .env.local (gitignore this - for local overrides)
LOG_LEVEL=debug
DATABASE_URL=sqlite://./data/dev.sqlite
```

## 🚀 Development Workflow

### Quick Start Commands

```bash
# 1. Install dependencies
bun install

# 2. Set up environment
cp .env.example .env
# Edit .env with your API keys

# 3. Start development server
elizaos start --dev

# 4. Or start with specific character
elizaos start --character characters/development.json
```

### Development Scripts

```json
// package.json
{
  "scripts": {
    "start": "elizaos start",
    "dev": "elizaos start --dev",
    "test": "elizaos test",
    "build": "bun build src/index.ts --outdir dist",
    "clean": "rm -rf dist data/logs/*"
  }
}
```

### Testing Your Agent

#### **Method 1: Interactive Development**

```bash
# Quick development mode (recommended for testing)
elizaos dev
# This automatically loads a test character and enables hot reloading

# Start with hot reloading
elizaos start --dev

# Start with specific character
elizaos start --character characters/development.json --dev

# Start with debug logging
LOG_LEVEL=debug elizaos start --dev
```

#### **Method 2: Automated Testing**

```bash
# Run all tests
elizaos test

# Test specific components
elizaos test --filter "action-name"

# Test with specific character
elizaos test --character characters/test.json
```

#### **Method 3: Production Testing**

```bash
# Build and test production build
bun run build
NODE_ENV=production elizaos start --character characters/production.json
```

## 🎛️ Custom Plugin Development

For project-specific functionality beyond available plugins:

### When to Create Custom Plugins

- ✅ **Unique business logic** not available in existing plugins
- ✅ **Proprietary API integrations** specific to your use case
- ✅ **Custom data sources** or specialized workflows
- ❌ **NOT** for simple configuration changes (use character config)
- ❌ **NOT** for combining existing plugins (use character composition)

### Custom Plugin Structure

```typescript
// src/plugin.ts
import { Plugin, Action, ActionResult, Service } from '@elizaos/core';

// Custom service for your specific needs
class CustomService extends Service {
  static serviceType = 'custom';

  async initialize(runtime: IAgentRuntime): Promise<void> {
    // Initialize your custom integrations
  }

  async processCustomRequest(message: any): Promise<any> {
    // Process the custom request
    // Add your custom logic here
    return {
      success: true,
      message: 'Custom request processed successfully',
      data: message.content,
    };
  }
}

// Custom action for specific commands
const customAction: Action = {
  name: 'CUSTOM_ACTION',
  description: 'Handles custom functionality specific to this project',

  validate: async (runtime, message) => {
    return message.content.text.includes('custom');
  },

  handler: async (runtime, message, state, options, callback): Promise<ActionResult> => {
    try {
      const service = runtime.getService<CustomService>('custom');
      // Your custom logic here
      const result = await service.processCustomRequest(message);

      // Callback sends message to user in chat
      await callback({
        text: 'Custom functionality executed successfully',
        action: 'CUSTOM_ACTION',
      });

      // Return ActionResult for action chaining
      return {
        success: true,
        text: 'Custom action completed',
        values: {
          customResult: result,
          processedAt: Date.now(),
        },
        data: {
          actionName: 'CUSTOM_ACTION',
          result,
        },
      };
    } catch (error) {
      await callback({
        text: 'Failed to execute custom action',
        error: true,
      });

      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },
};

export const customPlugin: Plugin = {
  name: 'custom-project-plugin',
  description: 'Project-specific functionality',
  services: [CustomService],
  actions: [customAction],
};
```

### Integrating Custom Plugin

```typescript
// src/character.ts
import { customPlugin } from './plugin';

export const character: Character = {
  // ... other config
  plugins: [
    // Core plugins
    '@elizaos/plugin-bootstrap',
    '@elizaos/plugin-sql',
    '@elizaos/plugin-openai',

    // Your custom plugin
    customPlugin,

    // Other plugins...
  ],
};
```

## 📊 Agent Memory & Persistence

### Memory Configuration

```typescript
// Agent automatically persists:
// - Conversation history
// - Learned patterns
// - User preferences
// - Context relationships

// Access agent memories:
const memories = await runtime.getMemories({
  roomId: currentRoomId,
  count: 10,
  unique: true,
});

// Add custom memory:
await runtime.addMemory({
  content: { text: 'Important user preference noted' },
  type: 'preference',
  roomId: currentRoomId,
});
```

### Database Configuration

```bash
# SQLite (default - good for development)
DATABASE_URL=sqlite://./data/agent.db

# PostgreSQL (recommended for production)
DATABASE_URL=postgresql://username:password@localhost:5432/agent_db

# Custom database adapter (advanced)
DATABASE_ADAPTER=custom
```

## 🚀 Deployment Guide

### Local Production Deployment

```bash
# Build for production
bun run build

# Start in production mode
NODE_ENV=production elizaos start --character characters/production.json

# With process manager (recommended)
pm2 start "elizaos start --character characters/production.json" --name "my-agent"
```

## 🔧 Advanced Configuration

### Multi-Character Management

```typescript
// src/characters.ts
export const characters = {
  assistant: assistantCharacter,
  crypto: cryptoCharacter,
  social: socialCharacter,
  researcher: researcherCharacter
};

// Start specific character
elizaos start --character characters/crypto.json
```

### Plugin Configuration Override

```typescript
// Advanced plugin configuration
export const character: Character = {
  // ... base config
  plugins: [
    {
      // Plugin with custom config
      name: '@elizaos/plugin-openai',
      config: {
        model: 'gpt-4o-mini',
        temperature: 0.7,
        maxTokens: 2000,
      },
    },
  ],
};
```

### Performance Optimization

```typescript
// High-performance character config
export const character: Character = {
  // ... base config
  settings: {
    // Optimize for speed
    model: 'gpt-4o-mini', // Faster model
    embeddingModel: 'text-embedding-3-small', // Smaller embeddings

    // Memory management
    maxMemories: 1000, // Limit memory size
    memoryDecay: 0.95, // Gradual forgetting

    // Response optimization
    streamingEnabled: true, // Stream responses
    batchSize: 5, // Batch API calls
  },
};
```

## 🐛 Troubleshooting Guide

### Common Issues & Solutions

| Issue                 | Symptoms                        | Solution                                 |
| --------------------- | ------------------------------- | ---------------------------------------- |
| **Agent won't start** | "Plugin not found" errors       | Check plugin installation: `bun install` |
| **No responses**      | Agent loads but doesn't respond | Verify API keys in `.env` file           |
| **Memory errors**     | Database connection failed      | Check `DATABASE_URL` configuration       |
| **Slow responses**    | Long delays in replies          | Switch to faster model (gpt-4o-mini)     |
| **Rate limits**       | API quota exceeded              | Implement rate limiting or upgrade plan  |

### Debug Commands

```bash
# Maximum verbosity
LOG_LEVEL=debug elizaos start

# Test specific functionality
elizaos test --filter "openai" --verbose

# Check plugin loading
elizaos start --dry-run --verbose

# Database troubleshooting
elizaos db:status
elizaos db:migrate
```

### Health Monitoring

```typescript
// Built-in health checks
GET /health           # Basic health status
GET /health/detailed  # Detailed system info
GET /api/status      # Agent status and metrics
```

## 📋 Production Checklist

Before deploying your agent to production:

### Security

- [ ] API keys stored in environment variables
- [ ] Database credentials secured
- [ ] Rate limiting configured
- [ ] Input validation enabled
- [ ] Error messages don't leak sensitive data

### Performance

- [ ] Appropriate model selected for use case
- [ ] Memory limits configured
- [ ] Database optimized (PostgreSQL for production)
- [ ] Caching enabled where appropriate
- [ ] Health monitoring set up

### Reliability

- [ ] Error handling covers edge cases
- [ ] Graceful degradation for API failures
- [ ] Database backups configured
- [ ] Process monitoring (PM2, Docker health checks)
- [ ] Logging configured appropriately

### Testing

- [ ] Core functionality tested
- [ ] Integration tests pass
- [ ] Load testing completed
- [ ] Monitoring and alerting configured

## 🎯 Next Steps

### 1. **Start Simple**

Begin with basic configuration and core plugins, then gradually add complexity.

### 2. **Iterate Based on Usage**

Monitor your agent's performance and user interactions to guide improvements.

### 3. **Contribute Back**

Share useful patterns and plugins with the ElizaOS community.

### 4. **Scale Thoughtfully**

Plan for growth with proper infrastructure and monitoring.

---

**🎉 Ready to build your ElizaOS agent!** Start with `elizaos start --dev` and let your agent evolve with your needs.
