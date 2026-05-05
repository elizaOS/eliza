---
title: "Plugin Eject System"
sidebarTitle: "Plugin Eject"
description: "Clone plugin or core source locally for editing, testing, syncing with upstream, and contributing back via pull requests."
---

The eject system lets you clone an upstream plugin's source code locally, modify it, and have the runtime load your local copy instead of the npm package. This enables rapid plugin development, debugging, and contribution back to upstream repositories.

## Table of Contents

1. [What Eject Does](#what-eject-does)
2. [Plugin Eject Workflow](#plugin-eject-workflow)
3. [Core Eject](#core-eject)
4. [Agent Actions](#agent-actions)
5. [Directory Structure](#directory-structure)
6. [Plugin Loading Priority](#plugin-loading-priority)
7. [The .upstream.json Format](#the-upstreamjson-format)
8. [Syncing with Upstream](#syncing-with-upstream)
9. [Contributing Back](#contributing-back)
10. [CLI Commands](#cli-commands)
11. [Troubleshooting](#troubleshooting)

---

## What Eject Does

Ejecting a plugin clones its upstream Git repository into a local directory (`~/.eliza/plugins/ejected/`), creates tracking metadata (`.upstream.json`), and configures the runtime to load the local copy instead of the npm-installed version.

This is useful when you need to:

- Debug a plugin by stepping through its source
- Add features or fix bugs in a plugin
- Test changes before submitting a pull request to upstream
- Customize a plugin for your specific use case

---

## Plugin Eject Workflow

The complete workflow for working with ejected plugins:

```
eject → edit → build → test → sync → PR → reinject
```

### 1. Eject

Clone the upstream plugin source:

Via agent chat:
```
eject the telegram plugin so I can edit its source
```

Or manually:
```bash
git clone --branch 1.x https://github.com/elizaos-plugins/plugin-telegram.git \
  ~/.eliza/plugins/ejected/plugin-telegram

cd ~/.eliza/plugins/ejected/plugin-telegram
bun install
bun run build
```

### 2. Edit

Make your changes in the ejected plugin's `src/` directory:

```bash
cd ~/.eliza/plugins/ejected/plugin-telegram/src/
# Edit files...
```

### 3. Build

After editing, rebuild the plugin:

```bash
cd ~/.eliza/plugins/ejected/plugin-telegram
bun run build
```

### 4. Test

Restart Eliza. The runtime auto-discovers ejected plugins and loads them instead of the npm versions:

```bash
eliza start
```

Look for log messages like `Loading ejected plugin:` to confirm.

### 5. Sync

Pull upstream changes while preserving your local edits:

Via agent chat:
```
sync the ejected telegram plugin
```

Or manually:
```bash
cd ~/.eliza/plugins/ejected/plugin-telegram
git fetch origin
git pull --rebase origin 1.x
bun run build
```

### 6. Reinject

When done, remove the local copy and revert to the npm version:

Via agent chat:
```
reinject the telegram plugin
```

Or manually:
```bash
rm -rf ~/.eliza/plugins/ejected/plugin-telegram
# Restart Eliza — it loads the npm version again
```

---

## Core Eject

In addition to plugins, you can eject `@elizaos/core` itself for deep customization. Core eject clones the entire elizaOS monorepo and configures TypeScript path mapping to load the local core.

### Core Eject Details

- **Git URL**: `https://github.com/elizaos/eliza.git`
- **Default branch**: `develop`
- **Core package path**: `packages/core` within the monorepo
- **Local directory**: `~/.eliza/core/eliza/`

### Core Status

The core status interface provides:

```typescript
interface CoreStatus {
  ejected: boolean;
  ejectedPath: string;
  monorepoPath: string;
  corePackagePath: string;
  coreDistPath: string;
  version: string;
  npmVersion: string;
  commitHash: string | null;
  localChanges: boolean;
  upstream: UpstreamMetadata | null;
}
```

---

## Agent Actions

The agent has built-in actions for managing ejected plugins and core:

### Plugin Actions

| Action | Description |
|--------|-------------|
| `EJECT_PLUGIN` | Clone a plugin's upstream source for local editing |
| `SYNC_PLUGIN` | Pull upstream changes and merge with local edits |
| `REINJECT_PLUGIN` | Remove local source and revert to npm version |
| `LIST_EJECTED_PLUGINS` | Show all ejected plugins with upstream status |

### Core Actions

| Action | Description |
|--------|-------------|
| `EJECT_CORE` | Clone @elizaos/core source locally |
| `SYNC_CORE` | Pull upstream changes to local core |
| `REINJECT_CORE` | Remove local core, revert to npm |
| `CORE_STATUS` | Show current core eject status |

---

## Directory Structure

```
~/.eliza/
├── plugins/
│   ├── installed/           # npm-installed plugins (managed by plugin-installer)
│   ├── custom/              # Hand-written drop-in plugins
│   └── ejected/             # Git-cloned upstream plugins for editing
│       └── plugin-telegram/
│           ├── .upstream.json    # Upstream tracking metadata
│           ├── package.json
│           ├── src/              # Editable source code
│           ├── dist/             # Built output (runtime loads this)
│           └── node_modules/     # Plugin's own dependencies
└── core/
    └── eliza/                # Ejected @elizaos/core monorepo
        ├── .upstream.json
        └── packages/
            └── core/
                ├── src/
                └── dist/
```

---

## Plugin Loading Priority

When the runtime resolves plugins, ejected versions always take precedence:

1. **Ejected** (`~/.eliza/plugins/ejected/`) -- highest priority
2. **Workspace override** (project-local plugin overrides)
3. **Official npm** (`node_modules/@elizaos/plugin-*`) -- with install record repair
4. **User-installed** (`~/.eliza/plugins/installed/`)
5. **Local @eliza** (built-in dist plugins)
6. **npm fallback** (`import(name)`)

This means you can eject any plugin and your local version automatically takes over without any additional configuration.

---

## The .upstream.json Format

Every ejected plugin (and core) has a `.upstream.json` file at its root that tracks the upstream relationship:

```json
{
  "$schema": "eliza-upstream-v1",
  "source": "github:elizaos-plugins/plugin-telegram",
  "gitUrl": "https://github.com/elizaos-plugins/plugin-telegram.git",
  "branch": "1.x",
  "commitHash": "093613e...",
  "ejectedAt": "2026-02-16T08:00:00Z",
  "npmPackage": "@elizaos/plugin-telegram",
  "npmVersion": "1.6.4",
  "lastSyncAt": null,
  "localCommits": 0
}
```

| Field | Description |
|-------|-------------|
| `$schema` | Always `"eliza-upstream-v1"` |
| `source` | Short source identifier (e.g., `github:org/repo`) |
| `gitUrl` | Full Git clone URL |
| `branch` | Upstream branch being tracked |
| `commitHash` | Commit hash at time of eject (or last sync) |
| `ejectedAt` | ISO 8601 timestamp when the plugin was ejected |
| `npmPackage` | npm package name being replaced |
| `npmVersion` | npm version at time of eject |
| `lastSyncAt` | ISO 8601 timestamp of last upstream sync (null if never synced) |
| `localCommits` | Number of local commits since eject or last sync |

---

## Syncing with Upstream

### Sync Results

The sync operation returns:

```typescript
interface SyncResult {
  success: boolean;
  pluginName: string;
  ejectedPath: string;
  upstreamCommits: number;   // How many new commits from upstream
  localChanges: boolean;     // Whether local modifications exist
  conflicts: string[];       // List of conflicted file paths
  commitHash: string;        // Current commit after sync
  error?: string;
}
```

### Manual Sync

```bash
cd ~/.eliza/plugins/ejected/plugin-telegram

# Check what changed upstream
git fetch origin
git log HEAD..origin/1.x --oneline

# Pull changes (fast-forward if no local commits)
git pull --ff-only origin 1.x

# Or if you have local commits
git pull --rebase origin 1.x

# Rebuild after sync
bun run build
```

If merge conflicts occur, resolve them manually, then `git add` the resolved files and continue.

---

## Contributing Back

The ejected plugin is a real Git repository. You can push changes upstream:

```bash
cd ~/.eliza/plugins/ejected/plugin-telegram

# Add your fork as a remote
git remote add fork git@github.com:YOUR_USER/plugin-telegram.git

# Create a feature branch
git checkout -b feat/my-improvement

# Commit your changes
git add -A
git commit -m "feat: add typing indicators and smart chunking"

# Push to your fork
git push fork feat/my-improvement

# Open PR against upstream
gh pr create --repo elizaos-plugins/plugin-telegram --base 1.x
```

---

## CLI Commands

### List Ejected Plugins

```
GET /api/plugins/ejected
```

Returns all ejected plugins with their `.upstream.json` metadata.

### Via Agent Chat

- `"eject the telegram plugin"` -- triggers `EJECT_PLUGIN`
- `"sync the ejected telegram plugin"` -- triggers `SYNC_PLUGIN`
- `"reinject the telegram plugin"` -- triggers `REINJECT_PLUGIN`
- `"list ejected plugins"` -- triggers `LIST_EJECTED_PLUGINS`
- `"eject core"` -- triggers `EJECT_CORE`
- `"sync core"` -- triggers `SYNC_CORE`
- `"reinject core"` -- triggers `REINJECT_CORE`
- `"core status"` -- triggers `CORE_STATUS`

---

## Troubleshooting

### Plugin not loading after eject

- Verify `bun run build` succeeded and a `dist/` directory exists
- Check that `package.json` has a valid `name` field matching the expected plugin name
- Look for `Loading ejected plugin:` messages in the runtime logs

### Build errors

- Run `bun install` first -- ejected plugins have their own `node_modules/`
- Check the upstream repository's README for specific build requirements or peer dependencies

### Merge conflicts on sync

- The sync operation reports conflicted files in the `conflicts` array
- Resolve conflicts manually in each file
- Run `git add <resolved-file>` for each resolved file
- Rebuild with `bun run build`

### Eject fails with Git errors

- Ensure `git` is installed and available in PATH
- Check that the upstream Git URL is accessible (not behind auth)
- The eject system sets `GIT_TERMINAL_PROMPT=0` to prevent interactive auth prompts

### Path validation

- Git URLs must match the pattern for valid Git repository URLs
- Branch names are validated against allowed characters
- Package names must be valid npm package names
