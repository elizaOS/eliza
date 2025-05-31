---
sidebar_position: 4
title: Plugin Management
description: Manage ElizaOS plugins within a project - list, add, remove
keywords: [plugins, extensions, packages, npm, registry, installation, configuration]
image: /img/cli.jpg
---

# Plugin Command

Manage ElizaOS plugins.

## Usage

```bash
elizaos plugins [options] [command]
```

## Subcommands

| Subcommand          | Aliases   | Description                                             | Arguments                                                                 | Options                                                                                   |
| ------------------- | --------- | ------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `list`              | `l`       | List available plugins to install into the project      |                                                                           | `--all` (detailed version info), `--v0` (v0.x compatible only)                            |
| `add`               | `install` | Add a plugin to the project                             | `<plugin>` (plugins name e.g., "abc", "plugin-abc", "elizaos/plugin-abc") | `-n, --no-env-prompt`, `-b, --branch <branchName>` (default: main), `-T, --tag <tagname>` |
| `update`            | `refresh` | Fetch the latest plugin registry and update local cache |                                                                           |                                                                                           |
| `installed-plugins` |           | List plugins found in the project dependencies          |                                                                           |                                                                                           |
| `remove`            | `delete`  | Remove a plugins from the project                       | `<plugin>` (plugins name e.g., "abc", "plugin-abc", "elizaos/plugin-abc") |                                                                                           |

## Examples

### Listing Available Plugins

```bash
# List all available plugins
elizaos plugins list

# Using alias
elizaos plugins l

# List all plugins with detailed version information
elizaos plugins list --all

# List only v0.x compatible plugins
elizaos plugins list --v0
```

### Adding Plugins

```bash
# Add a plugin by short name (looks up '@elizaos/plugin-openai')
elizaos plugins add openai

# Add a plugin by full package name
elizaos plugins add @elizaos/plugin-anthropic

# Add plugin and skip environment variable prompts
elizaos plugins add google-ai --no-env-prompt

# Add plugin from specific branch (for monorepo development)
elizaos plugins add custom-plugin --branch feature/new-api

# Add a specific version/tag of a plugin from npm
elizaos plugins add elevenlabs --tag latest

# Install plugin directly from GitHub (HTTPS URL)
elizaos plugins add https://github.com/owner/my-plugin

# Install from GitHub with branch reference
elizaos plugins add https://github.com/owner/my-plugin/tree/feature-branch

# Install using GitHub shorthand syntax
elizaos plugins add github:owner/my-plugin

# Install specific branch using GitHub shorthand
elizaos plugins add github:owner/my-plugin#feature-branch

# Using alias
elizaos plugins install openai
```

### Updating Plugin Registry

```bash
# Fetch latest plugin registry and update local cache
elizaos plugins update

# Using alias
elizaos plugins refresh
```

**When to run this:**

- You see "Plugin cache is empty or not found" messages
- Want to get the latest available plugins
- Plugin installation fails due to outdated registry cache

### Listing Installed Plugins

```bash
# Show plugins currently in your project's package.json
elizaos plugins installed-plugins
```

### Removing Plugins

```bash
# Remove plugin by short name
elizaos plugins remove openai

# Remove plugin by full package name
elizaos plugins remove @elizaos/plugin-anthropic

# Using alias
elizaos plugins delete openai
```

## Plugin Installation Formats

The `add` command supports multiple plugin formats:

### Package Names

```bash
# Short name (auto-resolves to @elizaos/plugin-*)
elizaos plugins add openai

# Full package name
elizaos plugins add @elizaos/plugin-openai

# Scoped packages
elizaos plugins add @company/plugin-custom
```

### GitHub Integration

```bash
# HTTPS URL
elizaos plugins add https://github.com/user/my-plugin

# GitHub shorthand
elizaos plugins add github:user/my-plugin

# With branch/tag
elizaos plugins add github:user/my-plugin#feature-branch
```

### Version Control

```bash
# Specific npm tag
elizaos plugins add plugin-name --tag beta

# Development branch (for monorepo)
elizaos plugins add plugin-name --branch main
```

## Plugin Development Workflow

### 1. Create a Plugin

```bash
elizaos create -t plugin my-awesome-plugin
cd plugin-my-awesome-plugin
```

### 2. Install in Your Project

```bash
# During development, install from local directory
elizaos plugins add ./path/to/plugin-my-awesome-plugin

# Or install from your development branch
elizaos plugins add my-awesome-plugin --branch feature/new-feature
```

### 3. Test Your Plugin

```bash
# Start development mode
elizaos dev

# Run tests
elizaos test
```

### 4. Publish Your Plugin

```bash
# Test publishing process
elizaos publish --test

# Publish to registry
elizaos publish
```

## Troubleshooting

### Plugin Installation Failures

```bash
# If plugin cache is empty or corrupted
elizaos plugins update

# Clear cache and retry
rm -rf ~/.eliza/cache
elizaos plugins update
elizaos plugins add plugin-name
```

### Network Issues

```bash
# For GitHub authentication problems
git config --global credential.helper store

# For npm registry issues
bun config set registry https://registry.npmjs.org/
elizaos plugins add plugin-name
```

### Plugin Not Found

```bash
# Check exact plugin name in registry
elizaos plugins list

# Try different naming formats
elizaos plugins add openai                    # Short name
elizaos plugins add @elizaos/plugin-openai   # Full package name
elizaos plugins add plugin-openai            # With plugin prefix
```

### Dependency Conflicts

```bash
# If dependency installation fails
cd your-project
bun install

# Check for conflicting dependencies
bun pm ls

# Force reinstall
rm -rf node_modules
bun install
```

### Environment Variable Issues

```bash
# If plugin prompts for missing environment variables
elizaos env set OPENAI_API_KEY your-key

# Skip environment prompts during installation
elizaos plugins add plugin-name --no-env-prompt
```

### Branch/Tag Issues

```bash
# If branch doesn't exist
git ls-remote --heads https://github.com/user/repo

# If tag doesn't exist
git ls-remote --tags https://github.com/user/repo

# Use correct branch/tag name
elizaos plugins add plugin-name --branch main
elizaos plugins add plugin-name --tag v1.0.0
```

## Related Commands

- [`create`](./create.md): Create a new project or plugin
- [`env`](./env.md): Manage environment variables needed by plugins
- [`publish`](./publish.md): Publish your plugin to the registry
