---
title: "Plugin Registry"
sidebarTitle: "Registry"
description: "How Eliza discovers, caches, and resolves plugins from the remote registry."
---

The plugin registry is the system that discovers, caches, and resolves plugins and apps for Eliza agents. It combines a bundled local index with a remote GitHub-hosted registry, using a 3-tier cache to work offline, in desktop app bundles, and in development.

## Table of Contents

1. [What is the Registry?](#what-is-the-registry)
2. [3-Tier Caching](#3-tier-caching)
3. [Remote Registry](#remote-registry)
4. [Plugin Resolution](#plugin-resolution)
5. [CLI Commands](#cli-commands)
6. [Plugin Manifest Fields](#plugin-manifest-fields)
7. [Apps Registry](#apps-registry)
8. [Programmatic Access](#programmatic-access)

---

## What is the Registry?

The registry has two layers:

### Bundled Registry (`plugins.json`)

A local JSON file shipped with Eliza containing metadata for 98 plugins from the elizaOS ecosystem. Each entry includes the plugin's id, npm package name, category, environment variables, version, dependencies, and detailed parameter definitions. This file follows the `plugin-index-v1` schema.

```json
{
  "$schema": "plugin-index-v1",
  "generatedAt": "2026-02-09T20:23:38.561Z",
  "count": 98,
  "plugins": [
    {
      "id": "telegram",
      "dirName": "plugin-telegram",
      "name": "Telegram",
      "npmName": "@elizaos/plugin-telegram",
      "description": "Telegram bot connector for Eliza agents",
      "category": "connector",
      "envKey": "TELEGRAM_BOT_TOKEN",
      "configKeys": ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME"],
      "version": "2.0.0-alpha.4",
      "pluginDeps": [],
      "pluginParameters": { ... }
    }
  ]
}
```

The bundled `plugins.json` is used by the `eliza plugins config` command to look up parameter definitions, environment keys, and UI hints for plugin configuration.

### Remote Registry (GitHub)

The remote registry is hosted on the `elizaos-plugins/registry` GitHub repository on the `next` branch. The registry client fetches from two remote endpoints:

| Endpoint | URL | Format |
|----------|-----|--------|
| **Primary** | `https://raw.githubusercontent.com/elizaos-plugins/registry/next/generated-registry.json` | Enriched JSON with git info, npm versions, stars, topics, app metadata |
| **Fallback** | `https://raw.githubusercontent.com/elizaos-plugins/registry/next/index.json` | Minimal name-to-git-ref mapping |

The primary `generated-registry.json` contains a `registry` object keyed by package name, with each entry providing:

- Git repository, branches for v0/v1/v2
- npm package name and version strings for v0/v1/v2
- Version support flags (`supports: { v0, v1, v2 }`)
- Description, homepage, topics, star count, language
- App metadata (for entries with `kind: "app"`)

If the primary endpoint fails, the client falls back to `index.json`, which is a flat `Record<string, string>` mapping package names to `github:owner/repo` references. This fallback provides only the git coordinates with no enriched metadata.

---

## 3-Tier Caching

The registry client (`eliza/packages/agent/src/services/registry-client.ts`) uses a 3-tier resolution strategy to minimize network requests and support offline operation:

```
Memory Cache  -->  File Cache  -->  Network Fetch
  (in-process)     (~/.eliza/     (GitHub raw)
                    cache/
                    registry.json)
```

### Tier 1: Memory Cache

An in-process `Map<string, RegistryPluginInfo>` held in module-level state. Checked first on every call to `getRegistryPlugins()`. Invalidated after the TTL expires.

### Tier 2: File Cache

A JSON file at `~/.eliza/cache/registry.json` containing the serialized plugin map and a `fetchedAt` timestamp. Checked when the memory cache is empty or expired. Written asynchronously after each successful network fetch.

The file cache stores entries as `{ fetchedAt: number, plugins: Array<[string, RegistryPluginInfo]> }` and is invalidated when the TTL expires.

### Tier 3: Network Fetch

Fetches `generated-registry.json` from GitHub (falling back to `index.json`). Only reached when both the memory and file caches are empty or expired.

### Cache TTL

All tiers share a 1-hour TTL (`3_600_000` ms). After expiry, the next call to `getRegistryPlugins()` cascades through the tiers until fresh data is obtained.

### Force Refresh

Call `refreshRegistry()` to clear both the memory cache and the file cache, then fetch from the network:

```typescript
import { refreshRegistry } from "eliza/services/registry-client";

const plugins = await refreshRegistry();
```

Or from the CLI:

```bash
eliza plugins refresh
```

---

## Plugin Resolution

When looking up a plugin by name via `getPluginInfo(name)`, the registry client tries three strategies in order:

1. **Exact match** -- looks up the name directly in the registry map (e.g., `@elizaos/plugin-telegram`)
2. **@elizaos/ prefix** -- if the name does not start with `@`, prepends `@elizaos/` and tries again (e.g., `plugin-telegram` becomes `@elizaos/plugin-telegram`)
3. **Bare suffix scan** -- strips any scope prefix from the input and scans all registry keys for one ending with `/<bare-name>` (e.g., `plugin-telegram` matches `@elizaos/plugin-telegram`)

The CLI also normalizes user input via `normalizePluginName()`:

- `@scope/plugin-x` -- used as-is
- `plugin-x` -- used as-is
- `x` -- expanded to `@elizaos/plugin-x`

Version pinning is supported with the `@` separator:

```bash
eliza plugins install twitter@1.2.3
eliza plugins install @custom/plugin-x@2.0.0
eliza plugins install twitter@next    # dist-tags work too
```

---

## CLI Commands

All plugin commands live under `eliza plugins`. Run `eliza plugins --help` for the full list.

### `eliza plugins list`

List all plugins from the remote registry.

```bash
# List all plugins (default limit: 30)
eliza plugins list

# Search by keyword
eliza plugins list -q telegram

# Increase the result limit
eliza plugins list --limit 100
```

### `eliza plugins search <query>`

Search the registry by keyword with relevance scoring.

```bash
eliza plugins search "discord bot"
eliza plugins search openai --limit 5
```

Results show a match percentage based on scoring across name, description, and topics.

### `eliza plugins info <name>`

Show detailed information about a specific plugin: repository, homepage, language, stars, topics, npm versions, and supported elizaOS versions.

```bash
eliza plugins info telegram
eliza plugins info @elizaos/plugin-openai
```

### `eliza plugins install <name>`

Install a plugin from the registry into `~/.eliza/plugins/installed/<name>/`.

```bash
# Install by shorthand (expands to @elizaos/plugin-telegram)
eliza plugins install telegram

# Install a specific version
eliza plugins install telegram@1.2.3

# Install without restarting the agent
eliza plugins install telegram --no-restart
```

The installer uses npm/bun to install into an isolated prefix directory. If that fails, it falls back to cloning the plugin's GitHub repository. The installation is tracked in `eliza.json`.

### `eliza plugins uninstall <name>`

Remove a user-installed plugin.

```bash
eliza plugins uninstall @elizaos/plugin-telegram
eliza plugins uninstall telegram --no-restart
```

### `eliza plugins installed`

List all plugins that were installed from the registry (not bundled).

```bash
eliza plugins installed
```

### `eliza plugins refresh`

Force-refresh the registry cache (clears memory + file cache, fetches from GitHub).

```bash
eliza plugins refresh
```

### `eliza plugins config <name>`

Show or interactively edit a plugin's configuration parameters.

```bash
# View current config values
eliza plugins config telegram

# Interactive edit mode
eliza plugins config telegram --edit
```

In edit mode, the CLI walks through each parameter, showing current values (masking sensitive ones) and prompting for new values. Changes are saved to `eliza.json`.

### `eliza plugins test`

Validate custom drop-in plugins in `~/.eliza/plugins/custom/`. Checks that each plugin directory has a valid entry point and exports a Plugin object with `name` and `description`.

```bash
eliza plugins test
```

### `eliza plugins add-path <path>`

Register an additional plugin search directory in the config file.

```bash
eliza plugins add-path ~/my-plugins
```

### `eliza plugins paths`

List all plugin search directories and their contents.

```bash
eliza plugins paths
```

### `eliza plugins open [name-or-path]`

Open a plugin directory (or the custom plugins folder) in your editor.

```bash
# Open the custom plugins folder
eliza plugins open

# Open a specific custom plugin
eliza plugins open my-plugin
```

---

## Plugin Manifest Fields

### Bundled Registry Fields (`plugins.json`)

Each entry in the bundled `plugins.json` uses this schema:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Short identifier (e.g., `telegram`, `openai`) |
| `dirName` | `string` | Directory name in the source repo (e.g., `plugin-telegram`) |
| `name` | `string` | Human-readable display name |
| `npmName` | `string` | Full npm package name (e.g., `@elizaos/plugin-telegram`) |
| `description` | `string` | What the plugin does |
| `category` | `string` | Plugin category: `connector`, `ai-provider`, `feature`, `database`, `app` |
| `envKey` | `string` | Primary environment variable that activates this plugin |
| `configKeys` | `string[]` | All environment variables this plugin reads |
| `version` | `string` | Current published version |
| `pluginDeps` | `string[]` | IDs of other plugins this one depends on |
| `pluginParameters` | `object` | Detailed parameter definitions (see below) |

### Parameter Definitions

Each key in `pluginParameters` maps to:

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"string" \| "number" \| "boolean"` | Value type |
| `description` | `string` | Human-readable help text |
| `required` | `boolean` | Whether the parameter must be set |
| `sensitive` | `boolean` | Whether to mask the value in UI (tokens, passwords) |

### Remote Registry Fields (`generated-registry.json`)

Entries in the remote enriched registry use a different shape:

| Field | Type | Description |
|-------|------|-------------|
| `git.repo` | `string` | GitHub `owner/repo` path |
| `git.v0` / `v1` / `v2` | `{ branch: string \| null }` | Git branch for each elizaOS version |
| `npm.repo` | `string` | npm package name |
| `npm.v0` / `v1` / `v2` | `string \| null` | Published npm version per elizaOS version |
| `supports` | `{ v0, v1, v2: boolean }` | Which elizaOS versions are supported |
| `description` | `string` | Plugin description |
| `homepage` | `string \| null` | Homepage URL |
| `topics` | `string[]` | GitHub topics / tags |
| `stargazers_count` | `number` | GitHub star count |
| `language` | `string` | Primary language (usually `TypeScript`) |
| `kind` | `"app" \| undefined` | Set to `"app"` for launchable applications |
| `app` | `object \| undefined` | App metadata (see Apps Registry below) |

---

## Apps Registry

The registry has first-class support for **apps** -- launchable applications that are distinct from standard plugins. An entry is treated as an app when:

- Its `kind` field is `"app"`, or
- It has an `appMeta` / `app` object, or
- It matches a hardcoded local app override (e.g., `@elizaos/app-babylon`)

### App Metadata Fields

| Field | Type | Description |
|-------|------|-------------|
| `displayName` | `string` | Name shown in the UI |
| `category` | `string` | App category (e.g., `game`) |
| `launchType` | `string` | How the app launches: `url`, `connect`, `local` |
| `launchUrl` | `string \| null` | URL to launch or connect to |
| `icon` | `string \| null` | Icon URL |
| `capabilities` | `string[]` | App capabilities |
| `minPlayers` / `maxPlayers` | `number \| null` | Player count limits (for game apps) |
| `viewer` | `object` | Embed configuration: `url`, `embedParams`, `postMessageAuth`, `sandbox` |

### App-Specific Functions

```typescript
import { listApps, getAppInfo, searchApps } from "eliza/services/registry-client";

// List all registered apps, sorted by stars
const apps = await listApps();

// Look up a specific app
const app = await getAppInfo("@elizaos/app-babylon");

// Search apps by query (scores against displayName and capabilities too)
const results = await searchApps("game", 10);
```

### Local Workspace App Discovery

The registry client also discovers apps from local workspace directories. It scans:

1. `plugins/` directories in workspace roots for folders starting with `app-`
2. User-installed plugins at `~/.eliza/plugins/installed/` with `kind: "app"` in their package.json

Local app metadata is merged with remote registry data, with local values taking priority for fields like `description`, `homepage`, and `localPath`.

---

## Programmatic Access

### Core Functions

The registry client exports these functions from `eliza/packages/agent/src/services/registry-client.ts`:

```typescript
import {
  getRegistryPlugins,  // Get all plugins (3-tier cached)
  refreshRegistry,     // Force network refresh
  getPluginInfo,       // Look up a single plugin by name
  searchPlugins,       // Fuzzy search plugins
  listApps,            // List all app-kind entries
  getAppInfo,          // Look up a single app
  searchApps,          // Search apps
  listNonAppPlugins,   // List plugins excluding apps
  searchNonAppPlugins, // Search plugins excluding apps
} from "eliza/services/registry-client";
```

### Usage Example

```typescript
// Fetch the full registry (cached)
const registry = await getRegistryPlugins();
console.log(`${registry.size} plugins loaded`);

// Look up a plugin (tries exact, @elizaos/ prefix, bare suffix)
const info = await getPluginInfo("telegram");
if (info) {
  console.log(info.name);       // "@elizaos/plugin-telegram"
  console.log(info.gitRepo);    // "elizaos-plugins/plugin-telegram"
  console.log(info.npm.v2Version); // "2.0.0-alpha.4"
}

// Search with relevance scoring
const results = await searchPlugins("discord", 10);
for (const r of results) {
  console.log(`${r.name} (${(r.score * 100).toFixed(0)}% match)`);
}
```

### REST API

When the agent server is running, the registry is also available via HTTP:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/registry/plugins` | List all plugins with installed/loaded/bundled status |
| `GET` | `/api/registry/plugins/:name` | Look up a specific plugin |
| `GET` | `/api/registry/search?q=<query>&limit=<n>` | Search plugins by keyword |
| `POST` | `/api/registry/refresh` | Force-refresh the registry cache |

### Search Scoring

The search algorithm scores entries by matching the query against:

- **Plugin name** (exact match: +100, partial: +50)
- **Description** (contains query: +30)
- **Topics / tags** (contains query: +25)
- **Individual query terms** (split by whitespace, scored separately: +8 to +15 each)
- **Star bonuses** (>100: +3, >500: +3, >1000: +4)

Results are sorted by score descending, then by star count as a tiebreaker.

---

---

## Plugin Ecosystem

### Organization Structure

Official elizaOS plugins live in the [`elizaos-plugins`](https://github.com/elizaos-plugins) GitHub organization. The registry indexes plugins from this org automatically.

| Repository | Contents |
|-----------|----------|
| `elizaos-plugins/registry` | Registry index (`index.json`, `generated-registry.json`), registry site |
| `elizaos-plugins/plugin-*` | Individual official plugin packages |

### Naming Conventions

Follow these naming patterns for discoverability:

| Scope | Pattern | Example |
|-------|---------|---------|
| Official | `@elizaos/plugin-<name>` | `@elizaos/plugin-telegram` |
| Organization | `@yourorg/plugin-<name>` | `@acme/plugin-crm` |
| Community | `elizaos-plugin-<name>` | `elizaos-plugin-weather` |

The `plugin-` prefix is required for automatic discovery. The registry scanner recognizes all three patterns.

### Submitting a Plugin to the Registry

1. **Publish to npm** — Follow the [Publishing Guide](./publish)
2. **Open a PR** to [`elizaos-plugins/registry`](https://github.com/elizaos-plugins/registry) adding your plugin to `index.json`:

```json
{
  "@yourorg/plugin-weather": "github:yourorg/plugin-weather"
}
```

3. **Include in your PR:**
   - Plugin name, description, and category
   - A working `elizaos.plugin.json` manifest in your package
   - At least one passing test suite
   - README with setup instructions

4. **Registry CI** validates your plugin builds, loads, and passes tests
5. Once merged, your plugin appears in `eliza plugins search` and the registry site

### Registry Site

The registry has a browsable web interface hosted from `registry/site/`. Users can:
- Browse plugins by category (Core, Model Providers, Connectors, DeFi, Features)
- Search by name, description, or tags
- View plugin details, install commands, and configuration

---

## Next Steps

- [Plugin Development Guide](./development) -- Create your own plugins
- [Local Plugin Development](./local-plugins) -- Develop without publishing
- [Publishing Guide](./publish) -- Publish to npm and the registry
- [Contributing Guide](/guides/contributing) -- Submit plugins upstream
