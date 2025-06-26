---
sidebar_position: 2
title: Quickstart Guide
description: Get started quickly with ElizaOS - from installation to running your first AI agent in 5 minutes.
keywords: [quickstart, install, setup, run, create, agent]
image: /img/eliza_banner.jpg
---

# Quickstart Guide

This guide will get you from zero to a running AI agent in under 5 minutes.

### Prerequisites

- Node.js 23+
- [Bun](https://bun.sh) package manager
- Git
- Ollama or an API key from Openrouter, OpenAI, Anthropic, etc

> **Note for Windows Users:** [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) is required to run ElizaOS.

### 1. Install ElizaOS CLI

```bash
bun install -g @elizaos/cli
```

### 2. Create Your First Project

```bash
elizaos create my-agent
cd my-agent
```

### 3. Configure Your API Key

Your new project includes a `.env.example` file. You need to copy it to a new `.env` file to store your secret API keys.

```bash
# Copy the environment template to a new .env file
cp .env.example .env

# Open the file for editing
elizaos env edit-local

# Add either OPENAI_API_KEY or ANTHROPIC_API_KEY
```

Your agent will not work without an API key. For more details on environment configuration, see the [Environment Guide](./cli/env.md).

### 4. Create Your Character (Optional)

ElizaOS uses a character-centric architecture. Each character can have its own set of plugins and capabilities. You can create a custom character file:

```bash
# Create a new character file
elizaos create --type agent my-assistant

# This creates my-assistant.json with a basic template you can customize
```

Edit `my-assistant.json` to customize your agent:

```json
{
  "name": "MyAssistant",
  "plugins": [
    "@elizaos/plugin-openai"
  ],
  "system": "You are a helpful AI assistant.",
  "bio": ["Helpful", "Knowledgeable", "Friendly"],
  "messageExamples": [
    [
      {
        "user": "{{user1}}",
        "content": { "text": "Hello!" }
      },
      {
        "user": "{{agent}}",
        "content": { "text": "Hello! How can I help you today?" }
      }
    ]
  ]
}
```

### 5. Start Your Agent

```bash
# Start with default character
elizaos start

# Or start with your custom character
elizaos start --character my-assistant.json
```

Your agent is now running at [http://localhost:3000](http://localhost:3000)! 🎉

## What's Next?

Congratulations, you have a running ElizaOS agent! Here's where to go next to explore its full power:

- **[Explore all CLI Commands](./cli/overview.md)**: See everything you can do from the command line, including managing agents and plugins.
- **[Customize Your Agent](./core/characters.md)**: Learn how to edit your agent's personality, knowledge, and abilities using Character Files.
- **[Understand the Project Structure](./core/project.md)**: Get a detailed breakdown of every file in your new project.
- **[Extend Your Agent with Plugins](./core/plugins.md)**: Discover how to add new capabilities to your agent by adding plugins to your character configuration.
