---
title: "Local Plugins"
sidebarTitle: "Local Plugins"
description: "Develop plugins locally without publishing to npm."
---

This guide covers developing plugins locally without publishing to npm -- custom integrations, private plugins, rapid prototyping, and ejecting upstream plugins for modification.

Maintainer note: this document is for runtime/user plugin paths under `~/.eliza/plugins/*`. Eliza source-checkout development of first-party packages uses the repo-local workspaces under `eliza/plugins/*` and `eliza/packages/*` by default; the old sibling-checkout flow is no longer the primary path in this repo.

## Table of Contents

1. [Plugin Locations](#plugin-locations)
2. [Plugin Loading Priority](#plugin-loading-priority)
3. [Creating a Local Plugin](#creating-a-local-plugin)
4. [Configuration](#configuration)
5. [Plugin Installer](#plugin-installer)
6. [Ejecting Upstream Plugins](#ejecting-upstream-plugins)
7. [Development Workflow](#development-workflow)
8. [Debugging](#debugging)
9. [Environment Variables](#environment-variables)
10. [Migrating to npm](#migrating-to-npm)

---

## Plugin Locations

Eliza discovers plugins from three locations under the state directory (`~/.eliza/` by default):

### 1. Ejected Plugins

Upstream plugins cloned locally for modification:

```
~/.eliza/plugins/ejected/<plugin-name>/
```

These are created by the eject system (see [Ejecting Upstream Plugins](#ejecting-upstream-plugins)). Each subdirectory is a full git repo with editable source.

### 2. Installed Plugins

Plugins installed at runtime via the plugin manager or CLI:

```
~/.eliza/plugins/installed/<sanitised-name>/
```

Each plugin gets an isolated directory with its own `package.json` and `node_modules/`. The installer creates a minimal `{ "private": true, "dependencies": {} }` package.json, then runs `bun add <package>` (or `npm install` as fallback) inside that directory.

### 3. Custom (Drop-in) Plugins

Hand-written plugins placed directly in the custom directory:

```
~/.eliza/plugins/custom/<your-plugin>/
```

Any subdirectory here with a `package.json` is auto-discovered at startup. This is the simplest way to add a local plugin -- just drop it in and restart.

### 4. Extra Load Paths

Additional directories can be specified in `eliza.json`:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "~/shared-plugins",
        "/opt/team-plugins"
      ]
    }
  }
}
```

Each directory is scanned the same way as `plugins/custom/` -- subdirectories with a `package.json` are treated as plugins.

### Full Directory Layout

```
~/.eliza/
├── eliza.json              # Main config file
└── plugins/
    ├── ejected/              # Git-cloned upstream plugins for editing
    │   └── plugin-telegram/
    │       ├── .upstream.json
    │       ├── package.json
    │       ├── src/
    │       └── dist/
    ├── installed/            # Runtime-installed plugins (managed by plugin-installer)
    │   └── _elizaos_plugin-twitter/
    │       ├── package.json
    │       └── node_modules/
    └── custom/               # Hand-written drop-in plugins
        └── my-plugin/
            ├── package.json
            ├── src/
            └── dist/
```

---

## Plugin Loading Priority

When multiple sources provide the same plugin name, Eliza uses this precedence (highest first):

| Priority | Source | Path | Use case |
|----------|--------|------|----------|
| 1 | **Ejected** | `~/.eliza/plugins/ejected/` | Modifying upstream plugin source |
| 2 | **Workspace override** | Internal dev mechanism | Eliza contributors only |
| 3 | **Official npm** (with install record) | `node_modules/@elizaos/plugin-*` | Standard `@elizaos/*` plugins prefer bundled copies |
| 4 | **User-installed** (with install record) | `~/.eliza/plugins/installed/` | Third-party plugins installed at runtime |
| 5 | **Local @eliza** | `src/plugins/` (compiled dist) | Built-in Eliza plugins |
| 6 | **npm fallback** | `import(name)` | Last resort dynamic import |

Custom/drop-in plugins are merged into the install records before resolution, so they participate in priorities 3-4 depending on their package name.

The deny list (`plugins.deny` in `eliza.json`) takes absolute precedence -- denied plugins are never loaded regardless of source.

---

## Creating a Local Plugin

### Step 1: Create the Directory

```bash
mkdir -p ~/.eliza/plugins/custom/my-plugin/src
cd ~/.eliza/plugins/custom/my-plugin
```

### Step 2: Initialize package.json

```bash
cat > package.json << 'EOF'
{
  "name": "my-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@elizaos/core": "alpha"
  }
}
EOF
```

### Step 3: Add tsconfig.json

```bash
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
EOF
```

### Step 4: Write the Plugin

```typescript
// src/index.ts
import type { Plugin, Action, Provider } from "@elizaos/core";

const greetAction: Action = {
  name: "GREET_USER",
  similes: ["SAY_HELLO", "WELCOME"],
  description: "Greets the user by name",
  validate: async () => true,
  handler: async (runtime, message, state, options) => {
    const name = options?.parameters?.name ?? "friend";
    return {
      success: true,
      text: `Hello, ${name}! Welcome to Eliza.`,
    };
  },
  parameters: [
    {
      name: "name",
      description: "Name of the person to greet",
      required: false,
      schema: { type: "string", default: "friend" },
    },
  ],
};

const statusProvider: Provider = {
  name: "myPluginStatus",
  get: async (runtime, message, state) => {
    return {
      text: "My plugin is active and running.",
    };
  },
};

const plugin: Plugin = {
  name: "my-plugin",
  description: "A local development plugin",
  actions: [greetAction],
  providers: [statusProvider],
  init: async (config, runtime) => {
    runtime.logger?.info("[my-plugin] Initialized successfully");
  },
};

export default plugin;
```

### Step 5: Install Dependencies and Build

```bash
cd ~/.eliza/plugins/custom/my-plugin
bun install
bun run build
```

### Step 6: Restart Eliza

```bash
# If running in terminal
eliza start

# Or restart via the agent chat
# Type: /restart
```

On startup, you should see in the logs:

```
[eliza] Discovered 1 custom plugin(s): my-plugin
```

---

## Configuration

### Allow and Deny Lists

Control which plugins load via `eliza.json`:

```json
{
  "plugins": {
    "allow": ["my-plugin", "telegram", "@elizaos/plugin-discord"],
    "deny": ["@elizaos/plugin-shell"]
  }
}
```

When `allow` is set, only listed plugins load (plus core plugins). The `deny` list always wins -- a denied plugin is never loaded even if it appears in `allow`.

Plugin names can be specified as:
- Full package name: `@elizaos/plugin-telegram`
- Short id: `telegram` (resolves to `@elizaos/plugin-telegram`)
- Custom name: `my-plugin` (matches the `name` field in your plugin's `package.json`)

### Per-Plugin Settings

Configure individual plugins under `plugins.entries`:

```json
{
  "plugins": {
    "entries": {
      "my-plugin": {
        "enabled": true,
        "config": {
          "apiEndpoint": "https://api.example.com",
          "maxRetries": 3
        }
      },
      "telegram": {
        "enabled": false
      }
    }
  }
}
```

Setting `enabled: false` on an entry prevents that plugin from loading, even if auto-enable logic would otherwise activate it.

### Auto-Enable System

Eliza automatically enables plugins based on your configuration:

- **Connector plugins**: If a connector (telegram, discord, slack, etc.) has credentials configured under `connectors`, its plugin is auto-enabled.
- **Provider plugins**: If an API key env var is set (e.g., `ANTHROPIC_API_KEY`), the corresponding provider plugin is auto-enabled.
- **Feature plugins**: If a feature flag is enabled under `features`, its plugin is auto-enabled.

This happens at startup via `applyPluginAutoEnable()` and does not modify your config file -- it only affects the in-memory plugin set for that session.

---

## Plugin Installer

The plugin installer (`plugin-installer.ts`) handles runtime installation of plugins from the registry.

### How It Works

1. **Resolves** the plugin name against the plugin registry
2. **Installs** via `bun add` (preferred) or `npm install` (fallback) into an isolated directory at `~/.eliza/plugins/installed/<sanitised-name>/`
3. **Falls back** to `git clone` if the npm install fails
4. **Validates** that the installed plugin has a resolvable entry point
5. **Records** the installation in `eliza.json` under `plugins.installs`
6. **Triggers** an agent restart to load the new plugin

### Package Name Sanitisation

The installer sanitises package names for directory names by replacing non-alphanumeric characters (except `.`, `-`, `_`) with underscores. For example, `@elizaos/plugin-x` becomes `_elizaos_plugin-twitter`.

### Install Record

Each installed plugin is tracked in `eliza.json`:

```json
{
  "plugins": {
    "installs": {
      "@elizaos/plugin-x": {
        "source": "npm",
        "spec": "@elizaos/plugin-x@1.0.0",
        "installPath": "/Users/you/.eliza/plugins/installed/_elizaos_plugin-twitter",
        "version": "1.0.0",
        "installedAt": "2026-02-19T12:00:00.000Z"
      }
    }
  }
}
```

### Serialisation

The installer uses a serialisation lock to prevent concurrent installs from corrupting the config. Multiple install requests are queued and executed sequentially.

### Uninstalling

Uninstallation removes the plugin directory from disk and deletes its record from `eliza.json`. Core/built-in plugins cannot be uninstalled. The uninstaller refuses to delete directories outside `~/.eliza/plugins/installed/` as a safety measure.

---

## Ejecting Upstream Plugins

The eject system lets you clone an upstream plugin's source, modify it, and have Eliza load your local copy instead of the npm package.

### Eject via Agent Chat

```
eject the telegram plugin so I can edit its source
```

### Eject Manually

```bash
git clone --branch 1.x --depth 1 \
  https://github.com/elizaos-plugins/plugin-telegram.git \
  ~/.eliza/plugins/ejected/plugin-telegram

cd ~/.eliza/plugins/ejected/plugin-telegram
bun install
bun run build
```

### Upstream Tracking

Each ejected plugin has a `.upstream.json` at its root:

```json
{
  "$schema": "eliza-upstream-v1",
  "source": "github:elizaos-plugins/plugin-telegram",
  "gitUrl": "https://github.com/elizaos-plugins/plugin-telegram.git",
  "branch": "1.x",
  "commitHash": "093613e...",
  "ejectedAt": "2026-02-19T08:00:00Z",
  "npmPackage": "@elizaos/plugin-telegram",
  "npmVersion": "1.6.4",
  "lastSyncAt": null,
  "localCommits": 0
}
```

### Syncing with Upstream

```bash
cd ~/.eliza/plugins/ejected/plugin-telegram
git fetch origin
git pull --rebase origin 1.x
bun run build
```

Or via agent chat: `sync the ejected telegram plugin`

### Reverting (Reinject)

Remove the ejected directory to fall back to the npm version:

```bash
rm -rf ~/.eliza/plugins/ejected/plugin-telegram
# Restart eliza -- it will load the npm version again
```

Or via agent chat: `reinject the telegram plugin`

---

## Development Workflow

### Edit-Build-Restart Cycle

The standard development loop for local plugins:

```bash
# Terminal 1: Watch and rebuild on changes
cd ~/.eliza/plugins/custom/my-plugin
bun run dev  # runs tsc --watch

# Terminal 2: Run eliza
eliza start
```

After making changes, the TypeScript watcher rebuilds `dist/` automatically. You still need to restart the agent to pick up the new build:

- Type `/restart` in the agent chat, or
- Press Ctrl+C and run `eliza start` again

### Testing Your Plugin

Chat with the agent and trigger your action:

```
You: Greet me as Alice
Agent: Hello, Alice! Welcome to Eliza.
```

Check the logs for your plugin's initialization message and any debug output.

### Quick Iteration Without tsc --watch

If you prefer manual builds:

```bash
cd ~/.eliza/plugins/custom/my-plugin
bun run build && eliza start
```

### Using Source Directly (Development Only)

For rapid prototyping, you can point `main` at the TypeScript source:

```json
{
  "main": "src/index.ts"
}
```

Eliza's runtime can import TypeScript files directly in dev mode. Switch to `dist/index.js` before distributing.

### Configuration-Driven Loading

Load a plugin from any path using `eliza.json`:

```json
{
  "plugins": {
    "entries": {
      "my-plugin": {
        "enabled": true,
        "path": "~/projects/my-plugin/dist"
      }
    }
  }
}
```

Path supports tilde expansion (`~/`) and both relative and absolute paths. This is useful when your plugin lives outside the standard plugin directories.

### Rapid Iteration Tips

1. **Use `LOG_LEVEL=debug`** to see plugin loading, discovery, and initialization logs
2. **Check plugin load order** in debug logs -- look for `Loading plugin: your-plugin-name`
3. **Test actions via chat** -- type messages that trigger your action's validate function
4. **Use the REST API** for programmatic testing:

```bash
# List loaded plugins
curl http://localhost:18789/api/plugins

# Search the registry
curl http://localhost:18789/api/registry/search?q=my-plugin
```

5. **Run multiple instances** with different configs using `ELIZA_STATE_DIR`:

```bash
# Instance with your dev plugin
ELIZA_STATE_DIR=./state-dev eliza start

# Instance with production plugins
ELIZA_STATE_DIR=./state-prod eliza start
```

---

## Debugging

### Log Levels

Eliza reads the log level from `LOG_LEVEL` env var or `logging.level` in config. If `LOG_LEVEL` is set in the environment, it takes precedence over the config value.

```bash
# Verbose logging via environment variable
LOG_LEVEL=debug eliza start
```

Or set it in `eliza.json`:

```json
{
  "logging": {
    "level": "debug"
  }
}
```

Available levels: `debug`, `info`, `warn`, `error` (default).

### Plugin Logging

Use the runtime logger inside your plugin:

```typescript
init: async (config, runtime) => {
  runtime.logger?.debug("[my-plugin] Detailed debug info", { config });
  runtime.logger?.info("[my-plugin] Plugin initialized");
  runtime.logger?.warn("[my-plugin] Something looks off");
  runtime.logger?.error("[my-plugin] Something failed", { error: "details" });
},
```

### Source Maps

Enable source maps for readable stack traces pointing to your TypeScript source:

```bash
NODE_OPTIONS="--enable-source-maps" eliza start
```

Make sure `"sourceMap": true` is set in your `tsconfig.json` (included in the template above).

### VS Code Debugging

Create `.vscode/launch.json` in your project:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Eliza",
      "runtimeExecutable": "bun",
      "runtimeArgs": ["run", "eliza", "start"],
      "cwd": "${workspaceFolder}",
      "env": {
        "LOG_LEVEL": "debug"
      },
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**"]
    }
  ]
}
```

Set breakpoints in your plugin's TypeScript files and launch with F5.

### Common Issues

**Plugin not discovered at startup:**
- Verify the plugin directory is directly under `~/.eliza/plugins/custom/` (not nested deeper)
- Confirm `package.json` exists and has a `name` field
- Check that `main` in `package.json` points to an existing file
- Look for `[eliza] Discovered N custom plugin(s)` in the startup logs

**Plugin discovered but fails to load:**
- Run `bun run build` -- the `dist/` directory may be missing
- Verify the default export is a valid Plugin object with `name` and `description`
- Check for import errors in the logs: `LOG_LEVEL=debug eliza start`

**Plugin denied or filtered out:**
- Check `plugins.deny` in `eliza.json` -- your plugin name may be listed
- If `plugins.allow` is set, your plugin must be in the allowlist
- Check `plugins.entries.<name>.enabled` is not set to `false`

**TypeScript compilation errors:**
```bash
cd ~/.eliza/plugins/custom/my-plugin
bun run tsc --noEmit  # Type-check without emitting
```

---

## Environment Variables

These environment variables affect plugin paths and behavior. They are defined in `eliza/packages/agent/src/config/paths.ts`.

| Variable | Default | Description |
|----------|---------|-------------|
| `ELIZA_STATE_DIR` | `~/.eliza` | Override the state directory. Changes where plugins, config, and credentials are stored. |
| `ELIZA_CONFIG_PATH` | `~/.eliza/eliza.json` | Override the config file path directly. |
| `ELIZA_OAUTH_DIR` | `~/.eliza/credentials` | Override the OAuth credentials directory. |
| `LOG_LEVEL` | `error` | Set log verbosity: `debug`, `info`, `warn`, `error`. |
| `ELIZA_DISABLE_WORKSPACE_PLUGIN_OVERRIDES` | unset | Set to `1` to disable workspace plugin overrides (dev-only mechanism). |
| `ELIZA_WORKSPACE_ROOT` | unset | Override the workspace root for plugin resolution. When set, only this directory is searched for local plugin sources. |

When `ELIZA_STATE_DIR` is set, all derived paths change accordingly:
- Plugins: `$ELIZA_STATE_DIR/plugins/installed/`, `$ELIZA_STATE_DIR/plugins/custom/`, `$ELIZA_STATE_DIR/plugins/ejected/`
- Config: `$ELIZA_STATE_DIR/eliza.json` (unless `ELIZA_CONFIG_PATH` is also set)
- Models cache: `$ELIZA_STATE_DIR/models/`

---

## Migrating to npm

When your plugin is ready for distribution:

### 1. Update package.json

```json
{
  "name": "@yourorg/plugin-my-feature",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "bun run build"
  },
  "peerDependencies": {
    "@elizaos/core": ">=2.0.0"
  }
}
```

### 2. Build and Publish

```bash
cd ~/.eliza/plugins/custom/my-plugin
bun run build
npm pack              # Preview what gets published
npm publish --access public
```

### 3. Install via Eliza

Once published, install through the agent chat or directly in config:

```json
{
  "plugins": {
    "allow": ["@yourorg/plugin-my-feature"]
  }
}
```

Remove the local copy from `~/.eliza/plugins/custom/` to avoid loading both versions.

---

## Next Steps

- [Plugin Development Guide](/plugins/development) -- Full plugin API reference
- [Skills Documentation](/plugins/skills) -- Lighter-weight extensions
- [Contributing Guide](/guides/contributing) -- Contributing plugins upstream
