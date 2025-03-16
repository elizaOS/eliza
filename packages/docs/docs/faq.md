# Frequently Asked Questions

## General

### What is ElizaOS?

ElizaOS is an open-source framework for creating AI agents that can interact across multiple platforms through a consistent, extensible architecture. It features a modular design with plugin-based capabilities, entity-component architecture, vector-based memory, and cross-platform integration.

### What's the difference between v1 and v2?

**Note**: For developers currently using v1, it's recommended to continue with v1 until v2 is fully stable. V2 is designed to be mostly backwards compatible.

**What's New in V2:**

1. **Improved Architecture**

   - Modular package registry system
   - CLI tool for project and plugin management
   - Better organized codebase structure

2. **Enhanced Communication**

   - Cross-platform message routing
   - Better support for autonomous agent actions
   - More consistent interaction models

3. **Advanced Entity-Component System**

   - Flexible data modeling for agents and users
   - Dynamic composition of objects without complex inheritance
   - Better relationship tracking between entities

4. **Memory and Knowledge Improvements**

   - Semantic retrieval of conversations and knowledge
   - More efficient vector-based memory organization
   - Better integration of knowledge across contexts

5. **Worlds and Rooms**
   - Structured container model for organizing interactions
   - More consistent participant management
   - Cross-platform space mapping

---

## Installation and Setup

### What are the system requirements for running ElizaOS?

- Node.js version 23+ (version 23.3.0 is recommended)
- pnpm package manager (for development) or npx (for using CLI tools)
- At least 2GB RAM
- Windows users: WSL2 (Windows Subsystem for Linux) is recommended

### How do I get started with ElizaOS?

1. Use the CLI create command to scaffold a new project:
   ```bash
   npx @elizaos/cli create
   ```
2. Follow the interactive prompts to set up your project
3. Navigate to your project directory and start the agent:
   ```bash
   cd my-project
   npx @elizaos/cli start
   ```

### How do I fix common installation issues?

If you encounter build failures or dependency errors:

1. Ensure you're using Node.js v23.3.0: `nvm install 23.3.0 && nvm use 23.3.0`
2. Try creating a fresh project using `npx @elizaos/cli create`
3. Verify your database connection settings
4. Check the logs for specific error messages
5. Join the Discord community for support

### How do I use local models with ElizaOS?

Use **Ollama** for local models:

1. Install Ollama on your system
2. Download your preferred model (e.g., `ollama pull llama3.1`)
3. Set the model configuration in your project:
   ```json
   {
     "modelProvider": "ollama",
     "settings": {
       "OLLAMA_BASE_URL": "http://localhost:11434"
     }
   }
   ```

### How do I update my ElizaOS project?

1. Update the CLI: `npm install -g @elizaos/cli@latest`
2. Update dependencies in your project:
   ```bash
   cd my-project
   npm update @elizaos/core @elizaos/cli
   ```

---

## Running Agents

### How do I run my agent in production?

Use the `start` command for production:

```bash
npx @elizaos/cli start
```

This command will:

1. Load your project configuration
2. Initialize the database
3. Load all plugins
4. Start the HTTP API server
5. Begin processing messages and events

### How do I run my agent in development mode?

Use the `dev` command during development:

```bash
npx @elizaos/cli dev
```

This provides hot reloading and more verbose logging.

### How do I run multiple agents simultaneously?

1. Create separate project directories for each agent
2. Run each project on a different port:

   ```bash
   cd agent1-project
   npx @elizaos/cli start --port 3000

   # In another terminal
   cd agent2-project
   npx @elizaos/cli start --port 3001
   ```

3. For production, consider using separate Docker containers or PM2 instances

### Can I test a specific character configuration?

Yes, use the `--character` flag with the `start` command:

```bash
npx @elizaos/cli start --character path/to/character.json
```

---

## Platform Integration

### How do I connect my agent to Discord?

1. Install the Discord plugin:
   ```bash
   npm install @elizaos/plugin-discord
   ```
2. Add the plugin to your project configuration
3. Configure your Discord credentials in the environment or settings
4. Start your agent with `npx @elizaos/cli start`

### How do I control platform-specific behaviors?

Each platform plugin has its own configuration options. For example, to control Discord interactions:

```json
{
  "plugins": ["@elizaos/plugin-discord"],
  "settings": {
    "DISCORD_TOKEN": "your-token",
    "DISCORD_MENTIONS_ONLY": true,
    "DISCORD_CHANNELS": "general,bot-chat"
  }
}
```

### How do I connect to multiple platforms at once?

Add multiple platform plugins to your project:

```json
{
  "plugins": ["@elizaos/plugin-discord", "@elizaos/plugin-telegram"]
}
```

Each plugin will handle connections to its respective platform.

---

## Memory and Knowledge Management

### How does memory management work in ElizaOS?

ElizaOS uses a vector-based memory system with different types:

- Messages: Conversations stored with embeddings for semantic search
- Facts: Extracted knowledge from conversations
- Documents: External knowledge processed into fragments

Memory is retrieved contextually based on relevance to current conversations.

### How do I add external knowledge to my agent?

1. Add knowledge files to your project's `knowledge` directory
2. Ensure your project configuration includes these paths:
   ```json
   {
     "knowledge": ["./knowledge/documents", { "path": "./knowledge/private", "shared": false }]
   }
   ```
3. Start your agent, which will process and embed this knowledge

### How do I clear or reset my agent's memory?

1. For PGLite: Delete the db.sqlite file in your project directory
2. For PostgreSQL: Use database tools to clear specific tables
3. Restart your agent with `npx @elizaos/cli start`

### How much does it cost to run an agent?

Costs vary based on:

- Model provider (OpenAI, Anthropic, etc.) and usage
- Server hosting ($5-20/month depending on provider)
- Database hosting (if using external PostgreSQL)
- Platform API costs (if using premium features)

Using local models can significantly reduce costs.

---

## Plugins and Extensions

### How do I create a new plugin?

Use the CLI create command with the plugin type:

```bash
npx @elizaos/cli create --type plugin
```

This will scaffold a plugin project with the necessary structure.

### How do I add plugins to my project?

1. Install the plugin: `npm install @elizaos/plugin-name`
2. Add it to your project configuration:
   ```json
   {
     "plugins": ["@elizaos/plugin-name"]
   }
   ```
3. Configure any plugin-specific settings
4. Restart your agent

### How do I publish my plugin?

Use the plugins publish command:

```bash
npx @elizaos/cli plugin publish
```

This validates your plugin and publishes it to the registry.

---

## Worlds and Rooms

### What are worlds and rooms in ElizaOS?

- **Worlds** are containers for entities and rooms, similar to Discord servers or Slack workspaces
- **Rooms** are interaction spaces within worlds, like channels or direct messages
- Entities (users and agents) participate in rooms and can belong to worlds

### How do I create a world programmatically?

```typescript
const worldId = await runtime.createWorld({
  name: 'My Project Space',
  agentId: runtime.agentId,
  serverId: 'external-system-id',
});
```

### How do I manage rooms in a world?

```typescript
// Create a room in a world
const roomId = await runtime.createRoom({
  name: 'general-chat',
  source: 'discord',
  type: ChannelType.GROUP,
  worldId: parentWorldId,
});

// Add participants to a room
await runtime.addParticipant(entityId, roomId);
```

---

## Troubleshooting

### How do I debug when my agent isn't responding?

1. Check the console logs for error messages
2. Verify your database connection is working
3. Ensure model API keys are valid
4. Check platform-specific configurations
5. Try running with `--configure` to reset configurations:
   ```bash
   npx @elizaos/cli start --configure
   ```

### How do I resolve database connection issues?

1. For PGLite:
   - Check file permissions
   - Try deleting and recreating the database
2. For PostgreSQL:
   - Verify connection string
   - Check database exists and is accessible
   - Ensure proper credentials

### Why am I seeing model API errors?

Common causes:

1. Invalid or expired API key
2. Rate limiting or quota exceeded
3. Incompatible model parameters
4. Network connectivity issues

Try setting `--configure` to update your model settings:

```bash
npx @elizaos/cli start --configure
```

### How do I fix "Cannot generate embedding" errors?

1. Check that your model provider supports embeddings
2. Verify API keys for the embedding model
3. Ensure content being embedded is not empty or malformed
4. For consistency, use the same embedding model throughout your project

---

## Contributing

### How can I contribute to ElizaOS?

ElizaOS welcomes contributions from individuals with various skills:

#### Technical Contributions

- **Core Framework Development**: Improve the ElizaOS architecture
- **Plugin Development**: Create new plugins for platforms or capabilities
- **Documentation**: Enhance tutorials, examples, and reference docs
- **Testing**: Write tests and identify issues

#### Non-Technical Contributions

- **Community Support**: Help other users in Discord or forums
- **Content Creation**: Create tutorials, videos, or blog posts
- **Feedback**: Report bugs and suggest improvements
- **Use Cases**: Share how you're using ElizaOS

To get started, visit the GitHub repository: https://github.com/elizaOS/eliza
