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

- Node.js version 23+
- At least 4GB RAM
- For Windows users: WSL2 (Windows Subsystem for Linux)

### How do I fix common installation issues?

If you encounter build failures or dependency errors:

1.  **Check Your Node.js Version**: Ensure you are using Node.js v23 or higher.

    ```bash
    node --version
    ```

    If you have a different version, we recommend using [nvm](https://github.com/nvm-sh/nvm) (Node Version Manager) to switch to the correct version:

    ```bash
    nvm install 23
    nvm use 23
    ```

2.  **Clean your environment**: `bun clean`
3.  **Install dependencies**: `bun install --no-frozen-lockfile`
4.  **Rebuild**: `bun build`
5.  If issues persist, try checking out the latest release:
    ```bash
    git checkout $(git describe --tags --abbrev=0)
    ```

### How do I set up my API keys?

If you see an error related to a "Missing API Key" or "401 Unauthorized" when your agent tries to use an AI model, it means you haven't configured your environment correctly.

**Solution:**

1.  **Ensure `.env` File Exists**: Every project needs a `.env` file for secrets. If you don't have one, copy the template:

    ```bash
    cp .env.example .env
    ```

2.  **Add Your Key**: Open the `.env` file for editing and add your API key for the desired service (e.g., OpenAI or Anthropic).

    ```bash
    elizaos env edit-local
    ```

    Your file should contain a line like this:

    ```
    OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    ```

3.  **Restart the Agent**: After saving your changes, restart the agent for the new environment variables to take effect.
    ```bash
    elizaos start
    ```

For more details, see the [Environment Configuration Guide](./cli/env.md).

### How do I use local models with Eliza?

To use local models with Eliza:

1. Install [Ollama](https://ollama.ai) on your system
2. Download your desired model (e.g., `ollama pull llama3.1`)
3. Install the Ollama plugin: `bun install @elizaos-plugins/plugin-ollama`
4. Add the plugin to your character file:
   ```json
   {
     "plugins": ["@elizaos-plugins/plugin-ollama"]
   }
   ```
5. Configure the plugin in your `.env` file:
   ```
   OLLAMA_API_ENDPOINT=http://localhost:11434/api
   OLLAMA_SMALL_MODEL=llama3
   OLLAMA_MEDIUM_MODEL=your_medium_model
   OLLAMA_LARGE_MODEL=gemma3:latest
   OLLAMA_EMBEDDING_MODEL=nomic-embed-text
   ```

For more details, see the [plugin-ollama documentation](https://github.com/elizaos-plugins/plugin-ollama).

### How do I update Eliza to the latest version?

For CLI projects:

```bash
bun update -g @elizaos/cli
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

**⚠️ Breaking Change from v0.x to v1.x:** In ElizaOS v0.x, you could specify models directly in the character file using `modelProvider` and related fields. In v1.x, models are exclusively configured through plugins.

**Migration example:**

```json
// ❌ OLD (v0.x) - No longer works
{
  "modelProvider": "openai",
  "model": "gpt-4"
}

// ✅ NEW (v1.x) - Use plugins instead
{
  "plugins": ["@elizaos/plugin-openai"]
}
```

Models are now defined by the plugins chosen in your character file (`.ts` or `.json`). Add the desired model plugin to the `plugins` array:

```json
{
  "plugins": ["@elizaos/plugin-openai"]
}
```

**Important notes about plugin order:**

- Plugin order matters! The first plugin that supports a model type will be used
- Some plugins don't support all model types (e.g., Anthropic doesn't support embeddings)
- Use fallback plugins for missing capabilities:

```json
{
  "plugins": [
    "@elizaos/plugin-anthropic", // Primary for text generation
    "@elizaos/plugin-openai" // Fallback for embeddings
  ]
}
```

**Common plugin choices:**

- `@elizaos/plugin-openai`: Supports all model types (text, embeddings, objects)
- `@elizaos/plugin-anthropic`: Text generation only
- `@elizaos-plugins/plugin-ollama`: Local models via Ollama
- `@elizaos/plugin-google-genai`: Google's Gemini models

**Note:** The `modelProvider` field from v0.x is deprecated and will be ignored. Models are now configured exclusively through plugins.

### How do I manage API keys and secrets?

Two options:

1. **Global .env file** for shared settings:

   ```
   OPENAI_API_KEY=your-key-here
   ANTHROPIC_API_KEY=your-key-here
   ```

2. **Character-specific secrets** in character.json:
   ```json
   {
     "settings": {
       "secrets": {
         "OPENAI_API_KEY": "your-key-here"
       }
     }
   }
   ```

**Note:** API keys are required based on the plugins you use. For example:

- `@elizaos/plugin-openai` requires `OPENAI_API_KEY`
- `@elizaos/plugin-anthropic` requires `ANTHROPIC_API_KEY`
- `@elizaos-plugins/plugin-ollama` requires Ollama configuration (see local models section)

---

## Memory and Knowledge Management

### How does memory management work in ElizaOS?

ElizaOS uses RAG (Retrieval-Augmented Generation) to convert prompts into vector embeddings for efficient context retrieval and memory storage.

### How do I fix "Cannot generate embedding: Memory content is empty"?

Check your database for null memory entries and ensure proper content formatting when storing new memories.

### How do I manage my agent's memory?

- **To reset memory**:
  - For PGLite: Delete the `.eliza/.elizadb` folder and restart
  - For PostgreSQL: Drop and recreate the database (see "How do I clear or reset my agent's memory?" below)
- **To add documents**: Use the `@elizaos/plugin-knowledge` plugin and place documents in the `knowledge/` or `docs/` folder
- **For large datasets**: Use PostgreSQL instead of PGLite for better performance and scalability

### How do I clear or reset my agent's memory?

ElizaOS uses PGLite (local) or PostgreSQL (production) for data storage. There is currently no CLI command to clear memory, so you need to manually reset the database:

1. **For PGLite (local development)**:

   - Delete the `.elizadb` folder in your project
   - Default location: `.eliza/.elizadb`
   - Custom location: Check your `PGLITE_DATA_DIR` environment variable

   ```bash
   # Default location
   rm -rf .eliza/.elizadb

   # Or if you have a custom PGLITE_DATA_DIR
   rm -rf $PGLITE_DATA_DIR
   ```

2. **For PostgreSQL**:

   - Drop and recreate the entire database (easiest method):

   ```bash
   # Connect to PostgreSQL as superuser
   psql -U postgres

   # Drop the database (WARNING: This deletes ALL data!)
   DROP DATABASE your_database_name;

   # Create a fresh database
   CREATE DATABASE your_database_name;

   # Exit psql
   \q
   ```

   - Or selectively delete memories (advanced):

   ```sql
   -- Connect to your database
   psql -U your_username -d your_database_name

   -- Delete all memories (be careful!)
   DELETE FROM embeddings;  -- Delete embeddings first due to foreign keys
   DELETE FROM memories;    -- Then delete memories
   ```

**Note:** Be careful when deleting memories as this action cannot be undone. Always backup important data before resetting.

### How do I add custom knowledge or use RAG with my agent?

The easiest way is to use the **@elizaos/plugin-knowledge** plugin:

1. **Install the plugin and an LLM provider that supports embeddings:**

   ```bash
   bun install @elizaos/plugin-knowledge
   ```

2. **Add both plugins to your character file:**

   ```json
   {
     "plugins": [
       "@elizaos/plugin-sql",
       "@elizaos/plugin-openai", // or plugin-google-genai, plugin-ollama
       "@elizaos/plugin-knowledge"
     ]
   }
   ```

3. **Create a `docs` or `knowledge` folder in your project root and add documents:**

   ```
   your-project/
   ├── docs/           <-- or knowledge/
   │   ├── guide.pdf
   │   ├── manual.txt
   │   └── notes.md
   └── ... other files
   ```

4. **Enable auto-loading in your `.env`:**
   ```
   LOAD_DOCS_ON_STARTUP=true
   ```

**Supported embedding providers:**

- `@elizaos/plugin-openai` - OpenAI embeddings (text-embedding-3-small)
- `@elizaos-plugins/plugin-google-genai` - Google embeddings (text-embedding-004)
- `@elizaos-plugins/plugin-ollama` - Local embeddings (nomic-embed-text)

The plugin automatically uses embeddings from your configured LLM provider. For more details, see the [plugin-knowledge documentation](https://github.com/elizaOS/eliza/tree/main/packages/plugin-knowledge).

---

## Plugin Order and Dependencies

### Why does plugin order matter?

Plugin order is **critical** in ElizaOS because plugins are loaded sequentially and may depend on services provided by earlier plugins. The wrong order can cause initialization failures or missing functionality.

### What's the correct plugin order?

Here's the required loading order:

```json
{
  "plugins": [
    "@elizaos/plugin-sql", // 1. MUST BE FIRST - provides database
    "@elizaos/plugin-anthropic", // 2. Primary LLM provider
    "@elizaos/plugin-openai", // 3. Fallback for embeddings (if needed)
    "@elizaos/plugin-bootstrap" // 4. Core message handling
    // ... other plugins can go here in any order
  ]
}
```

### Plugin dependencies explained:

1. **Database Plugin (`@elizaos/plugin-sql`)** - **MUST ALWAYS BE FIRST**

   - Provides the database adapter that all other plugins use
   - Without this, plugins that store data will fail to initialize

2. **LLM Provider Plugins** - Must come after database, before plugins that need AI

   - Examples: `@elizaos/plugin-openai`, `@elizaos/plugin-anthropic`, `@elizaos/plugin-google-genai`
   - The first plugin that supports a model type (text, embedding, etc.) will be used
   - Order these by preference - put your primary provider first

3. **Fallback Providers** - For missing capabilities

   - Some LLM plugins don't support all model types (e.g., Anthropic doesn't support embeddings)
   - Add a fallback plugin that provides the missing capability:

   ```json
   {
     "plugins": [
       "@elizaos/plugin-sql",
       "@elizaos/plugin-anthropic", // Primary for text generation
       "@elizaos/plugin-openai" // Fallback for embeddings
     ]
   }
   ```

4. **Bootstrap Plugin (`@elizaos/plugin-bootstrap`)** - Highly recommended

   - Provides all core message handling, actions, and evaluators
   - Without this, your agent won't respond to messages or perform basic actions
   - While technically optional (you could implement your own message handling), it provides the standard ElizaOS behavior that most users expect

5. **Feature Plugins** - Can go in any order after dependencies
   - Platform integrations: `@elizaos/plugin-discord`, `@elizaos/plugin-telegram`
   - Additional capabilities: `@elizaos/plugin-knowledge`, `@elizaos/plugin-image-generation`
   - Custom plugins you've created

### Common plugin order mistakes:

```json
// ❌ WRONG - Knowledge plugin before its dependencies
{
  "plugins": [
    "@elizaos/plugin-knowledge",  // Needs database and embeddings!
    "@elizaos/plugin-sql",
    "@elizaos/plugin-openai"
  ]
}

// ✅ CORRECT - Dependencies first
{
  "plugins": [
    "@elizaos/plugin-sql",         // Database first
    "@elizaos/plugin-openai",      // Provides embeddings
    "@elizaos/plugin-knowledge"    // Can now use both
  ]
}
```

### How do I know which plugins provide what?

- **Database**: `@elizaos/plugin-sql`
- **Text Generation**: Most LLM plugins (`openai`, `anthropic`, `google-genai`, `ollama`)
- **Embeddings**: `@elizaos/plugin-openai`, `@elizaos/plugin-google-genai`, `@elizaos/plugin-ollama`
- **Image Generation**: `@elizaos/plugin-openai`, dedicated image plugins
- **Core Functionality**: `@elizaos/plugin-bootstrap`

### Can I skip the bootstrap plugin?

**The bootstrap plugin is mandatory for communication and basic agent functionality unless you're doing heavy customizations.**

The bootstrap plugin provides critical event handlers that enable your agent to:

- **Process incoming messages** - Without it, your agent won't respond to messages from Discord, Telegram, or other platforms
- **Handle communication events** - MESSAGE_RECEIVED, VOICE_MESSAGE_RECEIVED, and other essential events
- **Generate responses** - Core message processing pipeline and response generation
- **Manage basic actions** - reply, ignore, follow/unfollow rooms, mute/unmute
- **Process memory and context** - Essential evaluators and providers for agent cognition
- **Handle platform events** - World joins, entity management, and lifecycle events

**When you can skip it:**

- You're building a completely custom event handling system
- You're creating specialized agents that don't need standard communication
- You're implementing your own message processing pipeline from scratch

**For 99% of use cases, you should include `@elizaos/plugin-bootstrap` in your plugins array.** Without it, your agent will appear "deaf and mute" - unable to process messages or respond to users. Think of it as the essential nervous system that connects your agent's brain to the outside world.

You can disable it for testing with `IGNORE_BOOTSTRAP=true` environment variable, but this will break standard agent functionality.

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

**Basic approach:**

1. Use the CLI to scaffold a plugin: `elizaos create` (select Plugin)
2. Implement required interfaces (actions, providers, evaluators)
3. Publish with `elizaos plugins publish`

**Advanced local development with bun link:**

For testing plugins locally before publishing:

1. **Scaffold both a plugin and a test project:**

   ```bash
   # Create your plugin
   elizaos create my-plugin
   cd my-plugin

   # Create a test project
   cd ..
   elizaos create my-test-project
   ```

2. **Link your plugin locally using bun link:**

   ```bash
   # In your plugin directory
   cd my-plugin
   bun link

   # This creates a global link to your plugin
   ```

3. **Use the linked plugin in your project:**

   ```bash
   # In your project directory
   cd ../my-test-project
   bun link @your-namespace/my-plugin

   # This links the local plugin to your project
   ```

4. **Add the plugin to your character file:**

   ```json
   {
     "plugins": ["@your-namespace/my-plugin"]
   }
   ```

5. **Make changes and test immediately:**
   - Edit plugin code
   - Run `bun build` in the plugin directory
   - Changes are immediately available in your linked project
   - No need to publish/reinstall

**Benefits of bun link:**

- Test plugins locally without publishing
- Instant feedback during development
- No need to bump versions for each change
- Easy debugging with local source code

**To unlink when done:**

```bash
# In your project
bun unlink @your-namespace/my-plugin

# In your plugin directory
bun unlink
```

---

## Project Management and Updates

### How do I update ElizaOS after new releases?

When new versions of ElizaOS are released, follow these steps to update:

1. **Update the CLI globally:**

   ```bash
   bun update -g @elizaos/cli
   ```

2. **Update your project dependencies:**

   ```bash
   # From your project directory
   elizaos update
   ```

   This command updates all ElizaOS dependencies to their latest compatible versions.

3. **Rebuild your project:**
   ```bash
   # Always use dev after updates to ensure proper rebuild
   elizaos dev
   ```
   The `dev` command will automatically reinstall dependencies and rebuild if necessary.

### Best practices for project updates:

- **Always start with `elizaos dev`** after updates - it handles reinstallation and rebuilding automatically
- **Check release notes** for breaking changes before updating
- **Test in development** before updating production deployments
- **Backup your data** (especially if using PostgreSQL) before major updates

### How do I enable debug logging?

For troubleshooting, you can enable detailed logging in two ways:

1. **Environment variable (temporary):**

   ```bash
   LOG_LEVEL=debug elizaos start
   # or
   LOG_LEVEL=debug elizaos dev
   ```

2. **In your `.env` file (permanent):**
   ```env
   LOG_LEVEL=debug
   ```

Available log levels: `error`, `warn`, `info`, `debug`

### Troubleshooting project issues:

If you encounter issues after updates or during development:

1. **Clean rebuild (nuclear option):**

   ```bash
   # Remove all build artifacts and dependencies
   rm -rf node_modules && rm -rf dist && rm -rf bun.lock

   # Reinstall and rebuild everything
   elizaos dev
   ```

2. **Check your package.json:**

   - **Important**: Don't hardcode ElizaOS package versions in your `package.json`
   - Hardcoded versions will override the update process
   - Either use proper version ranges (e.g., `"^1.0.0"`) or remove version specifications before troubleshooting

   ```json
   // ❌ BAD - Hardcoded versions
   {
     "dependencies": {
       "@elizaos/core": "1.0.0",  // Will always install this exact version
       "@elizaos/plugin-bootstrap": "1.0.0"
     }
   }

   // ✅ GOOD - Version ranges
   {
     "dependencies": {
       "@elizaos/core": "latest",  // Will update to compatible versions
       "@elizaos/plugin-bootstrap": "latest"
     }
   }
   ```

3. **Common issues and solutions:**
   - **"Module not found"** - Run `elizaos dev` to reinstall dependencies
   - **Type errors** - Clean rebuild usually fixes this
   - **Plugin initialization failures** - Check [plugin order](#plugin-order-and-dependencies)
   - **Database errors** - May need to reset database after major updates

### Project scaffolding tips:

When creating new projects:

1. **Use the CLI scaffolding:**

   ```bash
   elizaos create my-project
   ```

2. **Don't modify core files** - Keep customizations in your character files and custom plugins

3. **Use version control:**

   ```bash
   git init
   git add .
   git commit -m "Initial ElizaOS project"
   ```

4. **Structure your project properly:**
   ```
   my-project/
   ├── .env                    # Environment variables (don't commit!)
   ├── .gitignore             # Should include .env, node_modules, dist
   ├── src/
   │   └── index.ts           # Your agent configuration
   ├── knowledge/             # Knowledge documents
   ├── custom-plugins/        # Your custom plugins
   └── package.json           # Project dependencies
   ```

---

## Production Deployment

### How do I ensure my agent runs continuously?

1. **Use PM2 process manager with Bun:**

   ```bash
   # Install PM2 globally with Bun
   bun install -g pm2

   # Start your agent with PM2
   pm2 start "elizaos start" --name eliza --interpreter bun

   # Save the process list for automatic restart
   pm2 save
   pm2 startup
   ```

2. **Alternative: Use PM2 with a configuration file:**
   Create `pm2.config.js`:

   ```javascript
   module.exports = {
     name: 'eliza-agent',
     script: 'elizaos',
     args: 'start',
     interpreter: 'bun',
     env: {
       PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
     },
   };
   ```

   Then start with:

   ```bash
   pm2 start pm2.config.js
   ```

3. **Set up monitoring and automatic restarts:**

   ```bash
   # Enable auto-restart on crash
   pm2 start "elizaos start" --name eliza --interpreter bun --watch --max-memory-restart 2G

   # View logs
   pm2 logs eliza

   # Monitor CPU and memory
   pm2 monit
   ```

**Note:** PM2 cluster mode is not supported when using Bun as the interpreter. Your agent will run in fork mode.

---

## Troubleshooting

### What do I do if the port is already in use?

By default, the ElizaOS web interface runs on port 3000. If you see an error like `EADDRINUSE: address already in use :::3000`, it means another application is already using that port.

**Solution:**

1.  **Stop the Other Application**: Identify and stop the other process that is using port 3000.

2.  **Run on a Different Port**: Alternatively, you can tell ElizaOS to use a different port with the `--port` flag.
    ```bash
    elizaos start --port 3001
    ```
    You can then access the web interface at `http://localhost:3001`.

### How do I fix database connection issues?

1.  **For PGLite (default local database)**:

    - Delete the `.elizadb` folder (or the path specified in `PGLITE_DATA_DIR`). The default location is `.eliza/.elizadb` in your project root.
    - Restart your agent to create a fresh database.

    ```bash
    rm -rf .eliza/.elizadb
    ```

2.  **For PostgreSQL**:
    - **Check Connection String**: Ensure your `DATABASE_URL` in the `.env` file is correct and accessible from your machine.
    - **Verify Database is Running**: Make sure your PostgreSQL server is running and you can connect to it with a standard client (like `psql` or DBeaver).
    - **Check Firewall Rules**: Ensure no firewall is blocking the connection between your machine and the database server.

### How do I resolve embedding dimension mismatch errors?

1. Set `OPENAI_EMBEDDING_DIMENSIONS=384` in .env
2. Reset your agent's memory:
   - **For PGLite**: Remove the `.elizadb` folder
     ```bash
     rm -rf .eliza/.elizadb
     ```
   - **For PostgreSQL**: Drop and recreate the database
     ```bash
     psql -U your_username -c "DROP DATABASE your_database_name;"
     psql -U your_username -c "CREATE DATABASE your_database_name;"
     ```
3. Ensure consistent embedding models across your setup

### Why does my agent post in JSON format sometimes?

This usually happens due to incorrect output formatting or template issues. Check your character file's templates and ensure the text formatting is correct without raw JSON objects.

---

## Character Configuration

### Can I still run custom character JSON files with the new CLI?

**Yes!** Custom character files are fully supported. The `--character` option works exactly as before:

```bash
# Single character file
elizaos start --character ./customcharacter.json

# Multiple character files
elizaos start --character ./character1.json ./character2.json

# Without .json extension (auto-added)
elizaos start --character mycharacter

# From URL
elizaos start --character https://example.com/mycharacter.json
```

### What's the character file format?

Your character JSON file should follow this structure:

```json
{
  "name": "MyCustomAgent",
  "username": "mycustomagent",
  "description": "A custom AI agent",
  "system": "You are a helpful assistant specialized in...",
  "bio": ["I am a custom AI assistant.", "I specialize in helping users with..."],
  "plugins": ["@elizaos/plugin-sql", "@elizaos/plugin-openai", "@elizaos/plugin-bootstrap"],
  "messageExamples": [
    [
      {
        "name": "user",
        "content": { "text": "Hello!" }
      },
      {
        "name": "MyCustomAgent",
        "content": { "text": "Hi there! How can I help you today?" }
      }
    ]
  ],
  "postExamples": [
    "Just thinking about how AI can help improve productivity...",
    "Excited to share some tips about effective communication!"
  ],
  "topics": ["technology", "productivity", "communication"],
  "adjectives": ["helpful", "knowledgeable", "friendly", "professional"],
  "knowledge": ["./knowledge/base-knowledge.txt"],
  "style": {
    "all": ["Be concise and clear", "Use examples when helpful"],
    "chat": ["Be conversational", "Ask clarifying questions"],
    "post": ["Be engaging", "Share insights"]
  },
  "settings": {
    "voice": {
      "model": "en_US-hfc_female-medium"
    }
  }
}
```

**Minimal character file:**

```json
{
  "name": "SimpleBot",
  "bio": "I am a helpful AI assistant.",
  "topics": ["general"],
  "adjectives": ["helpful"]
}
```

### Important notes about character files:

1. **Model configuration**: AI models are NOT configured in the character file anymore. In v0.x, you could specify models directly in the character file, but in v1.x models are exclusively configured through plugins. See the [Model Configuration](#how-do-i-switch-between-different-ai-models) section above.
2. **Backward compatibility**: Existing character files from older versions work, but you'll need to:
   - Remove any `modelProvider` or model-related settings from the character file
   - Add the appropriate plugin(s) to the `plugins` array (e.g., `@elizaos/plugin-openai`)
   - Configure API keys in your `.env` file or character `settings.secrets`
   - Pay attention to plugin order - some plugins depend on others
3. **Plugin specification**: You can specify plugins directly in the character file
4. **Multiple characters**: Run multiple characters simultaneously with space-separated paths

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
