---
sidebar_position: 10
title: Publish Command
description: Package and publish your ElizaOS plugins or projects to npm, GitHub, and the registry. By default, it publishes to all three destinations. You can use the `--npm` flag to publish to npm only.
keywords: [CLI, publish, registry, npm, GitHub, packages, distribution]
image: /img/cli.jpg
---

# Publish Command

The `publish` command allows you to package and publish your ElizaOS plugins or projects. By default, it publishes to npm, GitHub, and the ElizaOS registry in one command. You can use the `--npm` flag to publish to npm only.

## Usage

```bash
# Publish to npm + GitHub + registry (default)
elizaos publish

# Publish to npm only
elizaos publish --npm
```

## Options

| Option                      | Description                                               |
| --------------------------- | --------------------------------------------------------- |
| `-t, --test`                | Run publish tests without actually publishing             |
| `-n, --npm`                 | Publish to npm only (skip GitHub and registry)            |
| `-s, --skip-registry`       | Skip publishing to the registry                           |
| `-p, --platform <platform>` | Specify platform compatibility (node, browser, universal) |
| `--dry-run`                 | Generate registry files locally without publishing        |
| `--no-banner`               | Skip display of startup banner                            |
| `--debug`                   | Enable debug logging                                      |

## Authentication Requirements

Publishing requires authentication for both npm and GitHub:

### npm Authentication

You must be logged into npm:

```bash
npm login
```

### GitHub Authentication

GitHub authentication is required for repository creation and registry submission. You can set your GitHub token in one of two ways:

1. Set the `GITHUB_TOKEN` environment variable.
2. When prompted, enter your GitHub Personal Access Token (PAT).

Your GitHub PAT should have these scopes:

- `repo` (for repository access)
- `read:org` (for organization access)
- `workflow` (for workflow access)

## Publishing Process

When you run the `publish` command, ElizaOS will:

1. Check the CLI version and prompt for updates if needed.
2. Detect if your package is a plugin or project.
3. Validate the package structure and configuration against requirements (see below).
4. Get npm and GitHub credentials.
5. Build the package (e.g., run `npm run build`).
6. Publish to npm.
7. Publish to GitHub (unless `--npm` flag is used).
8. For plugins, create a Pull Request to add it to the ElizaOS registry (unless `--npm` or `--skip-registry` flags are used).

### Project Type Detection

ElizaOS automatically detects if your package is a plugin or project based on `package.json` conventions (e.g., name containing `plugin-`).

## Platform Compatibility

You can specify the platform compatibility of your package in `package.json`:

```json
{
  "platform": "universal"
}
```

## Publishing Modes

### Default: Complete Publishing (npm + GitHub + registry)

```bash
# Publish to all destinations
elizaos publish
```

This is the recommended approach as it:

- Publishes your package to npm for easy installation
- Creates/updates a GitHub repository for source code access
- Submits your plugin to the ElizaOS registry for discoverability

### npm Only Publishing

```bash
# Publish to npm only
elizaos publish --npm
```

This mode:

- Publishes only to npm
- Skips GitHub repository creation
- Skips registry submission
- Useful for private packages or when you want to manage GitHub separately

## Testing Before Publishing

### Test Mode

Run validations without actually publishing:

```bash
elizaos publish --test
```

This checks requirements, credentials, and the build process.

### Dry Run

Generate registry metadata files locally without submitting:

```bash
elizaos publish --dry-run
```

## Registry Integration (for Plugins)

When publishing plugins with the default command, ElizaOS automatically creates a Pull Request to add your plugin to the official registry, making it discoverable via `elizaos plugins list`.

To skip registry submission while still publishing to npm and GitHub:

```bash
elizaos publish --skip-registry
```

## Plugin Development and Publishing Workflow

### 1. Create a Plugin

```bash
elizaos create -t plugin my-awesome-plugin
cd my-awesome-plugin
```

### 2. Develop and Test

```bash
# Install dependencies
bun install

# Develop your plugin (edit src/, etc.)
elizaos dev

# Test your plugin thoroughly
elizaos test

# Test specific components if needed
elizaos test component  # Component tests only
elizaos test e2e       # End-to-end tests only
```

### 3. Meet Registry Requirements

Before publishing, ensure your plugin meets all requirements:

#### Registry Requirements Checklist

| Name                      | Requirement                                                       | Validation                         |
| ------------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| **Name**                  | Must include 'plugin-' (e.g., '@elizaos/plugin-example')          | Auto-checked                       |
| **GitHub Repository**     | URL must use `github:` format (e.g., `github:username/repo-name`) | Auto-checked & can be auto-fixed   |
| **Repository Visibility** | Repository must be public                                         | Manual check                       |
| **Repository Topics**     | Should have 'elizaos-plugins' in topics                           | Manual check                       |
| **Images Directory**      | Must have an `images/` directory                                  | Auto-checked & can be auto-created |
| **Logo Image**            | `images/logo.jpg` - 400x400px square logo (max 500KB)             | Auto-checked                       |
| **Banner Image**          | `images/banner.jpg` - 1280x640px banner image (max 1MB)           | Auto-checked                       |
| **Agent Configuration**   | Must include `agentConfig` in package.json                        | Auto-checked & can be auto-fixed   |
| **Description**           | Meaningful description in package.json (10+ chars)                | Auto-checked & prompted            |
| **Directory Structure**   | Standard plugin directory structure                               | Auto-checked                       |

The `elizaos publish --test` command will check these requirements and guide you through fixes.

### 4. Test Publishing Process

```bash
elizaos publish --test
```

Address any issues reported by the test run.

### 5. Publish Your Plugin

```bash
# Login to npm first
npm login

# Final test run before publishing
elizaos test

# Publish to npm + GitHub + registry (recommended)
elizaos publish

# Or publish to npm only (if you want to manage GitHub separately)
elizaos publish --npm
```

After submission to the registry via Pull Request, your plugin will be reviewed by the ElizaOS team.

## Plugin Configuration (`package.json`)

Key fields in your plugin's `package.json`:

```json
{
  "name": "@elizaos/plugin-example",
  "description": "Description of your plugin (10+ chars)",
  "version": "0.1.0",
  "repository": {
    "type": "git",
    "url": "github:your-username/plugin-example" // Use github: prefix
  },
  "agentConfig": {
    // Required for registry
    "pluginType": "elizaos:plugin:1.0.0",
    "pluginParameters": {
      "API_KEY": {
        "type": "string",
        "description": "API key for the service"
      }
      // Add other required parameters
    }
  },
  "keywords": ["elizaos-plugins", "other", "tags"],
  "maintainers": ["your-username"]
  // ... other standard package.json fields
}
```

The `agentConfig` section defines parameters your plugin requires, prompting users during installation.

## GitHub Repository Requirements

For publishing to GitHub and registry submission:

1. Repository must be **public**.
2. Include `elizaos-plugins` in the repository **topics**.
3. Have a detailed `README.md`.
4. Include a license file.

## Images Requirements

Place the following in an `images/` directory in your plugin's root:

- `logo.jpg`: 400x400px square logo (max 500KB)
- `banner.jpg`: 1280x640px banner image (max 1MB)

These are used in the ElizaOS registry and UI.

## Examples

### Complete Publishing (Recommended)

```bash
cd my-plugin
npm login
elizaos publish
```

This publishes to npm, creates a GitHub repository, and submits to the registry.

### npm Only Publishing

```bash
cd my-package
npm login
elizaos publish --npm
```

This publishes only to npm, useful for private packages or when managing GitHub separately.

### Testing the Publishing Process

```bash
elizaos publish --test
```

## Continuous Development

**Important**: The `elizaos publish` command is designed for initial publishing. After your plugin is published, use standard npm and git workflows for updates.

### Standard Update Workflow

1. **Make changes to your plugin**
2. **Test your changes thoroughly**:
   ```bash
   elizaos test  # Run all tests to ensure quality
   ```
3. **Update version using npm**:
   ```bash
   npm version patch  # or minor/major
   ```
4. **Publish to npm**:
   ```bash
   npm publish
   ```
5. **Push to GitHub**:
   ```bash
   git push origin main
   git push --tags
   ```

### Why Use Standard Workflows?

- **Direct updates**: `npm publish` directly updates your package on npm
- **Version control**: Standard git workflows maintain proper version history
- **Tool compatibility**: Works with all standard development tools and CI/CD pipelines
- **Registry sync**: The ElizaOS registry automatically syncs with npm updates

The `elizaos publish` command should only be used for:

- Initial plugin publishing
- Setting up the initial GitHub repository
- Initial registry submission

## Troubleshooting

### Authentication Issues

- **npm**: Run `npm login` before publishing.
- **GitHub**: Check your `GITHUB_TOKEN` environment variable or re-enter your PAT when prompted. Ensure the PAT has the correct scopes (`repo`, `read:org`, `workflow`).

### Package Validation Failures

- Carefully check the output of `elizaos publish --test`.
- Ensure `package.json` is correct (name format, description, repository URL, `agentConfig`).
- Verify image dimensions and file sizes.
- Make sure the GitHub repository is public and has the `elizaos-plugins` topic.

### Recursion Issues

If you encounter issues with the publish command running multiple times, this is typically resolved by the CLI's built-in recursion prevention. The CLI uses `npm publish --ignore-scripts` to prevent the npm publish script from triggering the ElizaOS publish command again.
