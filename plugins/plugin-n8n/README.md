# 🤖 elizaOS N8n Plugin

> **Comprehensive n8n integration for elizaOS** - Create elizaOS plugins and manage n8n workflows using AI-powered natural language processing.

[![npm version](https://img.shields.io/npm/v/@elizaos/plugin-n8n.svg)](https://www.npmjs.com/package/@elizaos/plugin-n8n)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🌟 Overview

The N8n plugin provides two powerful capabilities:

1. **AI-Powered elizaOS Plugin Creation** - Transform natural language into production-ready elizaOS plugins using Claude models
2. **n8n Workflow Management** - Generate and manage n8n workflows from natural language using a RAG pipeline

Available in **TypeScript**, **Python**, and **Rust** with full feature parity.

### Key Features

#### Plugin Creation
- 🧠 **AI-Powered Generation** - Claude models generate complete plugin implementations
- 🔄 **Iterative Refinement** - Automatic error fixing through build/lint/test cycles
- ✅ **Quality Assurance** - Built-in testing and validation
- 🚀 **Production Ready** - Generated code follows elizaOS best practices
- 🌐 **Multi-Language** - Use from TypeScript, Python, or Rust

#### Workflow Management
- 🔄 **RAG Pipeline** - Intelligent workflow generation from natural language
- 📦 **450+ Native Nodes** - Support for Gmail, Slack, Stripe, and more
- 🔐 **Credential Resolution** - Intelligent credential management with OAuth support
- 🎯 **Full Lifecycle** - Create, activate, deactivate, delete, and monitor workflows
- 💬 **Conversational Interface** - Natural language workflow creation and modification

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

### Plugin Creation Features

| Variable            | Required | Description                | Default                  |
| ------------------- | -------- | -------------------------- | ------------------------ |
| `ANTHROPIC_API_KEY` | ✅       | Anthropic API key          | -                        |
| `PLUGIN_DATA_DIR`   | ❌       | Plugin workspace directory | `./data`                 |
| `CLAUDE_MODEL`      | ❌       | Claude model to use        | `claude-3-opus-20240229` |

### Workflow Management Features

| Variable       | Required | Description                    | Example                    |
|----------------|----------|--------------------------------|----------------------------|
| `N8N_API_KEY`  | ✅*      | Your n8n instance API key      | `n8n_api_abc123...`        |
| `N8N_HOST`     | ✅*      | Your n8n instance URL           | `https://your.n8n.cloud`  |

*Required only for workflow management features

### Optional: Pre-configured Credentials

For workflow features, you can pre-configure credential IDs:

```json
{
  "name": "AI Workflow Builder",
  "plugins": ["@elizaos/plugin-n8n"],
  "settings": {
    "N8N_API_KEY": "env:N8N_API_KEY",
    "N8N_HOST": "https://your.n8n.cloud",
    "workflows": {
      "credentials": {
        "gmailOAuth2": "cred_gmail_123",
        "stripeApi": "cred_stripe_456"
      }
    }
  }
}
```

## 🚀 Quick Start

### TypeScript

```typescript
import { n8nPlugin } from "@elizaos/plugin-n8n";

// Register with your agent
const agent = new Agent({
  name: "DevBot",
  plugins: [n8nPlugin],
});

// The agent can now:
// 1. Create elizaOS plugins: "Create a weather plugin that fetches current conditions"
// 2. Create n8n workflows: "Create a workflow that sends me Stripe payment summaries every Monday via Gmail"
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

### Creating elizaOS Plugins

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

### Creating n8n Workflows

```
User: Send me Stripe payment summaries every Monday via Gmail

Agent: I'll create a workflow for you!

📋 Workflow Preview: Daily Stripe Summary via Gmail
Nodes:
- Schedule Trigger (runs every Monday)
- Stripe (fetches payments)
- Gmail (sends summary email)

Flow: Schedule Trigger → Stripe → Gmail
Credentials needed: stripeApi, gmailOAuth2

Say "deploy" to create this workflow, or "modify" to make changes.
```

## 🛠️ Actions

### Plugin Creation Actions

| Action                        | Description                           |
| ----------------------------- | ------------------------------------- |
| `createPlugin`                | Create plugin from JSON specification |
| `createPluginFromDescription` | Create plugin from natural language   |
| `checkPluginCreationStatus`   | Check job progress                    |
| `cancelPluginCreation`        | Cancel active job                     |

### Workflow Management Actions

| Action                    | Similes                                            | Description                                       |
|---------------------------|----------------------------------------------------|----------------------------------------------------|
| `CREATE_N8N_WORKFLOW`     | create, build, generate, confirm, deploy, cancel   | Full lifecycle: generate, preview, modify, deploy  |
| `ACTIVATE_N8N_WORKFLOW`   | activate, enable, start, turn on                   | Activate a workflow (+ draft redirect)             |
| `DEACTIVATE_N8N_WORKFLOW` | deactivate, disable, stop, pause, turn off         | Deactivate a running workflow                      |
| `DELETE_N8N_WORKFLOW`     | delete, remove, destroy                            | Permanently delete a workflow                      |
| `GET_N8N_EXECUTIONS`      | executions, history, runs                          | Show execution history (last 10 runs)              |

## 📊 Providers

### Plugin Creation Providers

| Provider                       | Description            |
| ------------------------------ | ---------------------- |
| `plugin_creation_status`       | Active job status      |
| `plugin_creation_capabilities` | Available features     |
| `plugin_registry`              | Created plugins list   |
| `plugin_exists_check`          | Check if plugin exists |

### Workflow Providers

| Provider                 | Name                     | Runs On       | Description                                               |
|--------------------------|--------------------------|---------------|-----------------------------------------------------------|
| `pendingDraftProvider`   | `PENDING_WORKFLOW_DRAFT` | Every message | Injects draft context into LLM state for action routing   |
| `activeWorkflowsProvider`| `ACTIVE_N8N_WORKFLOWS`   | Every message | User's workflow list (up to 20) for semantic matching     |
| `workflowStatusProvider` | `n8n_workflow_status`    | Every message | Workflow status with last execution info (up to 10)       |

## 🏗️ Architecture

### Plugin Creation Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│                  Plugin Creation System                      │
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

### Workflow Management Pipeline

```
┌───────────────────────────────────────────────────────────────────┐
│                         elizaOS Runtime                           │
│                                                                   │
│  ┌─────────────┐  ┌──────────────────┐  ┌──────────────────────┐ │
│  │  Services    │  │  Actions          │  │  Providers           │ │
│  │             │  │                  │  │                      │ │
│  │ N8nWorkflow │  │ CREATE_N8N_WF    │  │ PENDING_DRAFT        │ │
│  │ Service     │  │ ACTIVATE_N8N_WF  │  │ ACTIVE_WORKFLOWS     │ │
│  │             │  │ DEACTIVATE_N8N_WF│  │ WORKFLOW_STATUS       │ │
│  │ N8nCred     │  │ DELETE_N8N_WF    │  │                      │ │
│  │ Store (DB)  │  │ GET_N8N_EXECS    │  │                      │ │
│  └──────┬──────┘  └──────────────────┘  └──────────────────────┘ │
│         │                                                         │
│  ┌──────┴──────────────────────────────────────────────────────┐  │
│  │                    runtime.getCache()                       │  │
│  │              Per-user draft state machine                   │  │
│  │         Key: workflow_draft:{userId} — TTL: 30 min          │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌──────────────────┐  ┌────────────────────────────────────────┐ │
│  │  Database         │  │  LLM (via runtime.useModel)            │ │
│  │  PostgreSQL       │  │                                        │ │
│  │  n8n_workflow     │  │  TEXT_LARGE ─── workflow generation     │ │
│  │  .credential_     │  │  TEXT_SMALL ─── response formatting    │ │
│  │   mappings        │  │  OBJECT_SMALL ─ classification/extract │ │
│  └──────────────────┘  └────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌──────────────────┐         ┌────────────────────────┐
│  n8n REST API    │         │ External CredProvider   │
│  /api/v1/        │         │ (optional, e.g. OAuth)  │
│  workflows       │         │                         │
│  executions      │         │ resolve(userId, type)   │
│  tags            │         │ → resolved / needs_auth │
│  credentials     │         │                         │
└──────────────────┘         └────────────────────────┘
```

## 📁 Project Structure

```
plugin-n8n/
├── typescript/           # TypeScript implementation
│   ├── index.ts         # Main plugin export
│   ├── actions/         # Plugin creation actions
│   ├── providers/       # Plugin creation providers
│   ├── services/        # Plugin creation services
│   ├── workflow/        # Workflow management features
│   │   ├── actions/     # Workflow actions
│   │   ├── providers/   # Workflow providers
│   │   ├── services/    # Workflow services
│   │   ├── utils/       # Workflow utilities
│   │   ├── types/       # Workflow types
│   │   ├── prompts/     # LLM prompts
│   │   ├── schemas/     # JSON schemas
│   │   └── db/          # Database schema
│   ├── types/           # Type definitions
│   ├── utils/           # Utilities
│   └── __tests__/       # Tests
│       ├── unit/        # Unit tests
│       ├── integration/ # Integration tests
│       └── workflow/    # Workflow tests
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

- Built with ❤️ by the elizaOS community
- Powered by [Anthropic's Claude](https://www.anthropic.com)
- Inspired by [n8n](https://n8n.io) workflow automation

---

<p align="center">
  <a href="https://github.com/elizaos/eliza">⭐ Star us on GitHub</a> •
  <a href="https://x.com/elizaos">🐦 Follow on X</a> •
  <a href="https://discord.gg/elizaos">💬 Join our Discord</a>
</p>
