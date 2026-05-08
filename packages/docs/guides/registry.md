---
title: Plugin Registry Guide
description: How to discover, configure, submit, and maintain plugins in the Eliza/elizaOS plugin registry.
---

# Plugin Registry Guide

The plugin registry is the central index of available elizaOS plugins. This guide covers discovering, using, and submitting plugins to the registry.

## Table of Contents

1. [What is the Registry?](#what-is-the-registry)
2. [Discovering Plugins](#discovering-plugins)
3. [Using Plugins](#using-plugins)
4. [Plugin Manifest](#plugin-manifest)
5. [Submitting Plugins](#submitting-plugins)
6. [Plugin Categories](#plugin-categories)
7. [Naming Conventions](#naming-conventions)

---

## What is the Registry?

The plugin registry is:

- **A JSON index** (`plugins.json`) listing all known plugins
- **Metadata** including name, description, category, and configuration
- **Discovery system** for finding and loading plugins

Eliza ships with a bundled `plugins.json` containing 90+ plugins from the elizaOS ecosystem.

---

## Discovering Plugins

### List Available Plugins

```bash
eliza plugins list
```

### Search Plugins

```bash
eliza plugins list --search telegram
```

### View Plugin Details

```bash
eliza plugins info telegram
```

### Browse by Category

```bash
eliza plugins list --category connector
eliza plugins list --category model
eliza plugins list --category tool
```

### Programmatic Access

```typescript
import pluginIndex from "elizaai/plugins.json";

// List all plugins
for (const plugin of pluginIndex.plugins) {
  console.log(`${plugin.id}: ${plugin.description}`);
}

// Find by category
const connectors = pluginIndex.plugins.filter(p => p.category === "connector");
```

---

## Using Plugins

### Install via npm

Most plugins are npm packages:

```bash
# Install the Telegram connector
bun add @elizaos/plugin-telegram
```

### Configure in eliza.json

```json
{
  "plugins": [
    "@elizaos/plugin-telegram",
    "@elizaos/plugin-discord",
    "@elizaos/plugin-openai"
  ]
}
```

### Environment Variables

Most plugins require configuration via environment variables:

```bash
# .env or environment
TELEGRAM_BOT_TOKEN=your-bot-token
DISCORD_BOT_TOKEN=your-discord-token
OPENAI_API_KEY=sk-...
```

### Auto-Enable Based on Credentials

Eliza can auto-enable plugins when their required credentials are present:

```json
{
  "plugins": {
    "autoEnable": true
  }
}
```

With `autoEnable`, if `TELEGRAM_BOT_TOKEN` is set, the Telegram plugin loads automatically.

---

## Plugin Manifest

Each plugin in the registry has a manifest entry:

```json
{
  "id": "telegram",
  "dirName": "plugin-telegram",
  "name": "Telegram",
  "npmName": "@elizaos/plugin-telegram",
  "description": "Telegram bot connector for Eliza agents",
  "category": "connector",
  "envKey": "TELEGRAM_BOT_TOKEN",
  "configKeys": [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_USERNAME",
    "TELEGRAM_CHANNEL_IDS"
  ],
  "version": "2.0.0-alpha.4",
  "pluginDeps": [],
  "pluginParameters": {
    "TELEGRAM_BOT_TOKEN": {
      "type": "string",
      "description": "Telegram Bot API token from @BotFather",
      "required": true,
      "sensitive": true
    },
    "TELEGRAM_BOT_USERNAME": {
      "type": "string",
      "description": "Bot username (without @)",
      "required": false,
      "sensitive": false
    }
  }
}
```

### Manifest Fields

| Field | Description |
|-------|-------------|
| `id` | Short identifier (e.g., `telegram`) |
| `dirName` | Directory name in repo |
| `name` | Human-readable name |
| `npmName` | npm package name |
| `description` | What the plugin does |
| `category` | Plugin category |
| `envKey` | Primary environment variable |
| `configKeys` | All configuration keys |
| `version` | Current version |
| `pluginDeps` | Other plugins this depends on |
| `pluginParameters` | Detailed parameter definitions |

---

## Submitting Plugins

### Option 1: Official Plugins (@elizaos)

For plugins to be included in the official `@elizaos` namespace:

1. **Create a PR** to the [elizaos-plugins](https://github.com/elizaos-plugins) organization
2. **Follow conventions** (see below)
3. **Include tests** and documentation
4. **Pass review** by maintainers

### Option 2: Community Plugins

Publish to npm with community naming:

```json
{
  "name": "elizaos-plugin-my-feature",
  "version": "1.0.0"
}
```

Or use a scoped package:

```json
{
  "name": "@yourorg/elizaos-plugin-my-feature"
}
```

### Option 3: Local Registry

For private/internal plugins, maintain a local registry:

```json
// custom-plugins.json
{
  "$schema": "plugin-index-v1",
  "plugins": [
    {
      "id": "internal-crm",
      "npmName": "@internal/plugin-crm",
      "description": "Internal CRM integration",
      "category": "connector"
    }
  ]
}
```

---

## Plugin Categories

### connector

External service integrations and messaging platforms.

| Plugin | Description |
|--------|-------------|
| `telegram` | Telegram bot |
| `discord` | Discord bot |
| `slack` | Slack integration |
| `twitter` | Twitter/X |
| `whatsapp` | WhatsApp (via Baileys) |
| `signal` | Signal messenger |
| `imessage` | iMessage (macOS) |

### model

AI model providers and inference.

| Plugin | Description |
|--------|-------------|
| `openai` | OpenAI GPT models |
| `anthropic` | Claude models |
| `ollama` | Local Ollama models |
| `groq` | Groq inference |
| `openrouter` | OpenRouter gateway |
| `google-genai` | Google Gemini |

### tool

Utilities and capabilities.

| Plugin | Description |
|--------|-------------|
| `browser` | Web browsing |
| `shell` | Shell command execution |
| `code` | Code generation/execution |
| `repoprompt` | RepoPrompt CLI orchestration |
| `vision` | Image analysis |
| `knowledge` | RAG/knowledge base |
| `mcp` | Model Context Protocol |

### memory

Storage and memory systems.

| Plugin | Description |
|--------|-------------|
| `sql` | SQL database adapter |
| `local-embedding` | Local embedding generation |

### automation

Scheduling and automation.

| Plugin | Description |
|--------|-------------|
| `cron` | Scheduled tasks |
| `scheduling` | Calendar integration |

---

## Naming Conventions

### Package Names

**Official plugins:**
```
@elizaos/plugin-{feature}
```

Examples:
- `@elizaos/plugin-telegram`
- `@elizaos/plugin-openai`
- `@elizaos/plugin-browser`

**Community plugins:**
```
elizaos-plugin-{feature}
@yourorg/plugin-{feature}
```

Examples:
- `elizaos-plugin-my-integration`
- `@acme/plugin-internal-tool`

### Plugin IDs

Short, lowercase identifiers:

```
telegram
discord
openai
my-feature
```

### Action Names

UPPERCASE_WITH_UNDERSCORES:

```
MESSAGE
GENERATE_MEDIA
FETCH_DATA
```

---

## Plugin Configuration Schema

Plugins can define their configuration schema for UI generation:

```json
{
  "pluginParameters": {
    "API_KEY": {
      "type": "string",
      "description": "API key for authentication",
      "required": true,
      "sensitive": true
    },
    "ENDPOINT_URL": {
      "type": "string",
      "description": "API endpoint URL",
      "required": false,
      "sensitive": false
    },
    "TIMEOUT_MS": {
      "type": "number",
      "description": "Request timeout in milliseconds",
      "required": false,
      "sensitive": false
    },
    "DEBUG_MODE": {
      "type": "boolean",
      "description": "Enable debug logging",
      "required": false,
      "sensitive": false
    }
  }
}
```

### Parameter Types

| Type | Description |
|------|-------------|
| `string` | Text value |
| `number` | Numeric value |
| `boolean` | True/false |

### Parameter Flags

| Flag | Description |
|------|-------------|
| `required` | Must be provided |
| `sensitive` | Should be masked in UI (passwords, tokens) |

---

## Regenerating the Registry

If you're maintaining a fork or custom registry:

```bash
# Generate plugins.json from installed plugins
bun run generate:plugins
```

This scans `node_modules/@elizaos/plugin-*` and generates an updated index.

---

## Examples

### Finding a Model Provider

```bash
# List model plugins
eliza plugins list --category model

# Check OpenAI plugin info
eliza plugins info openai

# Install and configure
bun add @elizaos/plugin-openai
echo "OPENAI_API_KEY=sk-..." >> .env
```

### Adding Multiple Connectors

```json
// eliza.json
{
  "plugins": [
    "@elizaos/plugin-telegram",
    "@elizaos/plugin-discord",
    "@elizaos/plugin-slack"
  ]
}
```

```bash
# .env
TELEGRAM_BOT_TOKEN=...
DISCORD_BOT_TOKEN=...
SLACK_BOT_TOKEN=...
```

### Using Community Plugins

```bash
# Install community plugin
bun add elizaos-plugin-custom-feature

# Add to config
# eliza.json
{
  "plugins": [
    "@elizaos/plugin-openai",
    "elizaos-plugin-custom-feature"
  ]
}
```

---

## Next Steps

- [Plugin Development Guide](/plugins/development) — Create your own plugins
- [Local Plugin Development](/plugins/local-plugins) — Develop without publishing
- [Contributing Guide](/guides/contributing) — Submit plugins upstream

---

## Registry Runbook

### Setup Checklist

1. Ensure plugin metadata exists and is valid in `plugins.json`.
2. Ensure installable packages resolve from npm or your internal registry.
3. Ensure required env keys for each plugin are documented in the manifest.
4. For on-chain registry operations, set `EVM_PRIVATE_KEY` and configure `mainnetRpc`, `registryAddress`, and `collectionAddress` in agent config.
5. Verify the plugin install directory is writable: `ls -ld ~/.eliza/plugins/installed/`.

### Failure Modes

**Plugin registry lookup:**

- Registry lookup returns no results:
  Confirm `plugins.json` is current and plugin IDs are spelled correctly.
- Install succeeds but plugin does not load:
  Confirm required env keys are set and plugin is enabled in `plugins.allow` or `plugins.entries`.
- Version drift between manifest and package:
  Regenerate registry metadata and commit updated manifest.

**NPM resolution and install:**

- `npm pack` or `bun install` fails during plugin install:
  Check network connectivity to the npm registry. The installer falls back from npm to direct git clone — if both fail, the package spec is likely invalid.
- Entry point not found after install:
  The installer checks for `package.json` in the target directory. Confirm the package has a valid `main` or `module` field, or that `index.js`/`index.ts` exists at the package root.
- Concurrent install corruption:
  The installer uses a serialisation lock. If a previous install crashed, stale lock state may block new installs. Restart the agent to clear in-memory locks.

**On-chain registry/drop operations:**

- Transaction reverts or times out:
  Check that `EVM_PRIVATE_KEY` has sufficient gas balance. Verify `mainnetRpc` is reachable and not rate-limited. The tx-service retries with escalating gas — if all retries fail, the error includes the revert reason.
- Registry contract call returns empty data:
  Confirm `registryAddress` and `collectionAddress` point to deployed contracts on the correct chain. Use a block explorer to verify contract state.
- Nonce conflict on rapid sequential transactions:
  The tx-service manages nonce locally. If an external wallet transaction changes the nonce, restart the agent to re-sync.

### Recovery Procedures

1. **Stale plugin state:** Delete `~/.eliza/plugins/installed/<plugin-name>/` and remove the entry from `eliza.json` under `plugins.installs`, then re-install.
2. **Registry metadata out of sync:** Run `eliza plugin sync` or manually update `plugins.json` from the upstream registry.
3. **On-chain tx stuck:** Check the pending transaction on a block explorer. If stuck, the agent will retry with higher gas on next attempt. Manual speed-up via wallet is safe — the agent re-reads nonce on next call.

### Verification Commands

```bash
# Plugin registry and installer tests
bunx vitest run src/services/plugin-installer.test.ts src/services/skill-marketplace.test.ts src/services/mcp-marketplace.test.ts

# Plugin install e2e lifecycle
bunx vitest run --config test/vitest/e2e.config.ts test/plugin-install.e2e.test.ts test/skills-marketplace-api.e2e.test.ts test/skills-marketplace-services.e2e.test.ts

# On-chain service tests
bunx vitest run src/api/tx-service.test.ts src/api/registry-service.test.ts src/api/drop-service.test.ts

# API server e2e (includes registry routes)
bunx vitest run --config test/vitest/e2e.config.ts test/api-server.e2e.test.ts

bun run typecheck
```
