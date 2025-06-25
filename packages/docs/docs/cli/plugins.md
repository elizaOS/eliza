---
sidebar_position: 4
title: Plugin Management
description: Manage ElizaOS plugins within a project - list, add, remove
keywords: [plugins, extensions, packages, npm, registry, installation, configuration]
image: /img/cli.jpg
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Plugin Command

Manage ElizaOS plugins.

<Tabs>
<TabItem value="overview" label="Overview & Options" default>

## Usage

```bash
elizaos plugins [options] [command]
```

## Subcommands

| Subcommand          | Aliases               | Description                                                                        | Arguments                                                                 | Options                                                                           |
| ------------------- | --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `list`              | `l`, `ls`             | List available plugins in the registry (shows v1.x plugins by default)             |                                                                           | `--all` (detailed version info), `--v0` (v0.x compatible only)                    |
| `add`               | `install`             | Add a plugin to character file(s)                                                  | `<plugin>` (plugins name e.g., "abc", "plugin-abc", "elizaos/plugin-abc") | `-c, --character <paths...>`, `-s, --skip-env-prompt`, `--skip-verification`     |
| `installed-plugins` |                       | List plugins found in character files                                              |                                                                           | `-c, --character <paths...>`                                                      |
| `remove`            | `delete`, `del`, `rm` | Remove a plugin from character file(s)                                             | `<plugin>` (plugins name e.g., "abc", "plugin-abc", "elizaos/plugin-abc") | `-c, --character <paths...>`                                                      |
| `upgrade`           |                       | Upgrade a plugin from version 0.x to 1.x using AI-powered migration                | `<path>` (GitHub repository URL or local folder path)                     | `--api-key`, `--skip-tests`, `--skip-validation`                                  |
| `generate`          |                       | Generate a new plugin using AI-powered code generation                             |                                                                           | `--api-key`, `--skip-tests`, `--skip-validation`, `--skip-prompts`, `--spec-file` |

</TabItem>
<TabItem value="examples" label="Examples">

### Listing Available Plugins

```bash
# List available v1.x plugins (default behavior)
elizaos plugins list

# Using alias
elizaos plugins l

# List all plugins with detailed version information
elizaos plugins list --all

# List only v0.x compatible plugins
elizaos plugins list --v0
```

### Adding Plugins to Characters

```bash
# Add a plugin to a specific character file
elizaos plugins add openai --character assistant.json

# Add to multiple character files
elizaos plugins add @elizaos/plugin-anthropic --character assistant.json chatbot.json

# Add plugin and skip environment variable prompts
elizaos plugins add google-ai --character mybot.json --skip-env-prompt

# Skip plugin verification after adding
elizaos plugins add discord --character agent.json --skip-verification

# Using alias
elizaos plugins install openai --character assistant.json
```

### Listing Installed Plugins

```bash
# Show plugins in specific character files
elizaos plugins installed-plugins --character assistant.json

# Check multiple character files
elizaos plugins installed-plugins --character assistant.json chatbot.json
```

### Removing Plugins

```bash
# Remove plugin from a character file
elizaos plugins remove openai --character assistant.json

# Remove from multiple character files
elizaos plugins remove @elizaos/plugin-anthropic --character assistant.json chatbot.json

# Using aliases
elizaos plugins delete openai --character mybot.json
elizaos plugins del twitter --character agent.json
elizaos plugins rm discord --character bot.json
```

### Upgrading Plugins (AI-Powered)

```bash
# Upgrade a plugin from v0.x to v1.x using AI migration
elizaos plugins upgrade https://github.com/user/plugin-v0

# Upgrade from local folder
elizaos plugins upgrade ./path/to/old-plugin

# Provide API key directly
elizaos plugins upgrade ./my-plugin --api-key sk-ant-...

# Skip test validation
elizaos plugins upgrade ./my-plugin --skip-tests

# Skip production readiness validation
elizaos plugins upgrade ./my-plugin --skip-validation

# Run upgrade with all skips (faster but less safe)
elizaos plugins upgrade ./my-plugin --skip-tests --skip-validation
```

### Generating New Plugins (AI-Powered)

```bash
# Generate a new plugin interactively
elizaos plugins generate

# Generate with API key directly
elizaos plugins generate --api-key sk-ant-...

# Generate from specification file (non-interactive)
elizaos plugins generate --spec-file ./plugin-spec.json --skip-prompts

# Skip test validation during generation
elizaos plugins generate --skip-tests

# Skip production readiness validation
elizaos plugins generate --skip-validation
```

</TabItem>
<TabItem value="guides" label="Guides & Concepts">

## Character-Centric Plugin Architecture

ElizaOS uses a character-centric approach to plugin management. Plugins are specified in character files, not installed at the project level. This allows each character to have its own set of capabilities.

### How It Works

1. **Character Configuration**: Each character file specifies its required plugins
2. **Runtime Loading**: When starting an agent, the runtime loads plugins from the character's configuration
3. **Automatic Installation**: Missing plugins are automatically installed when needed
4. **Isolation**: Different characters can use different plugin versions

### Character File Example

```json
{
  "name": "MyAssistant",
  "plugins": [
    "@elizaos/plugin-openai",
    "@elizaos/plugin-discord",
    "./path/to/local/plugin"
  ],
  "settings": {
    // Character-specific settings
  }
}
```

## Plugin Formats

The `add` command supports multiple plugin formats:

### Package Names

```bash
# Short name (auto-resolves to @elizaos/plugin-*)
elizaos plugins add openai --character bot.json

# Full package name
elizaos plugins add @elizaos/plugin-openai --character bot.json

# Scoped packages
elizaos plugins add @company/plugin-custom --character bot.json
```

### Local Plugins

```bash
# Add local plugin (useful during development)
elizaos plugins add ./path/to/my-plugin --character bot.json

# Relative paths are supported
elizaos plugins add ../my-plugin --character bot.json
```

## Plugin Development Workflow

### 1. Create a Plugin

```bash
# Create plugin in current directory
elizaos create -t plugin my-awesome-plugin
cd plugin-my-awesome-plugin

# Or create plugin within your project
cd my-project
elizaos create -t plugin my-awesome-plugin
```

### 2. Add to Your Character

```bash
# During development, add from local directory
elizaos plugins add ./plugin-my-awesome-plugin --character assistant.json

# Or manually edit character file:
{
  "plugins": [
    "./plugin-my-awesome-plugin"
  ]
}
```

### 3. Test Your Plugin

```bash
# Start development mode with your character
elizaos dev --character assistant.json

# Run tests
elizaos test
```

### 4. Publish Your Plugin

For detailed instructions on authentication, plugin requirements, and the full publishing process, see the [**`publish` command documentation**](./publish.md).

```bash
# Test the publishing process before committing
elizaos publish --test

# Publish to the registry
elizaos publish
```

## AI-Powered Plugin Development

ElizaOS includes AI-powered features to help with plugin development:

### Plugin Generation

The `generate` command uses AI to create a new plugin based on your specifications:

1. **Interactive Mode**: Guides you through plugin requirements
2. **Code Generation**: Creates complete plugin structure with actions, providers, and tests
3. **Validation**: Ensures generated code follows ElizaOS best practices

### Plugin Migration

The `upgrade` command helps migrate v0.x plugins to v1.x format:

1. **Automated Analysis**: Analyzes existing plugin structure
2. **Code Transformation**: Updates APIs, imports, and patterns
3. **Test Migration**: Converts tests to new format
4. **Validation**: Ensures migrated plugin works correctly

### Requirements

Both AI features require an Anthropic API key:

- Set via environment: `export ANTHROPIC_API_KEY=sk-ant-...`
- Or pass directly: `--api-key sk-ant-...`

</TabItem>
<TabItem value="troubleshooting" label="Troubleshooting">

## Troubleshooting

### Character File Issues

```bash
# Verify character file exists
ls *.json

# Check character file syntax
cat character.json | jq .

# View current plugins in character
cat character.json | jq .plugins
```

### Plugin Not Found

```bash
# Check exact plugin name in registry
elizaos plugins list

# Try different naming formats
elizaos plugins add openai --character bot.json                    # Short name
elizaos plugins add @elizaos/plugin-openai --character bot.json   # Full package name
elizaos plugins add plugin-openai --character bot.json            # With plugin prefix
```

### Runtime Plugin Loading

```bash
# If plugins fail to load at runtime
# Check character file
cat character.json | jq .plugins

# Verify network connectivity (for auto-install)
ping npmjs.com

# Clear bun cache
bun pm cache rm

# Try starting with verbose logging
elizaos start --character character.json
```

### Local Plugin Development

```bash
# Ensure plugin is built
cd ./my-local-plugin
bun run build

# Check plugin exports
cat ./my-local-plugin/package.json | jq .main

# Verify path in character file
cat character.json | jq '.plugins[] | select(. | startswith("./"))'
```

### Environment Variable Issues

```bash
# If plugin requires environment variables
elizaos env list

# Set required variables
elizaos env set OPENAI_API_KEY your-key

# Skip environment prompts when adding
elizaos plugins add plugin-name --character bot.json --skip-env-prompt
```

### AI Feature Issues

```bash
# Missing API key error
export ANTHROPIC_API_KEY=sk-ant-your-key-here

# Or pass directly to command
elizaos plugins generate --api-key sk-ant-your-key-here

# Invalid specification file
# Ensure spec file is valid JSON
cat plugin-spec.json | jq .

# Generation/Upgrade timeout
# Skip validation for faster iteration
elizaos plugins generate --skip-tests --skip-validation

# Out of memory during AI operations
# Increase Node.js memory limit
NODE_OPTIONS="--max-old-space-size=8192" elizaos plugins upgrade ./my-plugin
```

## Related Commands

- [`create`](./create.md): Create a new project or plugin
- [`env`](./env.md): Manage environment variables needed by plugins
- [`publish`](./publish.md): Publish your plugin to the registry
- [`start`](./start.md): Start agents with character-defined plugins
- [`dev`](./dev.md): Develop and test plugins locally

</TabItem>
</Tabs>
