# 🤖 ElizaOS Automated n8n Creation Plugin

> **Transform your ElizaOS agents into autonomous plugin developers!** This revolutionary plugin empowers AI agents to create, build, test, and deploy new ElizaOS plugins using natural language or structured specifications.

[![npm version](https://img.shields.io/npm/v/@elizaos/plugin-auton8n.svg)](https://www.npmjs.com/package/@elizaos/plugin-auton8n)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🌟 What is AutoN8n?

AutoN8n (Auomated n8n) is a groundbreaking ElizaOS plugin that enables **AI-driven plugin development**. Your agents can now:

- 🧠 **Generate complete plugins** from simple descriptions
- 🔄 **Iteratively refine code** through AI-powered development cycles
- ✅ **Automatically test and validate** generated plugins
- 🚀 **Deploy production-ready code** without human intervention
- 🔧 **Integrate with n8n workflows** for advanced automation scenarios

## 🎯 Key Features

### AI-Powered Development
- **Claude AI Integration**: Leverages Anthropic's Claude for intelligent code generation
- **Multi-Model Support**: Choose between Claude Sonnet 3.5 or Opus 3 models
- **Context-Aware Generation**: Creates code that follows ElizaOS best practices

### Autonomous Development Lifecycle
- **5-Stage Pipeline**: Generation → Build → Lint → Test → Validation
- **Self-Healing**: Automatically fixes errors through iterative refinement
- **Quality Assurance**: Built-in code quality checks and AI validation

### Developer Experience
- **Natural Language Interface**: Create plugins by simply describing what you need
- **Real-Time Progress Tracking**: Monitor plugin creation status and logs
- **Job Management**: Start, track, and cancel plugin creation jobs

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- ElizaOS framework
- Anthropic API key

### Installation

```bash
# Install the plugin
npm install @elizaos/plugin-auton8n

# Or with yarn
yarn add @elizaos/plugin-auton8n

# Or with pnpm
pnpm add @elizaos/plugin-auton8n
```

### Configuration

1. Create a `.env` file:

```env
# Required
ANTHROPIC_API_KEY=sk-ant-api03-...

# Optional
PLUGIN_DATA_DIR=./plugin-workspace
CLAUDE_MODEL=claude-3-5-sonnet-20241022
```

2. Register the plugin in your agent:

```typescript
import { pluginDynamic } from '@elizaos/plugin-auton8n';

const agent = new Agent({
  name: "DevBot",
  plugins: [pluginDynamic],
  // ... other configuration
});
```

## 💬 Usage Examples

### Example 1: Create a Weather Plugin

```
User: Create a weather plugin that can fetch current weather and forecasts for any city

Agent: I'll create a comprehensive weather plugin for you. This will include actions for fetching current weather and forecasts, with proper error handling and caching.

🚀 Plugin creation started!
📋 Job ID: 7d4b3c2a-8e9f-4a1b-9c5d-1234567890ab
⏳ Status: Generating plugin code...

The plugin will include:
- getCurrentWeather action
- getWeatherForecast action  
- weatherProvider for context
- Caching service for API efficiency
- OpenWeatherMap API integration

Use "check plugin status" to monitor progress.
```

### Example 2: Create from Specification

```typescript
User: Create a plugin with this spec:
{
  "name": "@elizaos/plugin-github",
  "description": "GitHub integration for repo management",
  "actions": [
    {
      "name": "createIssue",
      "description": "Create a new GitHub issue",
      "parameters": {
        "repo": "string",
        "title": "string", 
        "body": "string",
        "labels": "string[]"
      }
    },
    {
      "name": "mergePR",
      "description": "Merge a pull request",
      "parameters": {
        "repo": "string",
        "prNumber": "number"
      }
    }
  ]
}

Agent: Creating your GitHub integration plugin now...
```

### Example 3: Natural Language to Plugin

```
User: I need a plugin that helps track cryptocurrency prices and send alerts when prices change by more than 5%

Agent: I'll create a cryptocurrency price tracking plugin with alerting capabilities. This will include:

📊 Real-time price tracking
🔔 Configurable price alerts (5% threshold)
💰 Support for multiple cryptocurrencies
📈 Price history tracking
🚨 Alert notifications through multiple channels

Starting development now... Job ID: abc-123-def
```

## 🛠️ Available Actions

### `createPlugin`
Creates a plugin from a detailed specification.

```typescript
// Example usage in conversation
User: Create a plugin with the specification: { ... }
```

### `createPluginFromDescription`
Creates a plugin from natural language description.

```typescript
// Example usage
User: Create a plugin that can translate text between languages
```

### `checkPluginCreationStatus`
Monitors the progress of plugin creation.

```typescript
// Example response
Agent: 📊 Plugin Creation Status:
├─ Status: running
├─ Phase: testing (4/5)
├─ Progress: 80%
└─ Recent activity:
   • ✅ Code generation complete
   • ✅ Build successful
   • ✅ Linting passed
   • 🔄 Running tests... (18/20 passed)
```

### `cancelPluginCreation`
Cancels an active plugin creation job.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     AutoN8n Plugin System                     │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │   Actions    │    │  Providers   │    │   Services    │  │
│  │             │    │              │    │               │  │
│  │ • create    │    │ • status     │    │ • Plugin      │  │
│  │ • check     │◄───┤ • capability │◄───┤   Creation    │  │
│  │ • cancel    │    │ • registry   │    │   Service     │  │
│  │ • describe  │    │ • exists     │    │               │  │
│  └─────────────┘    └──────────────┘    └───────┬───────┘  │
│                                                   │          │
│                    ┌──────────────────────────────▼───────┐  │
│                    │     AI Code Generation Pipeline      │  │
│                    ├──────────────────────────────────────┤  │
│                    │                                      │  │
│                    │  Generate → Build → Lint → Test     │  │
│                    │     ↑                        │       │  │
│                    │     └────── Validate ────────┘       │  │
│                    │                                      │  │
│                    │  Max 5 iterations for refinement    │  │
│                    └──────────────────────────────────────┘  │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## 📁 Generated Plugin Structure

When AutoN8n creates a plugin, it generates a complete, production-ready structure:

```
generated-plugin/
├── src/
│   ├── index.ts              # Main plugin export
│   ├── actions/              # Action implementations
│   ├── providers/            # Context providers
│   ├── services/             # Service classes
│   └── __tests__/            # Comprehensive tests
├── package.json              # Dependencies & scripts
├── tsconfig.json             # TypeScript configuration
├── vitest.config.ts          # Test configuration
├── .eslintrc.json            # Linting rules
└── README.md                 # Plugin documentation
```

## 🧪 Testing & Quality Assurance

AutoN8n ensures high-quality plugin generation through:

1. **Automated Testing**: Every generated plugin includes comprehensive test suites
2. **Code Linting**: ESLint validation ensures code style consistency
3. **Type Safety**: Full TypeScript support with strict type checking
4. **AI Validation**: Claude reviews the generated code for completeness
5. **Iterative Refinement**: Automatically fixes issues through multiple iterations

## 🔧 Advanced Configuration

### Model Selection

Choose between different Claude models based on your needs:

```typescript
// Use Sonnet for faster generation
process.env.CLAUDE_MODEL = 'claude-3-5-sonnet-20241022';

// Use Opus for more complex plugins
process.env.CLAUDE_MODEL = 'claude-3-opus-20240229';
```

### Custom Templates

Provide your own plugin templates:

```typescript
const customSpec = {
  name: '@company/plugin-custom',
  template: 'path/to/custom-template',
  // ... other options
};
```

## 🐛 Troubleshooting

### Common Issues & Solutions

#### "AI code generation not available"
```bash
# Check your API key
echo $ANTHROPIC_API_KEY

# Verify it starts with sk-ant-api
# Get a key from https://console.anthropic.com
```

#### Build failures
```bash
# Check job logs
User: Check plugin creation status

# Common fixes:
# 1. Ensure all dependencies are specified
# 2. Check for TypeScript syntax errors
# 3. Verify import paths are correct
```

#### "Plugin already exists"
```bash
# The plugin name is already in use
# Try a different name or check existing plugins
User: Show me all created plugins
```

### Debug Mode

Enable detailed logging:

```typescript
// In your .env file
DEBUG=elizaos:plugin-auton8n:*

// Or programmatically
process.env.DEBUG = 'elizaos:plugin-auton8n:*';
```

## 🤝 Contributing

We love contributions! Here's how to help:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Development Setup

```bash
# Clone the repo
git clone https://github.com/elizaos/elizaos.git
cd packages/plugin-auton8n

# Install dependencies
pnpm install

# Run tests
pnpm test

# Build the plugin
pnpm build
```

## 📚 Resources

- [ElizaOS Documentation](https://elizaos.github.io/eliza/)
- [Plugin Development Guide](https://elizaos.github.io/eliza/docs/plugins)
- [API Reference](https://elizaos.github.io/eliza/api)
- [Discord Community](https://discord.gg/elizaos)

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built with ❤️ by the ElizaOS community
- Powered by [Anthropic's Claude](https://www.anthropic.com)
- Inspired by [n8n](https://n8n.io) workflow automation

---

<p align="center">
  <strong>Ready to give your AI agents superpowers? Install AutoN8n today!</strong>
</p>

<p align="center">
  <a href="https://github.com/elizaos/eliza">⭐ Star us on GitHub</a> •
  <a href="https://twitter.com/elizaos">🐦 Follow on Twitter</a> •
  <a href="https://discord.gg/elizaos">💬 Join our Discord</a>
</p>
