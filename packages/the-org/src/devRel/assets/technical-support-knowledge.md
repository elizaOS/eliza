# ElizaOS Technical Support Knowledge Base

## Common Issues and Solutions

### Database and Initialization Issues

#### Error: Database adapter not initialized

**Issue:** `Error details: Database adapter not initialized. The SQL plugin (@Elizaos/plugin-sql) is required for agent initialization.`

**Solution:**

1. Ensure SQL plugin is included in your character configuration
2. Try removing ElizaOS cache with `rm -rf ~/.eliza` and restart
3. When using `elizaos start` command, make sure you're in the project directory

#### BetterSQLite3 Compatibility Issues

**Issue:** `Better_sqlite3.node` module not found or errors with newer Node.js versions

**Solution:**

- Node.js v23.3+ has compatibility issues with BetterSQLite3
- Downgrade to Node.js v20.19.1 for better compatibility
- For WSL users, ensure you have the required dependencies installed

### Model and API Configuration Issues

#### No TEXT_EMBEDDING model registered

**Issue:** `[AgentRuntime][Eliza] No TEXT_EMBEDDING model registered. Skipping embedding dimension setup.`

**Solution:**

1. Ensure your `.env` file has the following correctly configured:
   ```
   OPENAI_EMBEDDING_MODEL=text-embedding-004
   OPENAI_LARGE_MODEL=model-name
   OPENAI_SMALL_MODEL=model-name
   OPENAI_API_KEY=sk-your-key
   OPENAI_BASE_URL=https://api.openai.com/v1 (or custom URL)
   ```
2. Anthropic plugin doesn't provide TEXT_EMBEDDING functionality, so include OpenAI plugin in your configuration
3. Plugin order matters - place OpenAI plugin after Anthropic to enable fallback for embedding functionality
4. For OpenRouter users, use an embedding model that OpenRouter supports
5. If you see this message on first startup, this is normal behavior as the system will download a local embedding model automatically. Just restart the server after the download completes.

#### Environment Variable Configuration

**Issue:** Agent not using updated API keys or environment variables

**Solution:**

1. Make sure you've properly updated your `.env` file in the project directory
2. Old configurations might be cached in `~/.eliza` - try removing with `rm -rf ~/.eliza`
3. Restart the ElizaOS server after updating environment variables
4. Verify API key validity and permissions in your OpenAI dashboard

### Integration and Deployment Issues

#### Twitter Plugin Issues

**Issue:** Error when stopping Twitter client or Twitter plugin not working

**Solution:**

1. Check Twitter API key configuration in your `.env` file
2. Some errors may be related to the model being used, not ElizaOS itself
3. For "Maximum call stack size exceeded" errors, this may indicate a memory issue

#### Deployment to Production

**Issue:** How to deploy ElizaOS on platforms like Railway or Vercel

**Solution:**

1. For Railway: Set up POSTGRES_KEY secret and environment variables
2. For database prompt during deployment, configure environment variables to bypass it
3. Consider using Railway or Render for deployment, as they better support Node.js applications with database requirements

#### Frontend Integration

**Issue:** How to integrate ElizaOS with custom frontend

**Solution:**

1. Use API endpoints from `packages/cli/src/server/api/agent.ts`
2. Example endpoint: `http://localhost:3000/api/agents/your-agent-id`
3. For production, host ElizaOS CLI on a separate backend endpoint

### Resource and Performance Issues

#### RAM Limits with Local Models

**Issue:** Hitting RAM limits when trying to run local models

**Solution:**

1. For Mac M2 with 8GB RAM, most large language models will struggle
2. Options:
   - Use quantized versions of models
   - Choose smaller models
   - Use cloud-based models through OpenRouter or similar services
   - Consider using a cloud server with more resources
3. Ensure you have sufficient free RAM before running local AI models as they require significant memory resources

#### PostgreSQL Pool Connection Timeout

**Issue:** "Connection timed out" errors when querying many agents simultaneously

**Solution:**

1. Optimize database queries
2. Check and improve database indexes
3. Increase connection timeout settings
4. Consider using connection pooling solutions like PgBouncer

## Getting Started with ElizaOS V2 (Beta)

### Correct Setup Process

Follow these exact steps to set up ElizaOS correctly:

```bash
# Step 1: Install the ElizaOS CLI globally
npm install -g @elizaos/cli@beta

# Step 2: Create a new project
npx elizaos create
# Follow the prompts to configure your project

# Step 3: Navigate to the created project directory
cd your-project-directory

# Step 4: Configure environment variables in the .env file
# Add your API keys (OpenAI, Anthropic, etc.)

# Step 5: Start the ElizaOS server
elizaos start
```

**Important Notes:**

- If you see embedding issues during first startup, this is normal. The system will download a local AI model. Simply restart after the download completes.
- For local AI models, ensure you have sufficient free RAM as these models are memory-intensive.
- If you don't want to use local models, make sure to set OpenAI or Anthropic API keys in your `.env` file.

### Environment Configuration

Essential environment variables:

```
OPENAI_EMBEDDING_MODEL=text-embedding-004
OPENAI_LARGE_MODEL=your-model
OPENAI_SMALL_MODEL=your-model
OPENAI_API_KEY=sk-your-key
OPENAI_BASE_URL=https://api.openai.com/v1
```

For OpenRouter:

```
OPENAI_LARGE_MODEL=tngtech/deepseek-r1t-chimera:free
OPENAI_SMALL_MODEL=tngtech/deepseek-r1t-chimera:free
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_EMBEDDING_MODEL=text-embedding-004
```

### System Requirements

- **RAM:** Minimum 8GB, 16GB+ recommended for local AI models
- **Disk Space:** At least 10GB free space for framework and models
- **Node.js:** v20.19.1 recommended (v23.3+ has compatibility issues)
- **Operating System:** Windows, macOS, or Linux
- **For WSL Users:** Ensure proper dependencies are installed

### Troubleshooting Steps

1. Verify API keys and permissions
2. Check environment variable configuration
3. Clear ElizaOS cache with `rm -rf ~/.eliza`
4. Check Node.js version compatibility
5. Verify plugin configurations in character definition
6. Check database connection settings
7. Review server logs for specific error messages

## Key Support Team Members

The following team members are active in providing technical support:

- sam-developer: API integration, environment configuration
- sayonara: Database and model configuration
- 0xbbjoker: Plugin configuration, OpenAI integration
- Odilitime: Core functionality, client integration
- shaw: Founder, advanced configuration
