---
sidebar_position: 1
---

# Introduction to ElizaOS

![](/img/eliza_banner.jpg)
_As seen powering [@DegenSpartanAI](https://x.com/degenspartanai) and [@aixvc_agent](https://x.com/aixvc_agent)_

## What is ElizaOS?

ElizaOS is an open-source framework for creating AI agents that can interact across multiple platforms through a consistent, extensible architecture. Built with TypeScript, it provides a modular system for developing intelligent agents with flexible personalities, knowledge, and capabilities.

- [Technical Report (Whitepaper)](https://arxiv.org/pdf/2501.06781)
- [Examples (Awesome Eliza)](https://github.com/elizaos/awesome-eliza)

## Key Features

- **Modular Architecture**: Plugin-based system for extending functionality
- **Entity-Component System**: Flexible data modeling for agents and users
- **Vector-Based Memory**: Semantic retrieval of conversations and knowledge
- **Multi-Modal Interactions**: Support for text, voice, images, and other media formats
- **Reflection & Self-Improvement**: Agents learn from interactions and adapt over time
- **Cross-Platform Integration**: Connect to multiple services through a unified interface

## Platform Support

ElizaOS integrates with multiple platforms through its service architecture:

- **Communication**: Discord, Telegram, X (Twitter), Slack, Farcaster
- **Model Providers**: OpenAI, Anthropic, Deepseek, Ollama, Grok, Gemini, Llama
- **Development Tools**: Local development environment, CLI tools, testing framework

## Use Cases

ElizaOS can be used to create:

- **AI Assistants**: Customer support agents, community moderators, personal assistants
- **Social Media Personas**: Automated content creators, brand representatives, influencers
- **Knowledge Workers**: Research assistants, content analysts, document processors
- **Interactive Characters**: Role-playing characters, educational tutors, entertainment bots

## Architecture

![](/img/eliza-architecture.jpg)
Source: https://x.com/0xCygaar/status/1874575841763770492

ElizaOS uses a structured architecture with the following key components:

- **Agent Runtime**: The central system that orchestrates components, manages state, and coordinates behavior
- **Projects**: Top-level containers defining agent configurations and shared resources
- **Entities & Components**: Flexible data modeling using an entity-component architecture
- **Services**: Connections to different platforms with a consistent interface
- **Actions**: Define how agents respond and interact with the world
- **Providers**: Supply contextual information to agents for decision-making
- **Evaluators**: Analyze conversations to help agents learn and improve
- **Plugins**: Extend ElizaOS with new capabilities across all components

The architecture is designed to be modular, allowing for customization and extension to meet specific requirements.

## Getting Started

### Prerequisites

- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) (version 23.3.0 recommended)
- [pnpm](https://pnpm.io/installation) (for development)

> **Note for Windows Users:** [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) is recommended.

### Quick Start with CLI

The easiest way to get started is with the ElizaOS CLI:

```bash
# Create a new project
npx @elizaos/cli create

# Follow the interactive prompts to configure your project

# Navigate to your project
cd my-elizaos-project

# Start your agent
npx @elizaos/cli start
```

### Alternative: Clone a Starter Project

```bash
# Clone the starter project
git clone https://github.com/elizaos/eliza-starter.git
cd eliza-starter

# Copy environment configuration
cp .env.example .env

# Install dependencies and start
pnpm i && pnpm build && pnpm start
```

For detailed instructions, see our [Quickstart Guide](./quickstart.md).

## Key Concepts

ElizaOS organizes interactions using several key concepts:

- **Worlds**: Collections of entities and rooms (like a Discord server or Slack workspace)
- **Rooms**: Spaces for conversations within worlds (channels, direct messages, etc.)
- **Entities**: Users, agents, or any participant that can interact within the system
- **Tasks**: System for managing deferred, scheduled, and interactive operations

Understanding these concepts is essential for creating effective agent interactions.

## Community and Support

ElizaOS is backed by an active community of developers and users:

- [**GitHub Repository**](https://github.com/elizaos/eliza): Contribute to the project
- [**Examples**](https://github.com/elizaos/characters): Ready-to-use character templates
- [**Discord Community**](https://discord.gg/elizaos): Get help and share ideas

Join us in building the future of autonomous AI agents with ElizaOS!

## Next Steps

- [Create Your First Agent](./quickstart.md)
- [Understand Core Concepts](./core/overview.md)
- [Explore the CLI](./cli/create.md)
