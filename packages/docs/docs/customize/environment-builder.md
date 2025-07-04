# Environment Configuration Builder

Set up your ElizaOS environment with confidence using our interactive configuration wizard. No more guesswork – get your agent running in minutes with validated settings.

## 🎯 What Is Environment Builder?

Environment Builder is an intelligent configuration tool that guides you through setting up your ElizaOS environment variables. It validates your credentials in real-time, prevents common configuration errors, and ensures your agent has everything it needs to run successfully.

### Key Features

- 🔐 **Credential Validation** - Test API keys and tokens before saving
- 🎨 **Visual Configuration** - Drag-and-drop interface with instant feedback
- 🛡️ **Security First** - Encrypted storage and secure credential handling
- 📋 **Template Library** - Pre-configured setups for common use cases
- ⚡ **Real-Time Testing** - Validate connections as you configure
- 🔄 **Export & Backup** - Generate .env files and configuration backups

## 🚀 Quick Start Guide

### Step 1: Launch the Builder

```bash
# Option 1: Web Interface (Recommended)
bun start --env-builder

# Option 2: CLI Interface
elizaos env configure --interactive

# Option 3: Online Tool
# Visit: https://elizaos.org/env-builder
```

### Step 2: Choose Your Configuration Path

#### 🌟 Smart Setup (Recommended)

Answer a few questions and let AI configure your environment:

- **What's your primary use case?** (Discord bot, Twitter automation, etc.)
- **Which platforms do you want to support?** (Multiple choice)
- **What's your technical comfort level?** (Beginner, Intermediate, Advanced)

#### 🎯 Template-Based Setup

Start with proven configurations:

- **Discord Community Bot** - Everything needed for server management
- **Twitter Automation Agent** - Social media engagement and monitoring
- **Multi-Platform Assistant** - Support for Discord, Telegram, Twitter
- **Development Environment** - Local testing with PGLite database
- **Enterprise Setup** - Production-ready with PostgreSQL and monitoring

#### 🔧 Manual Configuration

Full control over every environment variable

### Step 3: Configure Your Services

## 🔐 Credential Management

### AI Model Providers

**OpenAI Configuration**

```bash
# Your OpenAI API Key
OPENAI_API_KEY=sk-...

# Model Selection (Optional)
OPENAI_MODEL=gpt-4o-mini  # Default: gpt-4o-mini
```

<div className="validation-panel">
<div className="validation-input">
  <label>OpenAI API Key</label>
  <input type="password" placeholder="sk-..." />
  <button className="validate-btn">Test Connection</button>
</div>
<div className="validation-result success">
  ✅ Connection successful! Available models: gpt-4o, gpt-4o-mini, gpt-3.5-turbo
</div>
</div>

**Anthropic Configuration**

```bash
# Your Anthropic API Key
ANTHROPIC_API_KEY=sk-ant-...

# Model Selection (Optional)
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022  # Default: claude-3-5-sonnet-20241022
```

<div className="validation-panel">
<div className="validation-input">
  <label>Anthropic API Key</label>
  <input type="password" placeholder="sk-ant-..." />
  <button className="validate-btn">Test Connection</button>
</div>
<div className="validation-result success">
  ✅ Connection successful! Available models: claude-3-5-sonnet-20241022, claude-3-5-haiku-20241022
</div>
</div>

**Google AI Configuration**

```bash
# Your Google AI API Key
GOOGLE_GENERATIVE_AI_API_KEY=...

# Model Selection (Optional)
GOOGLE_MODEL=gemini-1.5-flash  # Default: gemini-1.5-flash
```

<div className="validation-panel">
<div className="validation-input">
  <label>Google AI API Key</label>
  <input type="password" placeholder="AIza..." />
  <button className="validate-btn">Test Connection</button>
</div>
<div className="validation-result warning">
  ⚠️  Connection successful but rate-limited. Consider upgrading your plan for production use.
</div>
</div>

### Platform Integration

**Discord Bot Setup**

```bash
# Required for Discord integration
DISCORD_APPLICATION_ID=1234567890123456789
DISCORD_API_TOKEN=MTE...

# Optional: Advanced Discord features
DISCORD_VOICE=false  # Enable voice channel support
DISCORD_SLASH_COMMANDS=true  # Enable slash commands
```

<div className="validation-panel">
<div className="validation-input">
  <label>Discord Application ID</label>
  <input type="text" placeholder="1234567890123456789" />
</div>
<div className="validation-input">
  <label>Discord Bot Token</label>
  <input type="password" placeholder="MTE..." />
  <button className="validate-btn">Test Bot</button>
</div>
<div className="validation-result success">
  ✅ Bot authenticated successfully! Bot name: "YourBot" | Permissions: Administrator
</div>
</div>

**Telegram Bot Setup**

```bash
# Required for Telegram integration
TELEGRAM_BOT_TOKEN=1234567890:ABC...

# Optional: Telegram features
TELEGRAM_WEBHOOK=false  # Use polling by default
TELEGRAM_ADMIN_CHAT_ID=123456789  # Admin notifications
```

<div className="validation-panel">
<div className="validation-input">
  <label>Telegram Bot Token</label>
  <input type="password" placeholder="1234567890:ABC..." />
  <button className="validate-btn">Test Bot</button>
</div>
<div className="validation-result success">
  ✅ Bot authenticated successfully! Bot name: "@YourBot" | Status: Active
</div>
</div>

**Twitter/X Integration**

```bash
# Required for Twitter automation
TWITTER_API_KEY=...
TWITTER_API_SECRET=...
TWITTER_ACCESS_TOKEN=...
TWITTER_ACCESS_TOKEN_SECRET=...

# Optional: Twitter behavior
TWITTER_TARGET_USERS=elonmusk,openai  # Users to monitor
TWITTER_DRY_RUN=false  # Set to true for testing
```

<div className="validation-panel">
<div className="validation-input">
  <label>Twitter API Key</label>
  <input type="password" placeholder="..." />
</div>
<div className="validation-input">
  <label>Twitter API Secret</label>
  <input type="password" placeholder="..." />
</div>
<div className="validation-input">
  <label>Access Token</label>
  <input type="password" placeholder="..." />
</div>
<div className="validation-input">
  <label>Access Token Secret</label>
  <input type="password" placeholder="..." />
  <button className="validate-btn">Test Connection</button>
</div>
<div className="validation-result error">
  ❌ Authentication failed. Check your credentials and ensure your Twitter app has read/write permissions.
</div>
</div>

### Database Configuration

**PostgreSQL (Production)**

```bash
# Production database (recommended)
DATABASE_URL=postgresql://username:password@localhost:5432/eliza_db

# Connection pool settings
DATABASE_MAX_CONNECTIONS=20
DATABASE_IDLE_TIMEOUT=30000
```

<div className="validation-panel">
<div className="validation-input">
  <label>PostgreSQL Connection URL</label>
  <input type="password" placeholder="postgresql://username:password@localhost:5432/eliza_db" />
  <button className="validate-btn">Test Connection</button>
</div>
<div className="validation-result success">
  ✅ Database connected successfully! Version: PostgreSQL 15.4 | Schema: eliza_v2
</div>
</div>

**PGLite (Development)**

```bash
# Local development database (default)
DATABASE_URL=pglite://./data/eliza.db

# No additional configuration needed
```

<div className="validation-panel">
<div className="validation-result info">
  ℹ️ PGLite will be used for local development. No configuration needed.
</div>
</div>

### Blockchain Integration

**Ethereum/EVM Configuration**

```bash
# Private key for EVM transactions
EVM_PRIVATE_KEY=0x...

# Network configuration
EVM_NETWORK=mainnet  # mainnet, goerli, sepolia
EVM_RPC_URL=https://mainnet.infura.io/v3/YOUR_PROJECT_ID
```

<div className="validation-panel">
<div className="validation-input">
  <label>EVM Private Key</label>
  <input type="password" placeholder="0x..." />
  <button className="validate-btn">Validate Key</button>
</div>
<div className="validation-result warning">
  ⚠️  Valid private key detected. Wallet address: 0x1234... | Balance: 0.05 ETH
</div>
</div>

**Solana Configuration**

```bash
# Private key for Solana transactions
SOLANA_PRIVATE_KEY=...

# Network configuration
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_NETWORK=mainnet-beta  # mainnet-beta, devnet, testnet
```

<div className="validation-panel">
<div className="validation-input">
  <label>Solana Private Key</label>
  <input type="password" placeholder="..." />
  <button className="validate-btn">Validate Key</button>
</div>
<div className="validation-result success">
  ✅ Valid private key detected. Wallet address: 5G4k... | Balance: 1.25 SOL
</div>
</div>

## 🎨 Visual Configuration Interface

### Environment Variables Dashboard

<div className="env-dashboard">
  <div className="env-category">
    <h3>🤖 AI Model Providers</h3>
    <div className="env-status">
      <span className="status-dot success"></span>
      <span>OpenAI: Configured</span>
    </div>
    <div className="env-status">
      <span className="status-dot warning"></span>
      <span>Anthropic: Test needed</span>
    </div>
    <div className="env-status">
      <span className="status-dot error"></span>
      <span>Google AI: Not configured</span>
    </div>
  </div>

  <div className="env-category">
    <h3>💬 Platform Integrations</h3>
    <div className="env-status">
      <span className="status-dot success"></span>
      <span>Discord: Connected</span>
    </div>
    <div className="env-status">
      <span className="status-dot success"></span>
      <span>Telegram: Connected</span>
    </div>
    <div className="env-status">
      <span className="status-dot error"></span>
      <span>Twitter: Authentication failed</span>
    </div>
  </div>

  <div className="env-category">
    <h3>🗄️ Database</h3>
    <div className="env-status">
      <span className="status-dot success"></span>
      <span>PostgreSQL: Connected</span>
    </div>
  </div>

  <div className="env-category">
    <h3>⛓️ Blockchain</h3>
    <div className="env-status">
      <span className="status-dot warning"></span>
      <span>Ethereum: Low balance</span>
    </div>
    <div className="env-status">
      <span className="status-dot success"></span>
      <span>Solana: Ready</span>
    </div>
  </div>
</div>

### Smart Recommendations

<div className="recommendations-panel">
  <h3>🧠 Configuration Recommendations</h3>
  
  <div className="recommendation high">
    <div className="rec-priority">HIGH</div>
    <div className="rec-content">
      <strong>Twitter API Authentication Failed</strong>
      <p>Your Twitter credentials are invalid. This will prevent social media features from working.</p>
      <button className="rec-action">Fix Twitter Setup</button>
    </div>
  </div>

  <div className="recommendation medium">
    <div className="rec-priority">MEDIUM</div>
    <div className="rec-content">
      <strong>Consider Adding Backup AI Provider</strong>
      <p>Having multiple AI providers prevents downtime if one service is unavailable.</p>
      <button className="rec-action">Add Anthropic</button>
    </div>
  </div>

  <div className="recommendation low">
    <div className="rec-priority">LOW</div>
    <div className="rec-content">
      <strong>Optimize Database Connection Pool</strong>
      <p>Your current settings may not be optimal for your expected load.</p>
      <button className="rec-action">Optimize Settings</button>
    </div>
  </div>
</div>

## 🔍 Real-Time Validation Framework

### Validation Engine

Our validation system runs comprehensive checks on your configuration:

**Connection Testing**

```javascript
const validateEnvironment = async (config) => {
  const results = {
    aiProviders: [],
    platforms: [],
    database: null,
    blockchain: [],
  };

  // Test AI providers
  if (config.OPENAI_API_KEY) {
    results.aiProviders.push(await testOpenAI(config.OPENAI_API_KEY));
  }

  if (config.ANTHROPIC_API_KEY) {
    results.aiProviders.push(await testAnthropic(config.ANTHROPIC_API_KEY));
  }

  // Test platform integrations
  if (config.DISCORD_API_TOKEN) {
    results.platforms.push(await testDiscord(config));
  }

  if (config.TELEGRAM_BOT_TOKEN) {
    results.platforms.push(await testTelegram(config));
  }

  // Test database
  if (config.DATABASE_URL) {
    results.database = await testDatabase(config.DATABASE_URL);
  }

  return results;
};
```

**Security Validation**

```javascript
const validateSecurity = (config) => {
  const issues = [];

  // Check for common security issues
  if (config.EVM_PRIVATE_KEY && !config.EVM_PRIVATE_KEY.startsWith('0x')) {
    issues.push({
      level: 'error',
      message: 'EVM private key must start with 0x',
      fix: 'Add 0x prefix to your private key',
    });
  }

  if (config.TWITTER_DRY_RUN === 'false' && !config.TWITTER_TARGET_USERS) {
    issues.push({
      level: 'warning',
      message: 'Twitter live mode without target users may cause spam',
      fix: 'Set TWITTER_TARGET_USERS or enable DRY_RUN mode',
    });
  }

  return issues;
};
```

### Real-Time Feedback

<div className="validation-live">
  <h3>🔄 Live Validation</h3>
  
  <div className="validation-item">
    <div className="validation-icon">🔍</div>
    <div className="validation-text">Testing OpenAI connection...</div>
    <div className="validation-spinner"></div>
  </div>

  <div className="validation-item success">
    <div className="validation-icon">✅</div>
    <div className="validation-text">Discord bot authenticated successfully</div>
    <div className="validation-details">Bot: "MyAgent" | Servers: 3 | Permissions: ✓</div>
  </div>

  <div className="validation-item error">
    <div className="validation-icon">❌</div>
    <div className="validation-text">Telegram bot token invalid</div>
    <div className="validation-details">Error: 401 Unauthorized - Check your bot token</div>
  </div>
</div>

## 📋 Configuration Templates

### Template Gallery

**Discord Community Bot**

```bash
# AI Provider
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

# Discord Integration
DISCORD_APPLICATION_ID=1234567890123456789
DISCORD_API_TOKEN=MTE...
DISCORD_VOICE=false
DISCORD_SLASH_COMMANDS=true

# Database
DATABASE_URL=postgresql://username:password@localhost:5432/eliza_db

# Logging
LOG_LEVEL=info
```

**Twitter Automation Agent**

```bash
# AI Provider
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022

# Twitter Integration
TWITTER_API_KEY=...
TWITTER_API_SECRET=...
TWITTER_ACCESS_TOKEN=...
TWITTER_ACCESS_TOKEN_SECRET=...
TWITTER_TARGET_USERS=elonmusk,openai,anthropicai
TWITTER_DRY_RUN=false

# Database
DATABASE_URL=postgresql://username:password@localhost:5432/eliza_db

# Logging
LOG_LEVEL=info
```

**Multi-Platform Assistant**

```bash
# AI Providers (redundancy)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Platform Integrations
DISCORD_APPLICATION_ID=1234567890123456789
DISCORD_API_TOKEN=MTE...
TELEGRAM_BOT_TOKEN=1234567890:ABC...
TWITTER_API_KEY=...
TWITTER_API_SECRET=...
TWITTER_ACCESS_TOKEN=...
TWITTER_ACCESS_TOKEN_SECRET=...

# Database
DATABASE_URL=postgresql://username:password@localhost:5432/eliza_db

# Logging
LOG_LEVEL=info
```

**Development Environment**

```bash
# AI Provider (development)
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

# Local Database
DATABASE_URL=pglite://./data/eliza.db

# Debug Settings
LOG_LEVEL=debug
TWITTER_DRY_RUN=true
```

### Template Customization

<div className="template-customizer">
  <h3>🎨 Customize Template</h3>
  
  <div className="template-option">
    <label>Template Base:</label>
    <select>
      <option>Discord Community Bot</option>
      <option>Twitter Automation Agent</option>
      <option>Multi-Platform Assistant</option>
      <option>Development Environment</option>
    </select>
  </div>

  <div className="template-option">
    <label>AI Provider:</label>
    <div className="checkbox-group">
      <label><input type="checkbox" checked /> OpenAI</label>
      <label><input type="checkbox" /> Anthropic</label>
      <label><input type="checkbox" /> Google AI</label>
    </div>
  </div>

  <div className="template-option">
    <label>Platforms:</label>
    <div className="checkbox-group">
      <label><input type="checkbox" checked /> Discord</label>
      <label><input type="checkbox" /> Telegram</label>
      <label><input type="checkbox" /> Twitter</label>
    </div>
  </div>

  <div className="template-option">
    <label>Database:</label>
    <div className="radio-group">
      <label><input type="radio" name="db" /> PGLite (Local)</label>
      <label><input type="radio" name="db" checked /> PostgreSQL</label>
    </div>
  </div>

<button className="generate-template">Generate Custom Template</button>

</div>

## 🛡️ Security Best Practices

### Credential Management

**Environment File Security**

```bash
# Never commit .env files to version control
echo ".env" >> .gitignore
echo ".env.local" >> .gitignore
echo ".env.production" >> .gitignore

# Use different environments for different stages
cp .env.example .env.development
cp .env.example .env.production
```

**API Key Rotation**

```bash
# Set up automated key rotation (production)
# Use services like AWS Secrets Manager or HashiCorp Vault
SECRETS_MANAGER_ENDPOINT=https://secretsmanager.amazonaws.com
SECRETS_ROTATION_INTERVAL=7d
```

**Access Control**

```bash
# Restrict file permissions
chmod 600 .env
chmod 600 .env.production

# Use environment-specific user accounts
sudo useradd -m -s /bin/bash eliza-prod
sudo chown eliza-prod:eliza-prod .env.production
```

### Security Validation

<div className="security-panel">
  <h3>🔒 Security Checklist</h3>
  
  <div className="security-item success">
    <div className="security-icon">✅</div>
    <div className="security-text">No hardcoded credentials found</div>
  </div>

  <div className="security-item success">
    <div className="security-icon">✅</div>
    <div className="security-text">Environment files properly secured</div>
  </div>

  <div className="security-item warning">
    <div className="security-icon">⚠️</div>
    <div className="security-text">Private keys detected - ensure secure storage</div>
  </div>

  <div className="security-item error">
    <div className="security-icon">❌</div>
    <div className="security-text">API keys have overly broad permissions</div>
  </div>
</div>

## 🔄 Export & Deployment

### Configuration Export

**Generate .env Files**

```bash
# Export to different formats
./environment-builder export --format=env > .env
./environment-builder export --format=json > config.json
./environment-builder export --format=yaml > config.yaml
```

**Docker Configuration**

```dockerfile
# Dockerfile with environment variables
FROM node:18-alpine

# Copy environment configuration
COPY .env.production /app/.env

# Install dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Copy application
COPY . .

# Expose port
EXPOSE 3000

# Start application
CMD ["npm", "start"]
```

**Kubernetes Deployment**

```yaml
# k8s-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: eliza-agent
spec:
  replicas: 3
  selector:
    matchLabels:
      app: eliza-agent
  template:
    metadata:
      labels:
        app: eliza-agent
    spec:
      containers:
        - name: eliza-agent
          image: eliza:latest
          envFrom:
            - secretRef:
                name: eliza-secrets
            - configMapRef:
                name: eliza-config
```

### Deployment Wizard

<div className="deployment-wizard">
  <h3>🚀 Deployment Wizard</h3>
  
  <div className="wizard-step active">
    <div className="step-number">1</div>
    <div className="step-content">
      <h4>Choose Deployment Target</h4>
      <div className="deployment-options">
        <div className="deployment-option">
          <input type="radio" name="deploy" id="local" checked />
          <label for="local">Local Development</label>
        </div>
        <div className="deployment-option">
          <input type="radio" name="deploy" id="docker" />
          <label for="docker">Docker Container</label>
        </div>
        <div className="deployment-option">
          <input type="radio" name="deploy" id="cloud" />
          <label for="cloud">Cloud Platform</label>
        </div>
      </div>
    </div>
  </div>

  <div className="wizard-step">
    <div className="step-number">2</div>
    <div className="step-content">
      <h4>Environment Configuration</h4>
      <p>Configure environment-specific settings</p>
    </div>
  </div>

  <div className="wizard-step">
    <div className="step-number">3</div>
    <div className="step-content">
      <h4>Security & Monitoring</h4>
      <p>Set up security policies and monitoring</p>
    </div>
  </div>

  <div className="wizard-controls">
    <button className="wizard-btn prev" disabled>Previous</button>
    <button className="wizard-btn next">Next</button>
  </div>
</div>

## 📊 Environment Analytics

### Configuration Health Score

<div className="health-score">
  <div className="score-circle">
    <div className="score-value">87</div>
    <div className="score-label">Health Score</div>
  </div>
  
  <div className="score-breakdown">
    <div className="score-item">
      <div className="score-bar">
        <div className="score-fill" style={{width: '95%'}}></div>
      </div>
      <div className="score-details">
        <span>Security</span>
        <span>95%</span>
      </div>
    </div>
    
    <div className="score-item">
      <div className="score-bar">
        <div className="score-fill" style={{width: '85%'}}></div>
      </div>
      <div className="score-details">
        <span>Completeness</span>
        <span>85%</span>
      </div>
    </div>
    
    <div className="score-item">
      <div className="score-bar">
        <div className="score-fill" style={{width: '78%'}}></div>
      </div>
      <div className="score-details">
        <span>Performance</span>
        <span>78%</span>
      </div>
    </div>
  </div>
</div>

### Environment Monitoring

**Real-Time Status**

```javascript
const monitorEnvironment = () => {
  return {
    aiProviders: {
      openai: { status: 'healthy', latency: 250, quota: 85 },
      anthropic: { status: 'healthy', latency: 180, quota: 45 },
    },
    platforms: {
      discord: { status: 'healthy', connections: 1250, uptime: 99.9 },
      telegram: { status: 'degraded', connections: 890, uptime: 98.5 },
      twitter: { status: 'error', connections: 0, uptime: 0 },
    },
    database: {
      status: 'healthy',
      connections: 15,
      queryTime: 45,
      storage: 2.1, // GB
    },
  };
};
```

## 🎓 Common Configuration Patterns

### Multi-Environment Setup

**Development Environment**

```bash
# .env.development
NODE_ENV=development
LOG_LEVEL=debug
DATABASE_URL=pglite://./data/eliza-dev.db
TWITTER_DRY_RUN=true
DISCORD_SLASH_COMMANDS=false
```

**Staging Environment**

```bash
# .env.staging
NODE_ENV=staging
LOG_LEVEL=info
DATABASE_URL=postgresql://user:pass@staging-db:5432/eliza_staging
TWITTER_DRY_RUN=true
DISCORD_SLASH_COMMANDS=true
```

**Production Environment**

```bash
# .env.production
NODE_ENV=production
LOG_LEVEL=warn
DATABASE_URL=postgresql://user:pass@prod-db:5432/eliza_prod
TWITTER_DRY_RUN=false
DISCORD_SLASH_COMMANDS=true
```

### Load Balancing Configuration

**Multiple AI Providers**

```bash
# Primary and backup AI providers
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_GENERATIVE_AI_API_KEY=...

# Load balancing strategy
AI_PROVIDER_STRATEGY=round_robin  # round_robin, priority, cost_optimized
AI_FAILOVER_TIMEOUT=5000  # 5 seconds
```

**Database Clustering**

```bash
# Master-slave database setup
DATABASE_URL=postgresql://user:pass@master-db:5432/eliza_prod
DATABASE_READ_REPLICAS=postgresql://user:pass@replica1:5432/eliza_prod,postgresql://user:pass@replica2:5432/eliza_prod
DATABASE_READ_STRATEGY=round_robin
```

## 🔧 Troubleshooting Guide

### Common Issues & Solutions

**Authentication Failures**

```bash
# Test individual services
elizaos env test --service=openai
elizaos env test --service=discord
elizaos env test --service=telegram

# Debug authentication
curl -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models
```

**Database Connection Issues**

```bash
# Test database connection
pg_isready -h localhost -p 5432 -U username

# Check database permissions
psql -h localhost -U username -d eliza_prod -c "SELECT version();"
```

**Platform Integration Problems**

```bash
# Discord bot permissions
# Ensure bot has these permissions:
# - Read Messages
# - Send Messages
# - Use Slash Commands
# - Embed Links

# Telegram bot setup
# Message @BotFather to get token
# Use /setcommands to configure bot commands
```

### Error Resolution

<div className="error-resolution">
  <h3>🔧 Error Resolution Assistant</h3>
  
  <div className="error-item">
    <div className="error-header">
      <div className="error-icon">❌</div>
      <div className="error-title">OpenAI API Error 401</div>
    </div>
    <div className="error-details">
      <p><strong>Cause:</strong> Invalid API key or insufficient permissions</p>
      <p><strong>Solution:</strong></p>
      <ul>
        <li>Verify your API key is correct</li>
        <li>Check if your API key has sufficient credits</li>
        <li>Ensure the key has access to the required models</li>
      </ul>
      <button className="error-fix">Auto-Fix</button>
    </div>
  </div>

  <div className="error-item">
    <div className="error-header">
      <div className="error-icon">⚠️</div>
      <div className="error-title">Database Connection Timeout</div>
    </div>
    <div className="error-details">
      <p><strong>Cause:</strong> Database server unreachable or overloaded</p>
      <p><strong>Solution:</strong></p>
      <ul>
        <li>Check database server status</li>
        <li>Verify connection string format</li>
        <li>Increase connection timeout values</li>
      </ul>
      <button className="error-fix">Diagnose</button>
    </div>
  </div>
</div>

## 📞 Getting Help

### Built-in Support

**Interactive Help**

```bash
# Get help for specific configuration
elizaos env help --service=discord
elizaos env help --service=database
elizaos env help --service=ai-providers

# Validate entire configuration
elizaos env validate --verbose
```

**Documentation Links**

- [OpenAI API Documentation](https://platform.openai.com/docs/api-reference)
- [Discord Bot Setup Guide](https://discord.com/developers/docs/getting-started)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Twitter API v2](https://developer.twitter.com/en/docs/twitter-api)

### Community Resources

**Support Channels**

- **Discord**: #environment-help channel
- **GitHub**: Environment configuration issues
- **Video Tutorials**: Step-by-step setup guides

**Expert Services**

- **Configuration Audit**: Professional review of your setup
- **Custom Integration**: Help with specialized requirements
- **Production Deployment**: Enterprise deployment assistance

---

## 🎬 Ready to Configure Your Environment?

<div className="cta-grid">

**🌟 New to ElizaOS?**  
[Start with Smart Setup →](/docs/customize/environment-builder?mode=smart)

**🎯 Have Specific Requirements?**  
[Use Template-Based Setup →](/docs/customize/environment-builder?mode=template)

**🔧 Need Full Control?**  
[Manual Configuration →](/docs/customize/environment-builder?mode=manual)

**🔍 Want to Test First?**  
[Try the Demo →](/docs/customize/environment-builder?demo=true)

</div>

---

**💡 Pro Tip**: Start with a template that's closest to your use case, then customize individual settings. This approach reduces configuration errors and gets you running faster.

**🎯 Next Steps**: After setting up your environment, use the [Character Builder](/docs/customize/character-builder) to create your agent's personality, or explore the [Feature Workshop](/docs/customize/feature-workshop) to add advanced capabilities!

<style jsx>{`
  .validation-panel {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
    margin: 1rem 0;
    backdrop-filter: blur(10px);
  }

  .validation-input {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .validation-input label {
    min-width: 120px;
    font-weight: 500;
  }

  .validation-input input {
    flex: 1;
    padding: 0.5rem 1rem;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.1);
    color: white;
  }

  .validate-btn {
    padding: 0.5rem 1rem;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border: none;
    border-radius: 8px;
    color: white;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.3s ease;
  }

  .validate-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 20px rgba(102, 126, 234, 0.4);
  }

  .validation-result {
    padding: 1rem;
    border-radius: 8px;
    margin-top: 1rem;
    font-weight: 500;
  }

  .validation-result.success {
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.3);
    color: #22c55e;
  }

  .validation-result.warning {
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.3);
    color: #fbbf24;
  }

  .validation-result.error {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #ef4444;
  }

  .validation-result.info {
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
    color: #3b82f6;
  }

  .env-dashboard {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 2rem;
    margin: 2rem 0;
  }

  .env-category {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
    backdrop-filter: blur(10px);
  }

  .env-category h3 {
    margin-bottom: 1rem;
    color: white;
  }

  .env-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .status-dot.success {
    background: #22c55e;
  }

  .status-dot.warning {
    background: #fbbf24;
  }

  .status-dot.error {
    background: #ef4444;
  }

  .recommendations-panel {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
    margin: 2rem 0;
    backdrop-filter: blur(10px);
  }

  .recommendation {
    display: flex;
    gap: 1rem;
    padding: 1rem;
    border-radius: 8px;
    margin-bottom: 1rem;
  }

  .recommendation.high {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .recommendation.medium {
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.3);
  }

  .recommendation.low {
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
  }

  .rec-priority {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 700;
    white-space: nowrap;
  }

  .recommendation.high .rec-priority {
    background: #ef4444;
    color: white;
  }

  .recommendation.medium .rec-priority {
    background: #fbbf24;
    color: white;
  }

  .recommendation.low .rec-priority {
    background: #3b82f6;
    color: white;
  }

  .rec-action {
    padding: 0.5rem 1rem;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border: none;
    border-radius: 6px;
    color: white;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    margin-top: 0.5rem;
  }

  .cta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 2rem;
    margin: 2rem 0;
  }

  .cta-grid > div {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
    backdrop-filter: blur(10px);
    transition: all 0.3s ease;
  }

  .cta-grid > div:hover {
    transform: translateY(-4px);
    box-shadow: 0 8px 30px rgba(102, 126, 234, 0.3);
  }
`}</style>
