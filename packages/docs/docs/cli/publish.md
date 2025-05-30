---
sidebar_position: 10
title: Publish Command
description: Publish a plugin to npm, GitHub, and the registry
keywords: [CLI, publish, registry, npm, GitHub, packages, distribution]
image: /img/cli.jpg
---

# Publish Command

Publish a plugin to the registry.

## Usage

```bash
elizaos publish [options]
```

## Options

| Option                 | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `-n, --npm`            | Publish to npm instead of GitHub                   |
| `-t, --test`           | Test publish process without making changes        |
| `-d, --dry-run`        | Generate registry files locally without publishing |
| `-sr, --skip-registry` | Skip publishing to the registry                    |

## Examples

### Basic Publishing

```bash
# Navigate to your plugin directory
cd my-plugin

# Publish to GitHub and registry (default)
elizaos publish

# Publish to npm instead of GitHub
elizaos publish --npm
```

### Testing and Validation

```bash
# Test the publish process without making changes
elizaos publish --test

# Generate registry files locally without publishing
elizaos publish --dry-run

# Publish but skip registry submission
elizaos publish --skip-registry
```

### Combined Options

```bash
# Test npm publishing
elizaos publish --test --npm

# Test publishing while skipping registry
elizaos publish --test --skip-registry
```

## Publishing Modes

### Default: GitHub + Registry Publishing

```bash
elizaos publish
```

This mode:

- Publishes your package to npm
- Creates/updates a GitHub repository for source code access
- Submits your plugin to the ElizaOS registry for discoverability

### npm Publishing

```bash
elizaos publish --npm
```

This mode:

- Publishes only to npm
- Skips GitHub repository creation
- Skips registry submission
- Useful for private packages or when you want to manage GitHub separately

## Authentication Requirements

Publishing requires authentication for both npm and GitHub:

### npm Authentication

You must be logged into npm:

```bash
npm login
```

### GitHub Authentication

GitHub authentication is required for repository creation and registry submission. You can set your GitHub token in one of two ways:

1. Set the `GITHUB_TOKEN` environment variable
2. When prompted, enter your GitHub Personal Access Token (PAT)

Your GitHub PAT should have these scopes:

- `repo` (for repository access)
- `read:org` (for organization access)
- `workflow` (for workflow access)

## Plugin Requirements

Before publishing, ensure your plugin meets these requirements:

### Package.json Configuration

```json
{
  "name": "@npm-username/plugin-name",
  "description": "${PLUGINDESCRIPTION}",
  "version": "1.0.0-beta.74",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "packageType": "plugin",
  "platform": "node",
  "license": "UNLICENSED",
  "author": "${GITHUB_USERNAME}",
  "keywords": ["plugin", "elizaos"],
  "repository": {
    "type": "git",
    "url": "${REPO_URL}"
  },
  "homepage": "https://elizaos.ai",
  "bugs": {
    "url": "https://github.com/${GITHUB_USERNAME}/${PLUGINNAME}/issues"
  },
  "agentConfig": {
    "pluginType": "elizaos:plugin:1.0.0",
    "pluginParameters": {
      "API_KEY": {
        "type": "string",
        "description": "API key for the service"
      }
    }
  },
  "publishConfig": {
    "access": "public"
  }
}
```

### Required Files and Directories

| Requirement          | Description                                       | Validation   |
| -------------------- | ------------------------------------------------- | ------------ |
| **Plugin Name**      | Must include 'plugin-' (e.g., `plugin-example`)   | Auto-checked |
| **Images Directory** | Must have an `images/` directory                  | Auto-created |
| **Logo Image**       | `images/logo.jpg` - 400x400px square (max 500KB)  | Auto-checked |
| **Banner Image**     | `images/banner.jpg` - 1280x640px banner (max 1MB) | Auto-checked |
| **Agent Config**     | Must include `agentConfig` in package.json        | Auto-fixed   |
| **Description**      | Meaningful description (10+ characters)           | Prompted     |
| **Repository URL**   | Must use `github:` format                         | Auto-fixed   |

### Registry Publishing Criteria

Before submitting your plugin to the registry, review the detailed publishing criteria and requirements at the [ElizaOS Plugin Registry Pull Request Template](https://github.com/elizaos-plugins/registry/blob/main/.github/pull_request_template.md). This template contains comprehensive guidelines for plugin submission and acceptance.

## Publishing Process

When you run the `publish` command, ElizaOS will:

1. **Check CLI version** and prompt for updates if needed
2. **Validate plugin structure** and requirements
3. **Update package.json** with actual values (replacing placeholders)
4. **Get authentication credentials** for npm and GitHub
5. **Build the package** (run `npm run build`)
6. **Publish to npm** with `npm publish --ignore-scripts`
7. **Create GitHub repository** (unless `--npm` flag is used)
8. **Submit to registry** (unless `--npm` or `--skip-registry` flags are used)

## Package.json Placeholder Replacement

The publish command automatically replaces placeholders in your package.json:

| Placeholder            | Replaced With              | Example                          |
| ---------------------- | -------------------------- | -------------------------------- |
| `npm-username`         | Your npm username          | `@username/plugin-example`       |
| `plugin-name`          | Your plugin directory name | `plugin-example`                 |
| `${PLUGINDESCRIPTION}` | Auto-generated description | `ElizaOS plugin for example`     |
| `${REPO_URL}`          | GitHub repository URL      | `github:username/plugin-example` |
| `${GITHUB_USERNAME}`   | Your GitHub username       | `username`                       |

## Registry Integration

### Automatic Registry Submission

When publishing with the default command, ElizaOS automatically:

- Creates a Pull Request to add your plugin to the official registry
- Makes your plugin discoverable via `elizaos plugins list`
- Provides metadata for the plugin marketplace

### Registry Requirements

To be accepted into the registry, your plugin must have:

- **Public repository** with `elizaos-plugins` topic
- **Required images** (logo.jpg and banner.jpg)
- **Proper naming** convention (plugin-\*)
- **Agent configuration** in package.json
- **Meaningful description** (not default generated text)

## Development Workflow

### 1. Create and Develop Plugin

```bash
# Create new plugin
elizaos create -t plugin my-awesome-plugin
cd my-awesome-plugin

# Install dependencies
bun install

# Develop your plugin
elizaos dev

# Test thoroughly
elizaos test
```

### 2. Prepare for Publishing

```bash
# Test the publish process
elizaos publish --test

# Check requirements
ls images/  # Should contain logo.jpg and banner.jpg
cat package.json  # Verify all fields are correct
```

### 3. Publish Plugin

```bash
# Login to npm
npm login

# Publish to GitHub + registry (recommended)
elizaos publish

# Or publish to npm only
elizaos publish --npm
```

## Testing Before Publishing

### Test Mode

```bash
elizaos publish --test
```

Test mode validates:

- Package structure and naming
- Required files and directories
- npm and GitHub authentication
- Build process without publishing

### Dry Run Mode

```bash
elizaos publish --dry-run
```

Dry run mode:

- Generates registry metadata files locally
- Creates files in `packages/registry/` directory
- Shows what would be submitted to registry
- Does not publish or create PRs

## Post-Publishing Updates

**Important**: The `elizaos publish` command is designed for **initial plugin publishing only**. After your plugin is published to the registry, all continuous maintenance and updates should be managed through standard GitHub and npm workflows.

### Standard Update Process

```bash
# 1. Make changes and test
elizaos test

# 2. Update version
npm version patch  # or minor/major

# 3. Publish to npm
npm publish

# 4. Push to GitHub
git push origin main
git push --tags
```

### Why Use Standard Workflows?

- **Direct updates**: `npm publish` directly updates your package on npm
- **Version control**: Standard git workflows maintain proper version history
- **Tool compatibility**: Works with all standard development tools and CI/CD
- **Registry sync**: The ElizaOS registry automatically syncs with npm updates

**Only use `elizaos publish` for:**

- Initial plugin publishing and registry submission
- Setting up the initial GitHub repository structure

**Use standard npm/GitHub workflows for:**

- Version updates and bug fixes
- Feature additions and improvements
- All ongoing maintenance and development

## Troubleshooting

### Authentication Issues

```bash
# npm login problems
npm logout
npm login

# GitHub token issues
# Set environment variable:
export GITHUB_TOKEN=your_token_here

# Or re-enter when prompted
elizaos publish
```

### Package Validation Failures

```bash
# Check package structure
elizaos publish --test

# Common issues:
# - Plugin name must start with "plugin-"
# - Missing images/logo.jpg (400x400px, max 500KB)
# - Missing images/banner.jpg (1280x640px, max 1MB)
# - Repository URL format (use github:username/repo)
```

### Build Failures

```bash
# Check build process
npm run build

# Install missing dependencies
bun install

# Check TypeScript errors
bun i && bun run build
```

### Registry Submission Issues

```bash
# Test registry generation
elizaos publish --dry-run

# Check generated files
ls packages/registry/

# Skip registry if having issues
elizaos publish --skip-registry
```

### CLI Version Issues

```bash
# Update CLI before publishing
elizaos update

# Check current version
elizaos --version
```

## Related Commands

- [`create`](./create.md): Create a new plugin to publish
- [`plugins`](./plugins.md): Manage and discover published plugins
- [`test`](./test.md): Test your plugin before publishing
- [`env`](./env.md): Configure environment variables for publishing
