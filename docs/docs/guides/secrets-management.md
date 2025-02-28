---
sidebar_position: 11
---

# 🔐 Secrets Management

A comprehensive guide for managing API keys, credentials, and other sensitive configuration in Eliza.

## Core Concepts

### Environment Variable Hierarchy

Eliza uses a hierarchical environment variable system that retrieves settings in this order:

1. Character-specific secrets (highest priority)
2. Character-specific settings 
3. Global environment variables
4. Default values (lowest priority)

This allows you to override global settings for specific characters when needed.

### Common Secret Types

```bash
# API Keys for Model Providers
OPENAI_API_KEY=sk-*               # OpenAI API key
ANTHROPIC_API_KEY=your-key        # Anthropic/Claude API key
GOOGLE_GENERATIVE_AI_API_KEY=     # Gemini API key
GROQ_API_KEY=gsk-*                # Groq API key

# Client Authentication
DISCORD_API_TOKEN=                # Discord bot token
TELEGRAM_BOT_TOKEN=               # Telegram bot token
TWITTER_USERNAME=                 # Twitter/X username
TWITTER_PASSWORD=                 # Twitter/X password

# Database Credentials
SUPABASE_URL=                     # Supabase URL
SUPABASE_ANON_KEY=                # Supabase anonymous key
MONGODB_CONNECTION_STRING=        # MongoDB connection string

# Blockchain Related
EVM_PRIVATE_KEY=                  # EVM private key with "0x" prefix
SOLANA_PRIVATE_KEY=               # Solana wallet private key
SOLANA_PUBLIC_KEY=                # Solana wallet public key
```

For a complete list of supported environment variables, see the [`.env.example`](https://github.com/elizaos/eliza/blob/main/.env.example) file in the project repository.

## Implementation

### Setting Up Environment Variables

1. Create a `.env` file in your project root directory:

   ```bash
   cp .env.example .env
   ```

2. Add your secrets to this file:

   ```bash
   # Model Provider
   OPENAI_API_KEY=sk-xxxxxxxxxxxxx
   
   # Clients
   DISCORD_API_TOKEN=xxxxxxxxxxxxxxxx
   ```

3. The `.env` file is automatically excluded from Git via `.gitignore` to prevent accidental exposure.

### Accessing Secrets in Code

Use the `runtime.getSetting()` method to access configuration values:

```typescript
// In a plugin, action, or service
const apiKey = runtime.getSetting("OPENAI_API_KEY");
if (!apiKey) {
  throw new Error("OpenAI API key not configured");
}

// With a fallback value
const temperature = runtime.getSetting("TEMPERATURE") || "0.7";
```

This method automatically handles the environment variable hierarchy, checking character-specific secrets first, then character settings, and finally global environment variables.

### Character-Specific Secrets

Define secrets for individual characters in their character file:

```json
{
    "name": "FinancialAssistant",
    "settings": {
        "secrets": {
            "OPENAI_API_KEY": "sk-character-specific-key",
            "ALPHA_VANTAGE_API_KEY": "financial-data-api-key"
        }
    }
}
```

Alternatively, use namespaced environment variables with this format:

```
CHARACTER.<CHARACTER_NAME>.<SECRET_NAME>=value
```

For example:
```
CHARACTER.TraderAgent.OPENAI_API_KEY=sk-character-specific-key
```

## Best Practices

### 1. Environment Segregation

Keep separate environment files for different deployment contexts:

```bash
.env.development    # Local development settings
.env.staging        # Testing environment
.env.production     # Production settings
```

Load the appropriate file based on your `NODE_ENV` or custom environment flag.

### 2. Secret Validation

Validate required secrets before using them:

```typescript
function validateRequiredSecrets(runtime) {
  const required = ["OPENAI_API_KEY", "DATABASE_URL"];
  
  const missing = required.filter(key => !runtime.getSetting(key));
  
  if (missing.length > 0) {
    throw new Error(`Missing required secrets: ${missing.join(", ")}`);
  }
}
```

### 3. Secure Error Handling

Avoid exposing secrets in error messages or logs:

```typescript
try {
  const apiKey = runtime.getSetting("API_KEY");
  // Use API key...
} catch (error) {
  // Log without exposing the secret
  console.error("Error using API:", error.message);
  // Don't log the actual API key!
}
```

### 4. API Key Validation

Validate API key formats before use:

```typescript
// OpenAI API key validation
const apiKey = runtime.getSetting("OPENAI_API_KEY");
if (apiKey && !apiKey.startsWith("sk-")) {
  throw new Error("Invalid OpenAI API key format");
}

// Mask before logging
const maskedKey = apiKey ? `${apiKey.substring(0, 5)}...` : "not set";
console.log("Using API key:", maskedKey);
```

## Security Considerations

### Private Key Handling

Take extra care with blockchain private keys:

```typescript
// Retrieve private key from settings
const privateKey = runtime.getSetting("WALLET_PRIVATE_KEY");

// Validate private key format (example for EVM)
if (privateKey && !privateKey.match(/^(0x)?[0-9a-fA-F]{64}$/)) {
  throw new Error("Invalid private key format");
}

// Use private key securely - NEVER log the actual key
console.log("Using wallet with address:", getAddressFromPrivateKey(privateKey));
```

### Secret Rotation

Implement periodic key rotation for production deployments:

1. Generate new API keys/credentials
2. Update environment variables or character secrets
3. Verify functionality with new credentials
4. Revoke old credentials

### Cloud Deployment Security

When deploying to cloud environments:

1. Use the platform's secrets management service:
   - AWS: Secrets Manager or Parameter Store
   - Google Cloud: Secret Manager
   - Azure: Key Vault
   - Vercel/Netlify: Environment Variables UI

2. Minimize secret access:
   - Restrict which services can access which secrets
   - Use short-lived credentials when possible
   - Configure proper IAM roles and permissions

## Troubleshooting

### Common Issues

#### 1. Missing Environment Variables

If settings aren't being found:

- Check that the `.env` file exists in the project root
- Verify variable names match exactly (they're case-sensitive)
- Ensure the file is properly formatted with no spaces around equals signs

#### 2. Character-Specific Secrets Not Working

If character-specific secrets aren't being applied:

- Verify the character name in your namespaced variable matches exactly
- Check JSON syntax in the character file's `settings.secrets` object
- Restart the application after changes to environment variables

#### 3. Environment File Not Loading

If your entire `.env` file isn't being loaded:

```typescript
// Add this near the start of your application
import dotenv from 'dotenv';
dotenv.config({ path: '.env.development' }); // Specify exact path if needed
```

## Related Resources

- [Configuration Guide](/docs/guides/configuration) - General application configuration
- [Character Files](/docs/core/characterfile) - Character-specific configuration
- [Local Development](/docs/guides/local-development) - Development environment setup
- [Deployment Guide](/docs/guides/remote-deployment) - Secure production deployment
