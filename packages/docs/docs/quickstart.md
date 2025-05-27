---
sidebar_position: 2
title: Quickstart Guide
description: Get started quickly with ElizaOS - from installation to running your first AI agent
keywords:
  [quickstart, installation, setup, configuration, CLI, agents, plugins, development, deployment]
image: /img/eliza_banner.jpg
---

# Quickstart Guide

## Prerequisites

- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- Git for version control
- For Windows Users: [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) is required

## Installation

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
  <TabItem value="global" label="Install Globally (Recommended)" default>

```bash
# Install globally
npm install -g @elizaos/cli
# Start ElizaOS
elizaos start
```

  </TabItem>
  <TabItem value="npx" label="Test with NPX">

```bash
# Use directly with npx
npx @elizaos/cli start
```

  </TabItem>
  <TabItem value="source" label="Install from Source">

```bash
# Clone the repository
git clone git@github.com:elizaOS/eliza.git
cd eliza

# Switch to development branch
git checkout v2-develop

# Install dependencies
bun install

# Build the project
bun run build

# Start ElizaOS
bun start
```

  </TabItem>
</Tabs>

This will:

1. Start ElizaOS with default settings
2. Load the default character
3. Make the agent accessible via terminal and REST API

> **Note:** If you encounter any errors on first startup, try running the start command again. The initial startup sometimes needs a second attempt to properly initialize all components.

### Chat with your agent:

Visit https://localhost:3000 to interact with your agent through a web interface.

## 2. Creating a Project

If you want to create a custom ElizaOS project with your own characters and configurations:

```bash
# Create a new project with the interactive wizard
elizaos create
# Or specify project type directly
elizaos create --type project
```

Follow the interactive prompts to configure your project. Once created:

```bash
# Navigate to your project directory
cd my-project-name
# Start your project
elizaos start
```

> If it fails the first time try the start command again

### Project Structure

A typical ElizaOS project structure looks like this:

```
my-project/
├── src/
│   └── index.ts      # Main entry point with character definitions
├── knowledge/        # Knowledge files for RAG
├── package.json      # Project configuration and dependencies
└── tsconfig.json     # TypeScript configuration
```

The character definition is located in `src/index.ts` where you can modify the agent's personality, plugins, and settings. This is the core file for customizing your agent's behavior.

### Add plugins to your project:

```bash
# List available plugins for a project
elizaos plugins list
# Add a plugin
elizaos plugins add @elizaos/plugin-discord
```

### Working with Character Files

You can import or export character files using the CLI:

```bash
# Export character to a JSON file
elizaos character export --output my-character.json

# Import character from a JSON file
elizaos character import --file my-character.json
```

This is particularly useful for those migrating from v1 who are used to working with standalone character files.

## 3. Creating a Plugin

Want to extend ElizaOS with custom functionality?

```bash
# Create a new plugin project
elizaos create --type plugin
```

Develop your plugin following the structure in your generated project:

```bash
# Test your plugin
elizaos start
# Publish your plugin when ready
elizaos plugins publish
```

### Publishing options:

```bash
# Test publish without making changes
elizaos plugins publish --test
# Publish to npm
elizaos plugins publish --npm
# Specify platform compatibility
elizaos plugins publish --platform node
```

---

## Troubleshooting

### Node Version

- Use Node.js 23.3.0+ (`node -v` to check)
- Try using NVM: `nvm use 23`

### Installation Problems

```bash
# Clean and reinstall
bun clean
bun install --no-frozen-lockfile
bun build
```

### Plugin Issues

```bash
# Rebuild problematic packages
bun rebuild better-sqlite3
```

### Docker Issues

```bash
# Clean up Docker environment
docker rmi -f $(docker images -aq)
docker builder prune -a -f
```

### First-time Startup Issues

If your agent fails to start on the first attempt:

- Run the start command again
- Check logs for specific errors
- Ensure all dependencies are properly installed
- Verify that your database configuration is correct

---

## Next Steps

Once you have your agent running, explore:

- 🤖 [Understand Agents](./core/agents.md)
- ⚡ [Add Custom Actions](./core/actions.md)
- 🧠 [Configure Knowledge](./core/knowledge.md)
- 🔌 [Add Services](./core/services.md)

Join the [Discord community](https://discord.gg/elizaOS) for support and to share what you're building!
