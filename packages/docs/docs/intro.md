---
sidebar_position: 1
title: Introduction to Eliza
description: A powerful multi-agent simulation framework for creating and managing autonomous AI agents
keywords:
  [
    introduction,
    AI agents,
    multi-agent,
    framework,
    TypeScript,
    autonomous agents,
    simulation,
    RAG,
    plugins,
  ]
image: /img/eliza_banner.jpg
---

# Introduction to Eliza

![](/img/eliza_banner.jpg)
_As seen powering [@DegenSpartanAI](https://x.com/degenspartanai) and [@aixvc_agent](https://x.com/aixvc_agent)_

## What is Eliza?

Eliza is a powerful multi-agent simulation framework designed to create, deploy, and manage autonomous AI agents. Built with TypeScript, it provides a flexible and extensible platform for developing intelligent agents that can interact across multiple platforms while maintaining consistent personalities and knowledge.

> Pro tip: copy paste the text from https://eliza.how/llms-full.txt into your preferred LLM.

## Key Features

New in Eliza v2!

| CLI Tool                          | Native GUI                        |
| --------------------------------- | --------------------------------- |
| [![](/img/cli.jpg)](/img/cli.jpg) | [![](/img/gui.jpg)](/img/gui.jpg) |

- **Platform Integration**: Clients for Discord, Telegram, Farcaster, and many others
- **Flexible Model Support**: Deepseek, Ollama, Grok, OpenAI, Anthropic, Gemini, LLama, etc.
- **Character System**: Create diverse agents using [character files](https://github.com/elizaOS/characterfile)
- **Multi-Agent Architecture**: Manage multiple unique AI personalities simultaneously
- **Memory Management**: Easily ingest and interact with documents using RAG
- **Media Processing**: PDF, URLs, Audio transcription, Video processing, Image analysis, Conversation summarization
- **Technical Foundation**:
  - 100% TypeScript implementation
  - Modular architecture
  - Highly extensible action and plugin system
  - Custom client support
  - Comprehensive API

---

## Installation

We offer several installation paths depending on your goal. If you're new to ElizaOS, we recommend starting with the **Install CLI Tool** tab. If you want to contribute to the core project, head to the **Contribute to ElizaOS Core** tab.

For detailed instructions on each path, including configuration options and extended capabilities, see our [Quickstart Guide](./quickstart.md). If you run into any issues, check our [**Frequently Asked Questions**](./faq.md).

### Prerequisites

- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- Git for version control
- For Windows Users: [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) is required

You can verify your Node.js version with the following command:
```bash
node --version
# Expected output: v23.0.0 or higher
```

If you have a different version, we recommend using [nvm](https://github.com/nvm-sh/nvm) (Node Version Manager) to switch to the correct version:
```bash
nvm install 23
nvm use 23
```

Eliza offers different paths depending on your goals:

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
  <TabItem value="cli" label="Install CLI Tool (Recommended)" default>

While you can use `npm`, we strongly recommend using `bun` for performance and compatibility with the ElizaOS ecosystem.

```bash
# Recommended: Install via bun (https://bun.sh/)
bun install -g @elizaos/cli

# Alternative: Install via npm
npm install -g @elizaos/cli

# From a folder to install a project
elizaos create
cd new-agent
elizaos start
```

Then visit https://localhost:3000 to interact with your agent through a web interface.

  </TabItem>
  <TabItem value="project" label="Create a Test Project">

```bash
# Create a new project through interactive setup
elizaos create

# Navigate to your project directory
cd my-project-name

# Start your project
elizaos start
```

  </TabItem>
  <TabItem value="plugin" label="Add a Custom Plugin">

Add plugins to your project:

```bash
# List available plugins
elizaos plugins list

# Add a plugin
elizaos plugins add @elizaos/plugin-discord

# Create a plugin project
elizaos create --type plugin
```

Develop and test your plugin:

```bash
# Test your plugin
elizaos start

# Publish your plugin when ready
elizaos publish
```

  </TabItem>
  <TabItem value="contribute" label="Contribute to ElizaOS Core">

```bash
# Clone the repository
git clone git@github.com:elizaOS/eliza.git
cd eliza

# Install dependencies and build
bun install
bun run build

# Start ElizaOS
bun start
```

Visit https://localhost:3000 to interact with your agent through a web interface.

  </TabItem>
</Tabs>

> If it fails the first time try the start command again

---

## Available Commands Reference

The `elizaos` CLI is the primary way to interact with your projects and agents. It is organized into several logical command groups:

| Category | Commands |
|----------|----------|
| Project Management | `create`, `start`, `stop` |
| Agent Management | `agent list`, `agent start`, `agent get` |
| Development | `dev`, `test`, `update` |
| Configuration | `env list`, `env edit-local`, `env interactive` |
| Plugin Ecosystem | `plugins list`, `plugins add`, `publish` |

For a complete list and detailed explanation of every command, see the [**CLI Overview**](./cli/overview.md).

You can also discover commands directly from your terminal:
```bash
# Get a list of all top-level commands
elizaos --help

# Get help for a specific command group
elizaos agent --help
```

---

## Community and Support

Eliza is backed by an active community of developers and users:

- [**Open Source**](https://github.com/elizaos/eliza): Contribute to the project on GitHub
- [**Technical Report (Whitepaper)**](https://arxiv.org/pdf/2501.06781)
- [**Awesome Eliza**](https://github.com/elizaos/awesome-eliza)
- [**Examples**](https://github.com/elizaos/characters): Ready-to-use character templates and implementations
- [**Support**](https://discord.gg/elizaos): Active community for troubleshooting and discussion

Join us in building the future of autonomous AI agents with Eliza!
