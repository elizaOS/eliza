---
sidebar_position: 1
---

# Introduction to Eliza

![](/img/eliza_banner.jpg)
_As seen powering [@DegenSpartanAI](https://x.com/degenspartanai) and [@aixvc_agent](https://x.com/aixvc_agent)_

## What is Eliza?

Eliza is a powerful multi-agent simulation framework designed to create, deploy, and manage autonomous AI agents. Built with TypeScript, it provides a flexible and extensible platform for developing intelligent agents that can interact across multiple platforms while maintaining consistent personalities and knowledge.

- [Technical Report (Whitepaper)](https://arxiv.org/pdf/2501.06781)
- [Examples (Awesome Eliza)](https://github.com/elizaos/awesome-eliza)

## Key Features

- **Platform Integration**: Clients for Discord, X (Twitter), Telegram, and many others
- **Flexible Model Support**: Deepseek, Ollama, Grok, OpenAI, Anthropic, Gemini, LLama, etc.
- **Character System**: Create diverse agents using [characterfiles](https://github.com/elizaOS/characterfile)
- **Multi-Agent Architecture**: Manage multiple unique AI personalities simultaneously
- **Memory Management**: Easily ingest and interact with documents using RAG
- **Media Processing**: PDF, URLs, Audio transcription, Video processing, Image analysis, Conversation summarization
- **Technical Foundation**:
  - 100% TypeScript implementation
  - Modular architecture
  - Highly extensible action and plugin system
  - Custom client support
  - Comprehensive API

## Use Cases

Eliza can be used to create:

- **AI Assistants**: Customer support agents, Community moderators, Personal assistants
- **Social Media Personas**: Automated content creators, Brand representatives, Influencers
- **Knowledge Workers**: Research assistants, Content analysts, Document processors
- **Interactive Characters**: Role-playing characters, Educational tutors, Entertainment bots

## Architecture

[![](/img/architecture.png)](/img/architecture.png)
Source: https://x.com/0xCygaar/status/1874575841763770492

The characterfile contains everything about the agent's personality, backstory, knowledge, and topics to talk about, as well as which clients / models / and plugins to load. The database is where an agent stores relevant info for generating responses, including previous tweets, interactions, and embeddings. Without a db, agent's wouldn't be able to give good responses.

Then we have the "runtime", which you can think of as the core agent logic. It's effectively the coordination layer of the agent or the brain, calling the necessary modules and external services to generate responses and take actions. Within the runtime is the LLM, which processes various inputs and generates responses or action items for the agent to take. Devs can declare which LLM provider to use in the characterfile. The runtime also handles the registration of plugins, which are called when a user input asks it take an action, such as transferring ETH on Abstract or doing a web search.

Eliza supports a variety of clients including `Discord`, `Twitter`, `Slack`, `Farcaster`, and others. The client is basically where the agent will live and interact with users. Agents can run on multiple clients at once. Clients can have modules to handle different interactions, such as responding to tweets, or even participating in Twitter spaces.

---

## Getting Started

For a more detailed guide, check out our [Quickstart Guide](./quickstart.md) to begin your journey with Eliza.

### Prerequisites

- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- Git for version control
- For Windows Users: [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) is required

### Multiple Paths to Start

Eliza offers different paths depending on your goals:

#### 1. Simple Start - Run Quickly

```bash
# Install globally (optional but recommended)
npm install -g @elizaos/cli

# Start with default settings
npx elizaos start
```

Visit https://localhost:3000 to interact with your agent through a web interface.

#### 2. Create Your Own Project

```bash
# Create a new project through interactive setup
npx elizaos create

# Navigate to your project directory
cd my-project-name

# Start your project
npx elizaos start
```

Add plugins to your project:

```bash
# List available plugins
npx elizaos project list-plugins

# Add a plugin
npx elizaos project add-plugin @elizaos/plugin-discord
```

#### 3. Develop a Custom Plugin

```bash
# Create a plugin project
npx elizaos create --type plugin

# Follow the interactive prompts
```

Develop and test your plugin:

```bash
# Test your plugin
npx elizaos start

# Publish your plugin when ready
npx elizaos plugin publish
```

#### 4. Contribute to ElizaOS Core

```bash
# Clone the repository
git clone git@github.com:elizaOS/eliza.git
cd eliza

# Install dependencies and build
bun install
bun build

# Start ElizaOS
bun start
```

Visit https://localhost:3000 to interact with your agent through a web interface.

For detailed instructions on each path, including configuration options and extended capabilities, see our [Quickstart Guide](./quickstart.md).

---

## Community and Support

Eliza is backed by an active community of developers and users:

- [**Open Source**](https://github.com/elizaos/eliza): Contribute to the project on GitHub
- [**Examples**](https://github.com/elizaos/characters): Ready-to-use character templates and implementations
- [**Support**](https://discord.gg/elizaos): Active community for troubleshooting and discussion

Join us in building the future of autonomous AI agents with Eliza!

## Next Steps

- [Quickstart Guide](./quickstart.md)
- [Understand Core Concepts](./core/agents.md)
- [Create Custom Characters](./core/characterfile.md)
