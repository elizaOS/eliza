# 🤖 elizaOS N8n Plugin

> **AI-powered plugin creation for ElizaOS** - Transform natural language into production-ready plugins using Claude models.

[![npm version](https://img.shields.io/npm/v/@elizaos/plugin-n8n.svg)](https://www.npmjs.com/package/@elizaos/plugin-n8n)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🌟 Overview

The N8n plugin enables AI agents to autonomously create, build, test, and deploy ElizaOS plugins. Available in **TypeScript**, **Python**, and **Rust** with full feature parity.

### Key Features

- 🧠 **AI-Powered Generation** - Claude models generate complete plugin implementations
- 🔄 **Iterative Refinement** - Automatic error fixing through build/lint/test cycles
- ✅ **Quality Assurance** - Built-in testing and validation
- 🚀 **Production Ready** - Generated code follows ElizaOS best practices
- 🌐 **Multi-Language** - Use from TypeScript, Python, or Rust

## 📦 Installation

### TypeScript/Node.js

```bash
npm install @elizaos/plugin-n8n
# or
pnpm add @elizaos/plugin-n8n
# or
bun add @elizaos/plugin-n8n
```

### Python

```bash
pip install elizaos-plugin-n8n
```

### Rust

```toml
[dependencies]
elizaos-plugin-n8n = "1.0"
```

## ⚙️ Configuration

Set the following environment variables:

| Variable            | Required | Description                | Default                  |
| ------------------- | -------- | -------------------------- | ------------------------ |
| `ANTHROPIC_API_KEY` | ✅       | Anthropic API key          | -                        |
| `PLUGIN_DATA_DIR`   | ❌       | Plugin workspace directory | `./data`                 |
| `CLAUDE_MODEL`      | ❌       | Claude model to use        | `claude-3-opus-20240229` |

## 🚀 Quick Start

### TypeScript

```typescript
import { n8nPlugin } from "@elizaos/plugin-n8n";

// Register with your agent
const agent = new Agent({
  name: "DevBot",
  plugins: [n8nPlugin],
});

// The agent can now create plugins via conversation:
// "Create a weather plugin that fetches current conditions"
```

### Python

```python
import asyncio
from elizaos_plugin_n8n import N8nConfig, PluginCreationClient, PluginSpecification

async def main():
    config = N8nConfig.from_env()

    async with PluginCreationClient(config) as client:
        spec = PluginSpecification(
            name="@elizaos/plugin-weather",
            description="Weather information plugin",
            actions=[{"name": "getWeather", "description": "Get weather"}],
        )

        job_id = await client.create_plugin(spec)
        print(f"Job started: {job_id}")

asyncio.run(main())
```

### Rust

```rust
use elizaos_plugin_n8n::{N8nConfig, PluginCreationClient, PluginSpecification};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = N8nConfig::from_env()?;
    let client = PluginCreationClient::new(config)?;

    let spec = PluginSpecification::builder()
        .name("@elizaos/plugin-weather")
        .description("Weather information plugin")
        .build()?;

    let job_id = client.create_plugin(spec, None).await?;
    println!("Job started: {}", job_id);

    Ok(())
}
```

## 💬 Conversational Usage

Once the plugin is registered with an agent, users can create plugins through natural conversation:

```
User: Create a plugin that helps manage todo lists with add, remove, and list functionality

Agent: I'll create a todo list management plugin for you!

📦 Plugin: @elizaos/plugin-todo
📝 Description: Todo list management with add, remove, and list functionality
🆔 Job ID: abc-123-def

Components to be created:
- 3 actions (addTodo, removeTodo, listTodos)
- 1 provider (todoProvider)

Use 'check plugin status' to monitor progress.
```

## 🛠️ Actions

| Action                        | Description                           |
| ----------------------------- | ------------------------------------- |
| `createPlugin`                | Create plugin from JSON specification |
| `createPluginFromDescription` | Create plugin from natural language   |
| `checkPluginCreationStatus`   | Check job progress                    |
| `cancelPluginCreation`        | Cancel active job                     |

## 📊 Providers

| Provider                       | Description            |
| ------------------------------ | ---------------------- |
| `plugin_creation_status`       | Active job status      |
| `plugin_creation_capabilities` | Available features     |
| `plugin_registry`              | Created plugins list   |
| `plugin_exists_check`          | Check if plugin exists |

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     N8n Plugin System                        │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────┐   │
│  │   Actions   │    │  Providers   │    │   Services    │   │
│  │             │    │              │    │               │   │
│  │ • create    │    │ • status     │    │ • Plugin      │   │
│  │ • check     │◄───┤ • capability │◄───┤   Creation    │   │
│  │ • cancel    │    │ • registry   │    │   Service     │   │
│  │ • describe  │    │ • exists     │    │               │   │
│  └─────────────┘    └──────────────┘    └───────┬───────┘   │
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

## 📁 Project Structure

```
plugin-n8n/
├── typescript/           # TypeScript implementation
│   ├── index.ts         # Main plugin export
│   ├── actions/         # Action implementations
│   ├── providers/       # Provider implementations
│   ├── services/        # Service classes
│   ├── types/           # Type definitions
│   ├── utils/           # Utilities
│   └── __tests__/       # Tests
├── python/              # Python implementation
│   ├── elizaos_plugin_n8n/
│   │   ├── __init__.py
│   │   ├── client.py    # Main client
│   │   ├── config.py    # Configuration
│   │   ├── errors.py    # Error types
│   │   ├── models.py    # Model definitions
│   │   └── types.py     # Type definitions
│   └── tests/           # Tests
├── rust/                # Rust implementation
│   ├── src/
│   │   ├── lib.rs       # Library entry
│   │   ├── client.rs    # Main client
│   │   ├── config.rs    # Configuration
│   │   ├── error.rs     # Error types
│   │   ├── models.rs    # Model definitions
│   │   └── types.rs     # Type definitions
│   └── tests/           # Tests
├── package.json         # NPM package config
└── README.md           # This file
```

## 🧪 Development

### Build All

```bash
npm run build:all
```

### Test All

```bash
npm run test:all
```

### Lint All

```bash
npm run lint:all
```

### Language-Specific Commands

```bash
# TypeScript
npm run build
npm run test
npm run typecheck

# Python
npm run test:python
npm run lint:python
npm run typecheck:python

# Rust
npm run build:rust
npm run test:rust
npm run lint:rust
```

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- Built with ❤️ by the ElizaOS community
- Powered by [Anthropic's Claude](https://www.anthropic.com)
- Inspired by [n8n](https://n8n.io) workflow automation

---

<p align="center">
  <a href="https://github.com/elizaos/eliza">⭐ Star us on GitHub</a> •
  <a href="https://x.com/elizaos">🐦 Follow on X</a> •
  <a href="https://discord.gg/elizaos">💬 Join our Discord</a>
</p>
