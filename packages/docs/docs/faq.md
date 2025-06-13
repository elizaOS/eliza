---
sidebar_position: 3
title: Frequently Asked Questions
description: Common questions and answers about installing, configuring, and using ElizaOS
keywords: [FAQ, troubleshooting, installation, setup, Discord, models, memory]
---

# Frequently Asked Questions

### What is Eliza?

Eliza is an extensible open-source framework for building autonomous AI agents that can engage in natural conversations, learn from interactions, and maintain consistent personalities across platforms like Farcaster, X, Discord, and Telegram.

### What's the difference between v1 and v2?

V2 is a major upgrade that makes Eliza more powerful and easier to use. The main changes are:

- Plugin store for easy extensions
- Unified messaging across platforms
- One wallet for all blockchains
- Smarter, learning characters
- Better planning capabilities

For a detailed comparison, see our [V2 announcement blog post](/blog/v1-v2).

---

## Installation and Setup

### What are the system requirements for running Eliza?

- Node.js version 23+ (specifically 23.3.0 is recommended)
- At least 4GB RAM
- For Windows users: WSL2 (Windows Subsystem for Linux)

### How do I fix common installation issues?

If you encounter build failures or dependency errors:

1. Ensure you're using Node.js v23.3.0: `nvm install 23.3.0 && nvm use 23.3.0`
2. Clean your environment: `bun clean`
3. Install dependencies: `bun install --no-frozen-lockfile`
4. Rebuild: `bun build`
5. If issues persist, try checking out the latest release:
   ```bash
   git checkout $(git describe --tags --abbrev=0)
   ```

### How do I use local models with Eliza?

Use **Ollama** for local models. Install Ollama, download the desired model (e.g., `llama3.1`), set `modelProvider` to `"ollama"` in the character file, and configure `OLLAMA` settings in `.env`.

### How do I update Eliza to the latest version?

For CLI projects:

```bash
npm update -g @elizaos/cli
```

For monorepo development:

```bash
git pull
bun clean
bun install --no-frozen-lockfile
bun build
```

---

## Running Multiple Agents

```bash
elizaos start --characters="characters/agent1.json,characters/agent2.json"
```

2. Create separate projects for each agent with their own configurations
3. For production, use separate Docker containers for each agent

### Can I run multiple agents on one machine?

Yes, but consider:

- Each agent needs its own port configuration
- Separate the .env files or use character-specific secrets
- Monitor memory usage (2-4GB RAM per agent recommended)

---

## Model Configuration

### How do I switch between different AI models?

In your character.json file:

```json
{
  "modelProvider": "openai", // or "anthropic", "deepseek", etc.
  "settings": {
    "model": "gpt-4",
    "maxInputTokens": 200000,
    "maxOutputTokens": 8192
  }
}
```

### How do I manage API keys and secrets?

Two options:

1. Global .env file for shared settings
2. Character-specific secrets in character.json:
   ```json
   {
     "settings": {
       "secrets": {
         "OPENAI_API_KEY": "your-key-here"
       }
     }
   }
   ```

---

## Memory and Knowledge Management

### How does memory management work in ElizaOS?

ElizaOS uses RAG (Retrieval-Augmented Generation) to convert prompts into vector embeddings for efficient context retrieval and memory storage.

### How do I fix "Cannot generate embedding: Memory content is empty"?

Check your database for null memory entries and ensure proper content formatting when storing new memories.

### How do I manage my agent's memory?

- To reset memory: Delete the db.sqlite file and restart
- To add documents: Specify path to file / folder in the characterfile
- For large datasets: Consider using a vector database

### How do I clear or reset my agent's memory?

Using the CLI:

```bash
elizaos agent reset-memory
```

Or manually:

1. Delete the db.sqlite file in the agent/data directory
2. Restart your agent

### How do I add custom knowledge or use RAG with my agent?

1. Convert documents to txt/md format
2. Use the [folder2knowledge](https://github.com/elizaOS/characterfile/tree/main/scripts) tool
3. Add to the knowledge section in your character file, [see docs](docs/core/knowledge.md) via `"ragKnowledge": true`

---

## Plugins and Extensions

### How do I add plugins to my agent?

Using the CLI:

```bash
elizaos project add-plugin @elizaos/plugin-name
```

Or manually:

1. Add the plugin to your character.json:
   ```json
   {
     "plugins": ["@elizaos/plugin-name"]
   }
   ```
2. Install the plugin: `bun install @elizaos/plugin-name`
3. Rebuild: `bun build`
4. Configure any required plugin settings in .env or character file

### How do I create custom plugins?

1. Use the CLI to scaffold a plugin:
2. Implement required interfaces (actions, providers, evaluators)
3. Publish with `elizaos plugins publish`

---

## Production Deployment

### How do I ensure my agent runs continuously?

1. Use a process manager like PM2:
   ```bash
   npm install -g pm2
   pm2 start "elizaos start" --name eliza
   pm2 save
   ```
2. Set up monitoring and automatic restarts
3. Use proper error handling and logging

---

## Troubleshooting

### How do I fix database connection issues?

1. For SQLite:
   - Delete db.sqlite and restart
   - Check file permissions
2. For PostgreSQL:
   - Verify connection string
   - Check database exists
   - Ensure proper credentials

### How do I resolve embedding dimension mismatch errors?

1. Set `USE_OPENAI_EMBEDDING=true` in .env
2. Reset your agent's memory with `elizaos agent reset-memory`
3. Ensure consistent embedding models across your setup

### Why does my agent post in JSON format sometimes?

This usually happens due to incorrect output formatting or template issues. Check your character file's templates and ensure the text formatting is correct without raw JSON objects.

### How do I make my agent only respond to mentions?

Add a mention filter to your character's configuration and set `ENABLE_ACTION_PROCESSING=false` in your .env file.

---

## How can I contribute?

Eliza welcomes contributions from individuals with a wide range of skills:

- **Participate in community discussions**: Share your insights, propose new ideas, and engage with other community members
- **Contribute to the development**: https://github.com/elizaOS/eliza
- **Extend the ecosystem**: Create plugins, clients, and tools

#### Technical Contributions

- **Develop new plugins**: Create new functionality using the plugin system
- **Improve the core**: Enhance the ElizaOS core functionality
- **Fine-tune models**: Optimize models for specific personalities and use cases

#### Non-Technical Contributions

- **Community Management**: Onboard new members, organize events, and foster a welcoming community
- **Content Creation**: Create tutorials, documentation, and videos
- **Translation**: Help make ElizaOS accessible to a global audience
- **Domain Expertise**: Provide insights for specific applications of ElizaOS
