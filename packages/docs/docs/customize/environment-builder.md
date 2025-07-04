---
displayed_sidebar: customizeSidebar
---

# Environment Configuration Guide

Set up your ElizaOS environment variables and API credentials using the interactive CLI tools. This guide covers all configuration options for model providers, platforms, and databases.

## 🎯 What Is Environment Configuration?

Environment configuration manages your API keys, platform credentials, and system settings through `.env` files. ElizaOS provides interactive CLI tools to help you set up and validate your configuration.

### Configuration Tools

- 🔐 **Interactive Setup** - Step-by-step configuration wizard
- 📋 **Environment Management** - List, edit, and reset variables
- ✅ **Validation** - Check that your credentials work
- 🔄 **Hot Reloading** - Changes apply without restart
- 📁 **Multi-Agent Support** - Namespaced variables for multiple agents
- 🛡️ **Secure Storage** - Never commit `.env` files to git

## 🚀 Quick Start Guide

### Step 1: Run Interactive Setup

```bash
# Launch the interactive configuration wizard
elizaos env interactive

# This will guide you through:
# 1. Model provider setup (OpenAI, Anthropic, etc.)
# 2. Platform credentials (Discord, Telegram)
# 3. Database configuration
# 4. Optional services
```

### Step 2: Environment Commands

```bash
# List all environment variables
elizaos env list

# Edit your local .env file
elizaos env edit-local

# Reset to default configuration
elizaos env reset

# Validate your configuration
elizaos env validate
```

### Step 3: Manual Configuration

Create a `.env` file in your project root:

```bash
# Copy the example file
cp .env.example .env

# Edit with your credentials
nano .env
```

## 🤖 Model Provider Configuration

### OpenAI

```bash
# Required: Your OpenAI API key
OPENAI_API_KEY=sk-proj-...

# Optional: Custom model selection
OPENAI_MODEL=gpt-4o-mini  # Default: gpt-4o-mini

# Optional: Custom API endpoint (for proxies/local models)
OPENAI_BASE_URL=https://api.openai.com/v1
```

### Anthropic

```bash
# Required: Your Anthropic API key
ANTHROPIC_API_KEY=sk-ant-api03-...

# Optional: Model selection
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022  # Default

# Optional: Custom endpoint
ANTHROPIC_BASE_URL=https://api.anthropic.com
```

### Google AI

```bash
# Required: Google Generative AI API key
GOOGLE_GENERATIVE_AI_API_KEY=AIza...

# Optional: Model selection
GOOGLE_MODEL=gemini-1.5-pro
```

### Ollama (Local Models)

```bash
# Required: Ollama API endpoint
OLLAMA_API_ENDPOINT=http://localhost:11434

# Required: Model name
OLLAMA_MODEL=llama3.1

# Optional: Custom configuration
OLLAMA_TEMPERATURE=0.7
```

### Model Provider Priority

ElizaOS selects model providers in this order:
1. Character-specific `modelProvider` setting
2. Environment variable presence (first found):
   - `OPENAI_API_KEY` → OpenAI
   - `ANTHROPIC_API_KEY` → Anthropic
   - `GOOGLE_GENERATIVE_AI_API_KEY` → Google
   - `OLLAMA_API_ENDPOINT` → Ollama

## 📱 Platform Configuration

### Discord

```bash
# Required: Bot token from Discord Developer Portal
DISCORD_API_TOKEN=MTI3NjM0...

# Required: Application ID
DISCORD_APPLICATION_ID=1276341234567890

# Optional: Specific guild/server ID
DISCORD_GUILD_ID=1234567890

# Optional: Bot behavior
DISCORD_VOICE_ENABLED=false
```

**Setup Steps:**
1. Create application at https://discord.com/developers/applications
2. Create bot user and copy token
3. Generate invite URL with required permissions
4. Add bot to your server

### Telegram

```bash
# Required: Bot token from BotFather
TELEGRAM_BOT_TOKEN=7234567890:ABCdefGHIjklMNOpqrsTUVwxyz

# Optional: Admin user IDs (comma-separated)
TELEGRAM_ADMIN_IDS=123456789,987654321

# Optional: Webhook configuration (for production)
TELEGRAM_WEBHOOK_URL=https://yourdomain.com/telegram/webhook
```

**Setup Steps:**
1. Message @BotFather on Telegram
2. Create new bot with `/newbot`
3. Copy the provided token
4. Configure bot settings with BotFather

### Twitter (Deprecated)

```bash
# Note: Twitter integration is deprecated
# Consider using alternative platforms
TWITTER_USERNAME=your_username
TWITTER_PASSWORD=your_password
TWITTER_EMAIL=your_email@example.com
```

## 🗄️ Database Configuration

### PostgreSQL (Production)

```bash
# Full connection string
POSTGRES_URL=postgresql://user:password@localhost:5432/elizaos

# Or individual components
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=elizauser
POSTGRES_PASSWORD=secretpassword
POSTGRES_DATABASE=elizaos

# Optional: SSL configuration
POSTGRES_SSL=true
```

### PGLite (Development)

```bash
# Local file-based database (default)
PGLITE_DATA_DIR=./data/pglite

# Memory-only database (testing)
PGLITE_MEMORY=true
```

### Database Selection

ElizaOS automatically selects:
- PostgreSQL if `POSTGRES_URL` is set
- PGLite otherwise (default for development)

## 🔧 Advanced Configuration

### Multi-Agent Setup

Run multiple agents with different configurations:

```bash
# Default agent
OPENAI_API_KEY=sk-default...
DISCORD_API_TOKEN=default-token...

# Customer service agent
CUSTOMER_SERVICE_OPENAI_API_KEY=sk-customer...
CUSTOMER_SERVICE_DISCORD_API_TOKEN=customer-token...
CUSTOMER_SERVICE_CHARACTER=./characters/customer-service.json

# Community manager agent  
COMMUNITY_MANAGER_ANTHROPIC_API_KEY=sk-community...
COMMUNITY_MANAGER_TELEGRAM_BOT_TOKEN=community-token...
COMMUNITY_MANAGER_CHARACTER=./characters/community-manager.json
```

### Server Configuration

```bash
# API server settings
SERVER_PORT=3000
SERVER_HOST=0.0.0.0

# Security
API_SECRET_KEY=your-secret-key-here
CORS_ORIGINS=http://localhost:3000,https://yourdomain.com

# Rate limiting
RATE_LIMIT_REQUESTS=100
RATE_LIMIT_WINDOW=900000  # 15 minutes in ms
```

### Logging & Monitoring

```bash
# Log level: fatal, error, warn, info, debug, trace
LOG_LEVEL=info

# Log format: json, pretty
LOG_FORMAT=pretty

# Sentry error tracking (optional)
SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx

# Performance monitoring
ENABLE_METRICS=true
METRICS_PORT=9090
```

### Feature Flags

```bash
# Enable experimental features
ENABLE_EXPERIMENTAL=false

# UI features
ELIZA_UI_ENABLE=true
ELIZA_UI_PORT=5173

# Development features
HOT_RELOAD=true
DEBUG_MEMORY=false
```

## 📋 Complete .env Example

```bash
# Model Provider (choose one)
OPENAI_API_KEY=sk-proj-...
# ANTHROPIC_API_KEY=sk-ant-api03-...
# GOOGLE_GENERATIVE_AI_API_KEY=AIza...
# OLLAMA_API_ENDPOINT=http://localhost:11434

# Platforms (enable as needed)
DISCORD_APPLICATION_ID=1234567890
DISCORD_API_TOKEN=MTI3NjM0...

TELEGRAM_BOT_TOKEN=7234567890:ABCdefGHI...

# Database (PostgreSQL for production)
POSTGRES_URL=postgresql://user:pass@localhost:5432/elizaos

# Server
SERVER_PORT=3000
LOG_LEVEL=info

# Optional Services
SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx
```

## 🧪 Testing Your Configuration

### Validate All Settings

```bash
# Check all environment variables
elizaos env validate

# This will test:
# ✓ API key validity
# ✓ Platform connections
# ✓ Database connectivity
# ✓ Required variables presence
```

### Test Individual Services

```bash
# Test model provider
elizaos test model --provider openai

# Test platform connection
elizaos test platform --type discord

# Test database
elizaos test database
```

## 🚨 Common Issues

### Missing API Keys

```
Error: No model provider configured
Solution: Set at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.
```

### Invalid Credentials

```
Error: Discord API error: 401 Unauthorized
Solution: Check your DISCORD_API_TOKEN is correct
```

### Database Connection

```
Error: Could not connect to PostgreSQL
Solution: Verify POSTGRES_URL and that database is running
```

### Permission Errors

```
Error: EACCES: permission denied
Solution: Check file permissions on .env and data directories
```

## 🔒 Security Best Practices

1. **Never commit .env files** - Add to .gitignore
2. **Use environment-specific files** - .env.local, .env.production
3. **Rotate credentials regularly** - Update API keys periodically
4. **Limit scope** - Use minimal permissions for tokens
5. **Use secrets management** - Consider tools like Vault in production

## 🚀 Next Steps

After configuring your environment:

1. **Test your setup** - Run `elizaos env validate`
2. **Create your character** - See [Character Configuration](/docs/customize/character-builder)
3. **Start your agent** - Run `elizaos start`
4. **Monitor logs** - Check for any configuration warnings

---

**💡 Pro Tip**: Use `elizaos env interactive` for the easiest setup experience. It validates credentials as you enter them and provides helpful context for each setting.