---
sidebar_position: 4
title: Plugin Management
description: Manage ElizaOS plugins within a project - list, add, remove
keywords: [plugins, extensions, packages, npm, registry, installation, configuration]
image: /img/cli.jpg
---

# Plugin Command

The `plugins` command helps you manage ElizaOS plugins within your project. You can list available plugins, add them to your project, see which ones are installed, and remove them.

## Subcommands

| Subcommand          | Aliases               | Description                                | Arguments  | Options                                                                   |
| ------------------- | --------------------- | ------------------------------------------ | ---------- | ------------------------------------------------------------------------- |
| `list`              | `l`, `ls`             | List available plugins from the registry   |            | `-t, --type <type>`                                                       |
| `add`               | `install`             | Add a plugin to the project                | `<plugin>` | `-n, --no-env-prompt`, `-b, --branch <branchName>`, `-T, --tag <tagname>` |
| `installed-plugins` |                       | List plugins found in project dependencies |            |                                                                           |
| `remove`            | `delete`, `del`, `rm` | Remove a plugin from the project           | `<plugin>` |                                                                           |

## Examples

### Listing Available Plugins

```bash
# List all available plugins
elizaos plugins list

# List only adapter plugins
elizaos plugins list --type adapter
```

### Adding a Plugin

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
