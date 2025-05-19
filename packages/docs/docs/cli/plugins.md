---
sidebar_position: 4
title: Plugin Management
description: Manage ElizaOS plugins within a project - list, add, remove
keywords: [plugins, extensions, packages, npm, registry, installation, configuration]
image: /img/cli.jpg
---

# Plugin Command

The `plugins` command helps developers manage ElizaOS plugins within a project, allowing you to list, add, remove, and inspect installed plugins.

## Subcommands

| Subcommand          | Aliases               | Description                                        | Arguments                                                                | Options                                                                                         |
| ------------------- | --------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `list`              | `l`, `ls`             | List available plugins to install into the project |                                                                          |                                                                                                 |
| `add`               | `install`             | Add a plugin to the project                        | `<plugin>` (Plugin name e.g., "abc", "plugin-abc", "elizaos/plugin-abc") | `-n, --no-env-prompt`, `-b, --branch <branchName>` (default: v2-develop), `-T, --tag <tagname>` |
| `installed-plugins` |                       | List plugins found in project dependencies         |                                                                          |                                                                                                 |
| `remove`            | `delete`, `del`, `rm` | Remove a plugin from the project                   | `<plugin>` (Plugin name e.g., "abc", "plugin-abc", "elizaos/plugin-abc") |                                                                                                 |

## Examples

### Listing Available Plugins

```bash
# List all available plugins
elizaos plugins list
```

## Plugin Development Workflow

### 1. Create a Plugin

Start by creating a new plugin:

```bash
elizaos create -t plugin my-plugin
```

This creates a starter plugin with the required directory structure.

### 2. Develop Your Plugin

(This section refers to adding/managing plugins, for actual development guidance, see plugin development docs.)

The plugin structure typically includes:

- `src/index.ts` - Main plugin code
- `src/plugin.ts` - Plugin configuration and initialization
- `src/metadata.ts` - Plugin metadata (name, description, etc.)

Examples of adding plugins:

```bash
# Add the 'openai' plugin (will look up '@elizaos/plugin-openai')
elizaos plugins add openai

# Add a specific plugin by full name
elizaos plugins add @elizaos/plugin-anthropic

# Add a plugin and skip environment variable prompts
elizaos plugins add google-ai --no-env-prompt

# Add a plugin from a specific branch (for monorepo source installs)
elizaos plugins add custom-plugin --branch feature/new-api

# Add a specific version/tag of a plugin from npm
elizaos plugins add elevenlabs --tag beta
```

### Listing Installed Plugins

```bash
# Show plugins currently listed in package.json
elizaos plugins installed-plugins
```

### Removing a Plugin

```bash
# Remove the 'openai' plugin
elizaos plugins remove openai

# Remove a plugin by its full name
elizaos plugins remove @elizaos/plugin-anthropic
```

## Related Commands

- [`create`](./create.md): Create a new project or plugin.
- [`env`](./env.md): Manage environment variables needed by plugins.
