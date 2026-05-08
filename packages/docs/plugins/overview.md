---
title: Plugins Overview
sidebarTitle: Overview
description: Eliza's plugin system provides modular capabilities — model providers, platform connectors, DeFi integrations, and custom features.
---

Plugins are the primary extension mechanism for elizaOS. Every capability beyond the core runtime — from LLM providers to blockchain interactions — is delivered as a plugin.

## What is a Plugin?

A plugin is a self-contained module that registers one or more of:

- **Actions** — Things the agent can do (e.g., send a tweet, swap tokens)
- **Providers** — Context injected into the agent's prompt (e.g., wallet balance, time)
- **Evaluators** — Post-processing logic that runs after each response
- **Services** — Long-running background processes (e.g., cron jobs, event listeners)

## Plugin Categories

<CardGroup cols={2}>

<Card title="Core Plugins" icon="cube" href="/plugin-registry/documents">
  12 essential plugins that ship with every Eliza installation — sql, local-embedding, form, knowledge, trajectory-logger, agent-orchestrator, cron, shell, agent-skills, commands, plugin-manager, and roles.
</Card>

<Card title="Model Providers" icon="brain" href="/plugin-registry/llm/openai">
  LLM integrations for OpenAI, Anthropic, Google Gemini, Groq, Ollama, OpenRouter, xAI, Local AI, and Vercel AI Gateway ship in the bundled registry and auto-enable when their API key env var is set. Additional providers (DeepSeek, Mistral, Cohere, Together, Qwen, Minimax, Perplexity, Google Antigravity, Zai) may be available from the upstream elizaOS remote registry but are not bundled — install them explicitly if needed. Eliza Cloud auto-enables separately via `ELIZAOS_CLOUD_API_KEY`.
</Card>

<Card title="Platform Connectors" icon="plug" href="/plugin-registry/platform/discord">
  28 connector plugins across the bundled and remote registries. 18 auto-enable via connector config (Discord, Telegram, Twitter, Slack, WhatsApp, Signal, iMessage, Blooio, MS Teams, Google Chat, Mattermost, Farcaster, Twitch, Feishu, Matrix, Nostr, Lens, WeChat). 10 additional connectors (BlueBubbles, Bluesky, Instagram, LINE, Zalo, Twilio, GitHub, Gmail Watch, Nextcloud Talk, Tlon) can be installed from the registry.
</Card>

<Card title="DeFi & Blockchain" icon="wallet" href="/plugin-registry/defi/evm">
  On-chain interactions for EVM chains and Solana — token transfers, swaps, and DeFi protocols.
</Card>

<Card title="Feature Plugins" icon="wand-magic-sparkles" href="/plugin-registry/browser">
  64 feature plugins covering browser automation, image generation, TTS/STT, computer use, cron scheduling, vision, shell execution, webhooks, FAL media generation, Suno music, MCP server integration, code sandboxing, agent orchestration, knowledge/RAG, Obsidian vault sync, Gmail Watch, personality tuning, Shopify/Linear integrations, RSS feeds, x402 payments, agent skills, Claude Code workbench, and more.
</Card>

</CardGroup>

## How Plugins Load

Plugins are loaded during runtime initialization in this order:

1. **Eliza plugin** — The bridge plugin (`createElizaPlugin()`) providing workspace context, session keys, emotes, custom actions, and lifecycle actions. Always first in the plugins array.
2. **Pre-registered plugins** — `@elizaos/plugin-sql` and `@elizaos/plugin-local-embedding` are pre-registered before `runtime.initialize()` to prevent race conditions.
3. **Core plugins** — Always loaded: `sql`, `local-embedding`, `form`, `knowledge`, `trajectory-logger`, `agent-orchestrator`, `cron`, `shell`, `agent-skills`, `commands`, `plugin-manager`, and `roles` (see `packages/agent/src/runtime/core-plugins.ts`). Additional plugins like `pdf`, `cua`, `browser`, `computeruse`, `obsidian`, `code`, `repoprompt`, `claude-code-workbench`, `vision`, `cli`, `edge-tts`, `elevenlabs`, `discord`, `telegram`, and `twitch` are optional and loaded when their feature flags or environment variables are configured.
4. **Auto-enabled plugins** — Connector, provider, feature, streaming, subscription, hooks (webhooks + Gmail Watch), and media generation plugins are auto-enabled based on config and environment variables (see [Architecture](/plugins/architecture) for the full maps).
5. **Ejected plugins** — Local overrides discovered from `~/.eliza/plugins/ejected/`. When an ejected copy exists, it takes priority over the npm-published version.
6. **User-installed plugins** — Tracked in `plugins.installs` in `eliza.json`. Collected before drop-in plugins; any plugin name already present here takes precedence.
7. **Custom/drop-in plugins** — Scanned from `~/.eliza/plugins/custom/` and any extra paths in `plugins.load.paths`. Plugins whose names already exist in `plugins.installs` are skipped (`mergeDropInPlugins` precedence rule).

```json
// eliza.json plugin configuration
{
  "plugins": {
    "allow": ["@elizaos/plugin-openai", "discord"],
    "entries": {
      "openai": { "enabled": true }
    }
  },
  "connectors": {
    "discord": { "token": "..." }
  }
}
```

## Plugin Lifecycle

```
Install → Register → Initialize → Active → Shutdown
```

1. **Install** — Plugin package is resolved (npm or local)
2. **Register** — Actions, providers, evaluators, and services are registered with the runtime
3. **Initialize** — `init()` is called with runtime context
4. **Active** — Plugin processes events and provides capabilities
5. **Shutdown** — `cleanup()` is called on runtime stop

## Managing Plugins

### Install from Registry

```bash
eliza plugins install @elizaos/plugin-openai
```

### List Installed Plugins

```bash
eliza plugins list
```

### Enable/Disable

Enable or disable a plugin by setting its `enabled` flag in `eliza.json`:

```json
{
  "plugins": {
    "entries": {
      "plugin-name": { "enabled": false }
    }
  }
}
```

Or edit the config file directly (`eliza config path` shows the file location):

```bash
$EDITOR "$(eliza config path)"
```

### Eject (Copy to Local)

Eject a plugin via agent chat to clone its source for local editing:

```
eject the telegram plugin so I can edit its source
```

See [Plugin Eject](/plugins/plugin-eject) for the full eject/sync/reinject workflow.

## Related

- [Plugin Architecture](/plugins/architecture) — Deep dive into the plugin system
- [Create a Plugin](/plugins/create-a-plugin) — Step-by-step tutorial
- [Plugin Development](/plugins/development) — Development guide and API
- [Plugin Registry](/plugins/registry) — Browse available plugins
