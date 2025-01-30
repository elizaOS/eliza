---
sidebar_position: 9
---

# ⚙️ Configuration Guide

This guide covers how to configure Eliza for different use cases and environments. We'll walk through all available configuration options and best practices.

## Environment Configuration

### Basic Setup

The first step is creating your environment configuration file:

```bash
cp .env.example .env
```

### Core Environment Variables

Here are the essential environment variables you need to configure:

```bash
# Core API Keys
OPENAI_API_KEY=sk-your-key # Required for OpenAI features
ANTHROPIC_API_KEY=your-key  # Required for Claude models
TOGETHER_API_KEY=your-key   # Required for Together.ai models
```

### Client-Specific Configuration

#### Discord Configuration

```bash
DISCORD_APPLICATION_ID=     # Your Discord app ID
DISCORD_API_TOKEN=         # Discord bot token
```

#### Twitter Configuration

```bash
TWITTER_USERNAME=          # Bot Twitter username
TWITTER_PASSWORD=          # Bot Twitter password
TWITTER_EMAIL=            # Twitter account email
TWITTER_DRY_RUN=false    # Test mode without posting
```

#### Telegram Configuration

```bash
TELEGRAM_BOT_TOKEN=       # Telegram bot token
```

### Model Provider Settings

You can configure different AI model providers:

```bash
# OpenAI Settings
OPENAI_API_KEY=sk-*

# Anthropic Settings
ANTHROPIC_API_KEY=

# Together.ai Settings
TOGETHER_API_KEY=

# Heurist Settings
HEURIST_API_KEY=

# Livepeer Settings
LIVEPEER_GATEWAY_URL=
```

### Cloudflare AI Gateway Integration

Eliza supports routing API calls through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/), which provides several benefits:

- Detailed analytics and monitoring of message traffic and response times
- Cost optimization through request caching and usage tracking across providers
- Improved latency through Cloudflare's global network
- Comprehensive visibility into message content and token usage
- Cost analysis and comparison between different AI providers
- Usage patterns and trends visualization
- Request/response logging for debugging and optimization

To enable Cloudflare AI Gateway:

```bash
# Cloudflare AI Gateway Settings
CLOUDFLARE_GW_ENABLED=true
CLOUDFLARE_AI_ACCOUNT_ID=your-account-id
CLOUDFLARE_AI_GATEWAY_ID=your-gateway-id
```

Supported providers through Cloudflare AI Gateway:
- OpenAI
- Anthropic
- Groq

When enabled, Eliza will automatically route requests through your Cloudflare AI Gateway endpoint. The gateway URL is constructed in the format:
```
https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${provider}
```

If the gateway configuration is incomplete or disabled, Eliza will fall back to direct API calls.

```bash
# Cloudflare AI Gateway Settings
CLOUDFLARE_GW_ENABLED=true
CLOUDFLARE_AI_ACCOUNT_ID=your-account-id
CLOUDFLARE_AI_GATEWAY_ID=your-gateway-id
```

Supported providers through Cloudflare AI Gateway:
- OpenAI
- Anthropic
- Groq

When enabled, Eliza will automatically route requests through your Cloudflare AI Gateway endpoint. The gateway URL is constructed in the format:
```
https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${provider}
```

If the gateway configuration is incomplete or disabled, Eliza will fall back to direct API calls.

### Image Generation

Configure image generation in your character file:

```json
{
    "modelProvider": "heurist",
    "settings": {
        "imageSettings": {
            "steps": 20,
            "width": 1024,
            "height": 1024
        }
    }
}
```

Example usage:

```typescript
const result = await generateImage(
    {
        prompt: 'A cute anime girl with big breasts and straight long black hair wearing orange T-shirt. The T-shirt has "ai16z" texts in the front. The girl is looking at the viewer',
        width: 1024,
        height: 1024,
        numIterations: 20, // optional
        guidanceScale: 3, // optional
        seed: -1, // optional
        modelId: "FLUX.1-dev", // optional
    },
    runtime,
);
```

## Character Configuration

### Character File Structure

Character files define your agent's personality and behavior. Create them in the `characters/` directory:

```json
{
    "name": "AgentName",
    "clients": ["discord", "twitter"],
    "modelProvider": "openai",
    "settings": {
        "secrets": {
            "OPENAI_API_KEY": "character-specific-key",
            "DISCORD_TOKEN": "bot-specific-token"
        }
    }
}
```

### Loading Characters

You can load characters in several ways:

```bash
# Load default character
pnpm start

# Load specific character
pnpm start --characters="characters/your-character.json"

# Load multiple characters
pnpm start --characters="characters/char1.json,characters/char2.json"
```

### Secrets for Multiple Characters

If you don't want to have secrets in your character files because you would
like to utilize source control for collaborative development on multiple
characters, then you can put all character secrets in `.env` by prepending
`CHARACTER.NAME.` before the key name and value. For example:

```bash
# C3PO
CHARACTER.C3PO.DISCORD_APPLICATION_ID=abc
CHARACTER.C3PO.DISCORD_API_TOKEN=xyz

# DOBBY
CHARACTER.DOBBY.DISCORD_APPLICATION_ID=123
CHARACTER.DOBBY.DISCORD_API_TOKEN=369

```

## Custom Actions

### Adding Custom Actions

1. Create a `custom_actions` directory
2. Add your action files there
3. Configure in `elizaConfig.yaml`:

```yaml
actions:
    - name: myCustomAction
      path: ./custom_actions/myAction.ts
```

### Action Configuration Structure

```typescript
export const myAction: Action = {
    name: "MY_ACTION",
    similes: ["SIMILAR_ACTION", "ALTERNATE_NAME"],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        // Validation logic
        return true;
    },
    description: "Action description",
    handler: async (runtime: IAgentRuntime, message: Memory) => {
        // Action logic
        return true;
    },
};
```

## Provider Configuration

### Database Providers

Configure different database backends:

```typescript
// SQLite (Recommended for development)
import { SqliteDatabaseAdapter } from "@your-org/agent-framework/adapters";
const db = new SqliteDatabaseAdapter("./dev.db");

// PostgreSQL (Production)
import { PostgresDatabaseAdapter } from "@your-org/agent-framework/adapters";
const db = new PostgresDatabaseAdapter({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});
```

### Model Providers

Configure model providers in your character file:

```json
{
    "modelProvider": "openai",
    "settings": {
        "model": "gpt-4o-mini",
        "temperature": 0.7,
        "maxTokens": 2000
    }
}
```

## Advanced Configuration

### Runtime Settings

Fine-tune runtime behavior:

```typescript
const settings = {
    // Logging
    DEBUG: "eliza:*",
    LOG_LEVEL: "info",

    // Performance
    MAX_CONCURRENT_REQUESTS: 5,
    REQUEST_TIMEOUT: 30000,

    // Memory
    MEMORY_TTL: 3600,
    MAX_MEMORY_ITEMS: 1000,
};
```

### Plugin Configuration

Enable and configure plugins in `elizaConfig.yaml`:

```yaml
plugins:
    - name: solana
      enabled: true
      settings:
          network: mainnet-beta
          endpoint: https://api.mainnet-beta.solana.com

    - name: image-generation
      enabled: true
      settings:
          provider: dalle
          size: 1024x1024
```

## Configuration Best Practices

1. **Environment Segregation**

    - Use different `.env` files for different environments
    - Follow naming convention: `.env.development`, `.env.staging`, `.env.production`

2. **Secret Management**

    - Never commit secrets to version control
    - Use secret management services in production
    - Rotate API keys regularly

3. **Character Configuration**

    - Keep character files modular and focused
    - Use inheritance for shared traits
    - Document character behaviors

4. **Plugin Management**

    - Enable only needed plugins
    - Configure plugin-specific settings in separate files
    - Monitor plugin performance

5. **Database Configuration**
    - Use SQLite for development
    - Configure connection pooling for production
    - Set up proper indexes

## Troubleshooting

### Common Issues

1. **Environment Variables Not Loading**

    ```bash
    # Check .env file location
    node -e "console.log(require('path').resolve('.env'))"

    # Verify environment variables
    node -e "console.log(process.env)"
    ```

2. **Character Loading Failures**

    ```bash
    # Validate character file
    npx ajv validate -s character-schema.json -d your-character.json
    ```

3. **Database Connection Issues**
    ```bash
    # Test database connection
    npx ts-node scripts/test-db-connection.ts
    ```

### Configuration Validation

Use the built-in config validator:

```bash
pnpm run validate-config
```

This will check:

- Environment variables
- Character files
- Database configuration
- Plugin settings

## Further Resources

- [Quickstart Guide](../quickstart.md) for initial setup
- [Secrets Management](./secrets-management.md) for secure configuration
- [Local Development](./local-development.md) for development setup
- [Advanced Usage](./advanced.md) for complex configurations
