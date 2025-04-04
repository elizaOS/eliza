---
sidebar_position: 4
title: Plugin Management
description: Manage ElizaOS plugins - installation, configuration, and publishing
keywords: [plugins, extensions, packages, npm, registry, installation, configuration]
image: /img/cli.jpg
---

# Plugin Command

The `plugin` command helps developers manage ElizaOS plugins, focusing on the publishing process.

## Subcommands

### `publish`

Publishes a plugin to the ElizaOS registry or npm.

```bash
elizaos plugin publish [options]
```

Options:

- `-r, --registry <registry>` - Target registry (default: 'elizaOS/registry')
- `-n, --npm` - Publish to npm instead of GitHub (default: false)
- `-t, --test` - Test publish process without making changes (default: false)
- `-p, --platform <platform>` - Specify platform compatibility: node, browser, or universal (default: 'universal')

## Plugin Development Workflow

### 1. Create a Plugin

Start by creating a new plugin:

```bash
elizaos create -t plugin my-plugin
```

This creates a starter plugin with the required directory structure.

### 2. Develop Your Plugin

The plugin structure includes:

- `src/index.ts` - Main plugin code
- `src/plugin.ts` - Plugin configuration and initialization
- `src/metadata.ts` - Plugin metadata (name, description, etc.)

Run development mode to test your plugin:

```bash
cd my-plugin
elizaos dev
```

### 3. Meet Registry Requirements

Before publishing, ensure your plugin meets all registry requirements:

#### Registry Requirements Checklist

- **Name**: Must include 'plugin-' (e.g., '@elizaos/plugin-example')
- **GitHub Repository**:
  - Repository URL in package.json must use `github:` format (e.g., `github:username/repo-name`)
  - Repository must be public
  - Repository must have 'elizaos-plugins' in topics
- **Images**:
  - Must have an `images/` directory containing:
    - `logo.jpg` - 400x400px square logo (max 500KB)
    - `banner.jpg` - 1280x640px banner image (max 1MB)
- **Agent Configuration**:
  - Must include `agentConfig` in package.json defining plugin parameters
- **Documentation**:
  - Proper README.md with description and usage instructions

### 4. Test Publishing Process

Run the test publish process to check for any issues:

```bash
elizaos plugin publish --test
```

The CLI will check all registry requirements and help you fix any issues.

### 5. Publish Your Plugin

When your plugin is ready:

```bash
elizaos plugin publish
```

This will:

1. Validate all registry requirements
2. Create or update necessary files
3. Submit your plugin to the ElizaOS registry via a pull request

## Complete Plugin Development Workflow

Here's the complete process for developing and publishing an ElizaOS plugin:

```bash
# Create a new plugin
elizaos create -t plugin my-awesome-plugin
cd my-awesome-plugin

# Install dependencies (if needed)
npm install

# Develop your plugin
# Edit files in src/ directory
elizaos dev

# Test your plugin
elizaos test

# Prepare for publishing
# 1. Create GitHub repository (if not already done)
# 2. Add required images to images/ directory
# 3. Ensure package.json has correct repository URL and agentConfig

# Test the publishing process
elizaos plugin publish --test

# Publish to registry
elizaos plugin publish
```

After submission, your plugin will be reviewed by the ElizaOS team before being added to the registry.

## Plugin Configuration

Your plugin's `package.json` must include the following:

```json
{
  "name": "@elizaos/plugin-example",
  "description": "Description of your plugin",
  "repository": {
    "type": "git",
    "url": "github:username/plugin-example"
  },
  "agentConfig": {
    "pluginType": "elizaos:plugin:1.0.0",
    "pluginParameters": {
      "API_KEY": {
        "type": "string",
        "description": "API key for the service"
      }
    }
  }
}
```

The `agentConfig` section defines any parameters your plugin requires, which will be prompted when users install your plugin.

## GitHub Repository Requirements

Your plugin's GitHub repository should:

1. Be public
2. Include "elizaos-plugins" in the repository topics
3. Have a detailed README.md explaining your plugin's functionality
4. Include proper license information

## Images Requirements

Your plugin must include:

- `images/logo.jpg` - A 400x400px square logo (max 500KB)
- `images/banner.jpg` - A 1280x640px banner image (max 1MB)

These images will be displayed in the ElizaOS plugin registry and UI.

## Related Commands

- [`create`](./create.md): Create a new plugin
- [`project`](./projects.md): Add plugins to projects
- [Quickstart Guide](../quickstart.md): Project and plugin structure
