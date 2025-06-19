---
sidebar_position: 10
title: Publish Command
description: Publish a plugin to npm, GitHub, and the registry
keywords: [CLI, publish, registry, npm, GitHub, packages, distribution]
image: /img/cli.jpg
---
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Publish Command

Publish a plugin to the registry.

<Tabs>
<TabItem value="overview" label="Overview & Options" default>

## Usage

```bash
elizaos publish [options]
```

## Options

| Option                 | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `--npm`                | Publish to npm instead of GitHub                   |
| `-t, --test`           | Test publish process without making changes        |
| `-d, --dry-run`        | Generate registry files locally without publishing |
| `-sr, --skip-registry` | Skip publishing to the registry                    |

</TabItem>
<TabItem value="examples" label="Examples">

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
</TabItem>
<TabItem value="guides" label="Guides & Concepts">

## Publishing Modes

### Default: GitHub + Registry Publishing

This is the standard mode, executed by running `elizaos publish`. It will:
- Publishes your package to npm.
- Creates or updates a GitHub repository for source code access.
- Submits your plugin to the ElizaOS registry for discoverability.

### npm-Only Publishing

Using the `--npm` flag publishes only to the npm registry, skipping the GitHub and ElizaOS registry steps. This is useful for private packages or when managing the GitHub repository separately.

## Publishing Process

When you run the `publish` command, ElizaOS performs the following steps:
1. **Check CLI version** and prompt for updates if needed.
2. **Validate plugin structure** and `package.json` requirements.
3. **Update `package.json`** with actual values, replacing placeholders.
4. **Get authentication credentials** for npm and GitHub.
5. **Build the package** by running `npm run build`.
6. **Publish to npm** via `npm publish --ignore-scripts`.
7. **Create GitHub repository** (unless `--npm` flag is used).
8. **Submit to registry** (unless `--npm` or `--skip-registry` flags are used).

## Development Workflow

A typical plugin development and publishing lifecycle looks like this:

1.  **Create and Develop Plugin**
    ```bash
    elizaos create -t plugin my-awesome-plugin
    cd my-awesome-plugin
    bun install
    elizaos dev # Develop and test your plugin
    elizaos test # Run formal tests
    ```

2.  **Prepare for Publishing**
    ```bash
    # Test the publish process
    elizaos publish --test
    # Verify package.json and required images
    ls images/
    cat package.json
    ```

3.  **Publish Plugin**
    ```bash
    # Login to npm
    npm login
    # Publish to GitHub + registry (recommended)
    elizaos publish
    ```

## Post-Publishing Updates

**Important**: The `elizaos publish` command is designed for **initial plugin publishing only**. After your plugin is in the registry, use standard `npm` and `git` workflows for updates.

- **Direct updates**: `npm publish` directly updates your package on npm.
- **Version control**: Standard `git` workflows maintain proper version history.
- **Tool compatibility**: Works with all standard development tools and CI/CD pipelines.
- **Registry sync**: The ElizaOS registry automatically syncs with npm for version updates.

</TabItem>
<TabItem value="requirements" label="Requirements">

## Authentication Requirements

Publishing requires authentication for both npm and GitHub.

### npm Authentication

You must be logged into npm. Run `npm login` if you are not.

### GitHub Authentication

A GitHub token is required for repository creation and registry submission. You can either:
1. Set the `GITHUB_TOKEN` environment variable.
2. Enter your GitHub Personal Access Token (PAT) when prompted.

Your PAT should have these scopes: `repo`, `read:org`, and `workflow`.

## Plugin Requirements

Before publishing, ensure your plugin's `package.json` and directory structure meet the requirements.

### `package.json` Configuration
Your `package.json` must be configured correctly, including fields like `name`, `description`, `version`, and a special `agentConfig` section. The `publish` command will help auto-fill placeholders.

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

For details on getting your plugin into the official registry, review the [ElizaOS Plugin Registry Pull Request Template](https://github.com/elizaos-plugins/registry/blob/main/.github/pull_request_template.md).

</TabItem>
<TabItem value="troubleshooting" label="Troubleshooting">

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

## Related Commands

- [`create`](./create.md): Create a new plugin to publish
- [`plugins`](./plugins.md): Manage and discover published plugins
- [`test`](./test.md): Test your plugin before publishing
- [`env`](./env.md): Configure environment variables for publishing
</TabItem>
</Tabs>
