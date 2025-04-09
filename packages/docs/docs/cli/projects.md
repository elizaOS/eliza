---
sidebar_position: 6
---

# Project Command

The `project` command helps you manage ElizaOS projects, including their plugins and configurations.

## Usage

```bash
elizaos project <action> [options]
```

## Actions

| Action          | Description                                        |
| --------------- | -------------------------------------------------- |
| `list-plugins`  | List available plugins to install into the project |
| `add-plugin`    | Add a plugin to the project                        |
| `remove-plugin` | Remove a plugin from the project                   |

## Managing Plugins

### Listing Available Plugins

View all plugins that are available to install:

```bash
elizaos project list-plugins
```

You can filter the results by type:

```bash
elizaos project list-plugins --type adapter
```

### Options for list-plugins

| Option              | Description                              |
| ------------------- | ---------------------------------------- |
| `-t, --type <type>` | Filter by type (adapter, client, plugin) |

### Adding Plugins

Add a plugin to your project:

```bash
elizaos project add-plugin @elizaos/plugin-discord
```

This will:

1. Find the plugin in the registry
2. Install the plugin into your project
3. Add it to your project's dependencies

### Options for add-plugin

| Option            | Description                              |
| ----------------- | ---------------------------------------- |
| `--no-env-prompt` | Skip prompting for environment variables |

### Removing Plugins

Remove a plugin from your project:

```bash
elizaos project remove-plugin @elizaos/plugin-discord
```

This will:

1. Uninstall the plugin from your project
2. Remove it from your project's dependencies

## Examples

### Discovering and installing plugins

```bash
# List all available plugins
elizaos project list-plugins

# Install a specific plugin
elizaos project add-plugin @elizaos/plugin-telegram
```

### Managing multiple plugins

```bash
# Add multiple plugins
elizaos project add-plugin @elizaos/plugin-discord
elizaos project add-plugin @elizaos/plugin-pdf

# Remove a plugin you no longer need
elizaos project remove-plugin @elizaos/plugin-pdf
```

## Plugin Configuration

After adding a plugin, you'll need to configure it in your project's code:

```typescript
// In your src/index.ts file
import { createProject } from '@elizaos/core';
import { discordPlugin } from '@elizaos/plugin-discord';

const project = createProject({
  name: 'my-project',
  plugins: [
    discordPlugin, // Use the imported plugin
  ],
  // Plugin-specific configuration
  discord: {
    token: process.env.DISCORD_BOT_TOKEN,
    guildId: process.env.DISCORD_GUILD_ID,
  },
});

export default project;
```

For more information about plugin development and structure, see:

- [Plugin Command](./plugins.md): Managing plugin publishing
- [Quickstart Guide](../quickstart.md): Project and plugin structure
- [Dev Command](./dev.md): Running projects with plugins

## Troubleshooting

### Plugin Not Found

If a plugin can't be found in the registry:

```
Plugin @elizaos/plugin-name not found in registry
```

Check for:

1. Typos in the plugin name
2. Network connectivity issues
3. Registry availability

### Installation Problems

If a plugin fails to install:

1. Check that you have the necessary permissions
2. Ensure you have a stable internet connection
3. Check for compatibility issues with your project

## Related Commands

- [`create`](./create.md): Create a new project from scratch
- [`plugin`](./plugins.md): Manage plugin publishing
- [`start`](./start.md): Start your project
- [`dev`](./dev.md): Run your project in development mode
