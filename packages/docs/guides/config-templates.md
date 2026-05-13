---
title: "Configuration Templates"
sidebarTitle: "Config Templates"
description: "Ready-to-use eliza.json templates for common deployment scenarios"
---

## Overview

<Warning>
**These templates use a simplified, illustrative configuration format for readability.** The actual Eliza configuration file (`~/.eliza/eliza.json`) uses a different schema. In particular:
- Model providers are configured via the `env` section (e.g., `"OPENAI_API_KEY": "..."`) or environment variables, not a `modelProvider` object.
- Connectors are configured under `connectors.<name>` as objects (not arrays).
- There is no `system`, `handlers`, `monitoring`, `scaling`, `cache`, `backup`, or `security` top-level section in the actual config schema.
- Use `eliza configure` or the dashboard Settings page to configure your agent correctly.

See the [Configuration Reference](/configuration) and [Config Schema](/config-schema) for the actual config format.
</Warning>

This guide provides 8 illustrative configuration templates for different use cases. Each template shows the general shape of a deployment scenario.

<Warning>
**Important**: Replace all placeholder values before running:
- `<YOUR_API_KEY>` placeholders with your actual API keys
- Bot tokens and credentials with your real values
- Keep secrets in the `env` section or in `~/.eliza/.env` — the config file is written with mode `0o600` for safety

Never commit real API keys to version control. Use `~/.eliza/.env` for secrets when possible.
</Warning>

## 1. Minimal Setup

The simplest configuration — one provider, one agent, no connectors.

```json5
{
  // Minimal Eliza configuration
  // Perfect for: Learning, prototyping, single-model deployments
  
  modelProvider: {
    type: "openai",
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-5",
    temperature: 0.7,
    maxTokens: 2000
  },

  agents: {
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4-6" },
    },
    list: [
      {
        id: "mila",
        default: true,
        name: "Mila",
        bio: ["A helpful AI assistant"],
        system: "You are Mila, a thoughtful and helpful assistant.",
      },
    ],
  },

  logging: { level: "error" },
}
```

**Use this template if you:**
- Are just getting started with Eliza
- Want to test a single provider via the web dashboard
- Don't need connectors or advanced features

---

## 2. Personal Assistant

A fully-featured personal assistant with Ollama fallback, voice, and browser tools.

```json5
{
  // Personal Assistant Configuration
  // Perfect for: Individual productivity, note-taking, knowledge management
  
  modelProvider: {
    type: "openai",
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-5",
    temperature: 0.7,
    maxTokens: 4000
  },

  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["ollama/eliza-1-9b"],
      },
      thinkingDefault: "medium",
      userTimezone: "America/New_York",
    },
    list: [
      {
        id: "mila",
        default: true,
        name: "Mila",
        bio: [
          "A personal AI assistant focused on productivity and knowledge management",
        ],
        system: "You are Mila, a thoughtful assistant. Help with tasks, learning, and decision-making. Be concise and proactive.",
        style: { all: ["concise", "friendly", "proactive"] },
      },
    ],
  },

  features: {
    browser: true,
    cron: true,
  },

  tools: {
    web: {
      search: { enabled: true, provider: "brave" },
      fetch: { enabled: true },
    },
  },

  talk: {
    voiceId: "21m00Tcm4TlvDq8ikWAM",
    modelId: "eleven_turbo_v2_5",
  },

  logging: { level: "error" },
}
```

**Use this template if you:**
- Want a personal assistant with web search and voice
- Need a fallback model for when the primary is unavailable
- Want browser automation for web tasks

---

## 3. Discord Bot

A Discord community bot with per-guild configuration.

```json5
{
  // Discord Bot Configuration
  // Perfect for: Community automation, moderation, engagement
  
  modelProvider: {
    type: "openai",
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-5-mini",
    temperature: 0.6,
    maxTokens: 1024
  },

  agents: {
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4-6" },
    },
    list: [
      {
        id: "discord-bot",
        default: true,
        name: "Mila",
        bio: ["A Discord community assistant"],
        system: "You are Mila, a helpful bot in a Discord server. Keep responses concise and use Discord formatting when appropriate.",
        style: { all: ["concise", "casual"] },
      },
    ],
  },

  connectors: {
    discord: {
      token: "<YOUR_DISCORD_BOT_TOKEN>",
      groupPolicy: "allowlist",
      guilds: {
        "<YOUR_SERVER_ID>": {
          requireMention: true,
          channels: {
            "<YOUR_CHANNEL_ID>": {
              allow: true,
              requireMention: false,
            },
          },
        },
      },
      dm: {
        enabled: true,
        policy: "pairing",
      },
    },
  },

  logging: { level: "error" },
}
```

**Use this template if you:**
- Want a Discord community bot
- Need per-guild and per-channel configuration
- Want DM support with pairing flow

---

## 4. Telegram Bot

A Telegram bot with group support and inline buttons.

```json5
{
  // Telegram Bot Configuration
  // Perfect for: Mobile-first interactions, instant messaging, notifications
  
  modelProvider: {
    type: "openai",
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-5-mini",
    temperature: 0.5,
    maxTokens: 1024
  },

  agents: {
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4-6" },
    },
    list: [
      {
        id: "tg-bot",
        default: true,
        name: "Mila",
        bio: ["A Telegram assistant"],
        system: "You are Mila on Telegram. Keep responses short and mobile-friendly.",
        style: { all: ["concise", "friendly"] },
      },
    ],
  },

  connectors: {
    telegram: {
      botToken: "<YOUR_TELEGRAM_BOT_TOKEN>",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      groups: {
        "<YOUR_GROUP_ID>": {
          requireMention: true,
        },
      },
    },
  },

  logging: { level: "error" },
}
```

**Use this template if you:**
- Want a Telegram bot for instant messaging
- Need group chat support with mention filtering
- Want the pairing onboarding flow for new DMs

---

## 5. Multi-Connector Setup

Multiple platforms from a single agent — Discord, Telegram, and Slack.

```json5
{
  // Trading Bot Configuration
  // Perfect for: Autonomous trading, market analysis, portfolio management
  // WARNING: Only use with real funds after extensive testing and validation
  
  modelProvider: {
    type: "openai",
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-5",
    temperature: 0.3,
    maxTokens: 2000
  },

  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["openai/gpt-4o"],
      },
    },
    list: [
      {
        id: "mila",
        default: true,
        name: "Mila",
        bio: ["A multi-platform AI assistant"],
        system: "You are Mila. Adapt your tone to the platform — casual on Discord, professional on Slack, concise on Telegram.",
      },
    ],
  },

  connectors: {
    discord: {
      token: "<YOUR_DISCORD_BOT_TOKEN>",
      groupPolicy: "allowlist",
      guilds: {
        "<SERVER_ID>": { requireMention: true },
      },
    },
    telegram: {
      botToken: "<YOUR_TELEGRAM_BOT_TOKEN>",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    },
    slack: {
      mode: "socket",
      botToken: "<YOUR_SLACK_BOT_TOKEN>",
      appToken: "<YOUR_SLACK_APP_TOKEN>",
      groupPolicy: "allowlist",
    },
  },

  logging: { level: "error" },
}
```

**Use this template if you:**
- Want a single agent across Discord, Telegram, and Slack
- Need per-platform behavior via channel profiles
- Want a fallback model chain

---

## 6. BSC Trading Bot

Autonomous trading on BNB Smart Chain with PancakeSwap.

```json5
{
  // Research Agent Configuration
  // Perfect for: Information synthesis, market research, academic research, competitive analysis
  
  modelProvider: {
    type: "openai",
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-5",
    temperature: 0.2,
    maxTokens: 4000
  },

  agents: {
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4-6" },
      thinkingDefault: "high",
    },
    list: [
      {
        id: "trader",
        default: true,
        name: "Mila",
        bio: ["An autonomous trading agent on BSC"],
        system: "You are a trading assistant. Analyze market data, identify opportunities, and execute trades via PancakeSwap. Always confirm trade parameters before execution. Prioritize safety and position size limits.",
      },
    ],
  },

  features: {
    browser: true,
  },

  tools: {
    web: {
      search: { enabled: true, provider: "brave" },
      fetch: { enabled: true },
    },
  },

  logging: { level: "info" },
}
```

<Warning>
Only use with real funds after extensive testing. Start with `ELIZA_TRADE_PERMISSION_MODE: "user"` to require manual confirmation for each trade.
</Warning>

**Use this template if you:**
- Want autonomous BSC trading via PancakeSwap
- Need market analysis and trade execution
- Have experience with DeFi and smart contracts

---

## 7. Privacy-First / Ollama (Fully Local)

Complete privacy — Ollama for local inference, no external API calls.

```json5
{
  // Fully local — no API keys, no cloud, no phone home
  env: {
    OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  },

  agents: {
    defaults: {
      model: { primary: "ollama/eliza-1-9b" },
    },
    list: [
      {
        id: "local",
        default: true,
        name: "Mila",
        bio: ["A fully local AI assistant — all data stays on this machine"],
        system: "You are Mila, running locally with full privacy. All data stays on this machine.",
        style: { all: ["concise", "helpful"] },
      },
    ],
  },

  // Local embedding model (no OpenAI calls)
  embedding: {
    model: "eliza-1-0_8b-32k.gguf",
    dimensions: 1024,
    gpuLayers: "auto",
  },

  database: {
    provider: "pglite",
  },

  logging: { level: "error" },
}
```

Before running, install Ollama and create an Eliza-1 model:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama create eliza-1-9b -f packages/training/cloud/ollama/Modelfile.eliza-1-9b-q4_k_m
```

**Use this template if you:**
- Need maximum privacy — zero external API calls
- Want to run in offline or air-gapped environments
- Have a machine with enough RAM for local models (8GB+ recommended)

---

## 8. Production Server

Production deployment with PostgreSQL, monitoring, multiple connectors, and cloud integration.

```json5
{
  // Production Server Configuration
  // Perfect for: Enterprise deployments, multi-tenant systems, high-traffic services
  
  modelProvider: {
    type: "openai",
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-5",
    temperature: 0.7,
    maxTokens: 2000,
    retryPolicy: {
      maxRetries: 3,
      backoffMultiplier: 2,
      initialDelayMs: 1000
    }
  },

  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["openai/gpt-4o"],
      },
      thinkingDefault: "medium",
      timeoutSeconds: 120,
    },
    list: [
      {
        id: "prod",
        default: true,
        name: "Mila",
        bio: ["A production AI assistant"],
        system: "You are Mila, a production assistant.",
      },
    ],
  },

  // PostgreSQL for production
  database: {
    provider: "postgres",
    postgres: {
      connectionString: "<YOUR_POSTGRES_URL>",
      ssl: true,
    },
  },

  // Gateway with auth
  gateway: {
    port: 18789,
    bind: "lan",
    auth: {
      mode: "token",
      token: "<YOUR_API_TOKEN>",
    },
    controlUi: {
      enabled: true,
    },
  },

  // Multi-connector
  connectors: {
    discord: {
      token: "<YOUR_DISCORD_BOT_TOKEN>",
      groupPolicy: "allowlist",
    },
    telegram: {
      botToken: "<YOUR_TELEGRAM_BOT_TOKEN>",
      dmPolicy: "pairing",
    },
    slack: {
      mode: "socket",
      botToken: "<YOUR_SLACK_BOT_TOKEN>",
      appToken: "<YOUR_SLACK_APP_TOKEN>",
    },
  },

  // OpenTelemetry
  diagnostics: {
    otel: {
      enabled: true,
      endpoint: "<YOUR_OTEL_ENDPOINT>",
      serviceName: "eliza-prod",
      traces: true,
      metrics: true,
    },
  },

  // Feature flags
  features: {
    browser: true,
    cron: true,
    webhooks: true,
  },

  tools: {
    exec: { security: "allowlist" },
    web: {
      search: { enabled: true, provider: "brave" },
      fetch: { enabled: true },
    },
  },

  // Update channel
  update: { channel: "stable" },

  logging: {
    level: "info",
    consoleStyle: "json",
  },
}
```

**Use this template if you:**
- Are deploying to production with multiple connectors
- Need PostgreSQL and observability
- Want gateway auth for secure remote access
- Need reliable fallback models

---

## Customizing Templates

### Choosing a Model

Set the model in `agents.defaults.model.primary` using `provider/model-name` format:

```json5
agents: {
  defaults: {
    model: {
      primary: "anthropic/claude-sonnet-4-6",
      fallbacks: ["openai/gpt-4o", "groq/openai/gpt-oss-120b"],
    },
  },
},
```

See [Model Providers](/model-providers) for the full list of 18 supported providers.

### Adding Connectors

Add platforms under `connectors`. Each auto-enables when credentials are present:

```json5
connectors: {
  telegram: { botToken: "<TOKEN>" },
  discord: { token: "<TOKEN>" },
  slack: { botToken: "<TOKEN>", appToken: "<TOKEN>" },
},
```

See [Platform Connectors](/guides/connectors) for all 28 supported platforms.

### API Keys

Use `~/.eliza/.env` for secrets (recommended) or the `env` section in `eliza.json`:

```bash
# ~/.eliza/.env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
BRAVE_API_KEY=BSA...
```

Load with:
```json5
modelProvider: {
  apiKey: process.env.OPENAI_API_KEY
}
```

---

## Validation & Testing

### Test Your Setup

After editing `~/.eliza/eliza.json`, verify your configuration:

```bash
# Start Eliza and check for startup errors
eliza

# Check model provider status
eliza models

# Check installed plugins
eliza plugins installed

# Run the built-in diagnostics
eliza doctor
```

### Development Mode

For development and testing:

```bash
# Start with hot reload (API + UI)
bun run dev

# Run the test suite
bun run test

# Type-check and lint
bun run check
```

---

## Next Steps

1. **Choose a template** that matches your use case
2. **Adapt the concepts** to the actual `eliza.json` config format (see [Configuration](/configuration) and [Config Schema](/config-schema))
3. **Replace all placeholder values** with your actual credentials
4. **Test locally** with `eliza` and `eliza models`
5. **Deploy** using your hosting platform's deployment process

See the [Configuration Reference](/configuration) for complete option documentation.
