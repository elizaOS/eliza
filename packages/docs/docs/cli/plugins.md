---
sidebar_position: 5
---

# Plugin Command

The `plugin` command helps you manage ElizaOS plugins - modular extensions that add capabilities to your agents.

## Usage

```bash
npx @elizaos/cli plugin <action> [options]
```

## Actions

| Action    | Description                    |
| --------- | ------------------------------ |
| `publish` | Publish a plugin to a registry |

## Publishing Plugins

The `publish` command allows you to publish an ElizaOS plugin to a registry:

```bash
npx @elizaos/cli plugin publish [options]
```

### Options

| Option                      | Description                                               |
| --------------------------- | --------------------------------------------------------- |
| `-r, --registry <registry>` | Target registry (default: "elizaOS/registry")             |
| `-n, --npm`                 | Publish to npm instead of GitHub                          |
| `-t, --test`                | Test publish process without making changes               |
| `-p, --platform <platform>` | Specify platform compatibility (node, browser, universal) |

### Publishing Process

When you run the `publish` command, ElizaOS will:

1. Validate that you're in a plugin directory
2. Check for required GitHub credentials
3. Validate the plugin package.json
4. Build the plugin
5. Publish to the specified registry (GitHub by default, or npm if specified)

### Examples

#### Test Publishing

Test the publishing process without actually publishing:

```bash
npx @elizaos/cli plugin publish --test
```

#### Publishing to npm

Publish your plugin to npm:

```bash
# First make sure you're logged in to npm
npm login

# Then publish
npx @elizaos/cli plugin publish --npm
```

#### Publishing with Platform Specification

Specify platform compatibility when publishing:

```bash
npx @elizaos/cli plugin publish --platform node
```

## Creating a Plugin

To create a new plugin, use the general `create` command with the plugin type:

```bash
npx @elizaos/cli create --type plugin
```

This will guide you through the process of creating a new plugin project with the proper structure.

## Plugin Structure

A typical ElizaOS plugin has this structure:

```
my-plugin/
├── src/
│   └── index.ts        # Plugin entry point
├── dist/               # Compiled code (generated)
├── package.json        # Plugin metadata and dependencies
└── tsconfig.json       # TypeScript configuration
```

The main plugin definition is in `src/index.ts`:

```typescript
import type { Plugin } from '@elizaos/core';

export const myPlugin: Plugin = {
  name: 'my-plugin',
  description: 'My custom plugin for ElizaOS',

  // Plugin components
  actions: [],
  services: [],
  providers: [],
  models: {},

  // Initialization function
  async init(config) {
    // Setup code
  },
};

export default myPlugin;
```

## Requirements for Publishing

Before publishing a plugin, ensure:

1. Your plugin name should include `plugin-` (e.g., `@elizaos/plugin-discord`)
2. A complete package.json with name, version, and description
3. GitHub credentials if publishing to the ElizaOS registry
4. npm login if publishing to npm

## Related Commands

- [`create`](./create.md): Create a new plugin
- [`project list-plugins`](./projects.md): List available plugins to install
- [`project add-plugin`](./projects.md): Add a plugin to your project
- [`project remove-plugin`](./projects.md): Remove a plugin from your project
