---
sidebar_position: 10
title: Publish Command
description: Package and publish your ElizaOS plugins or projects to make them available to others. By default, it publishes to GitHub. You can choose to publish to npm instead using the `--npm` flag. For plugins, it can also facilitate submission to the ElizaOS registry.
keywords: [CLI, publish, registry, npm, GitHub, packages, distribution]
image: /img/cli.jpg
---

# Publish Command

The `publish` command allows you to package and publish your ElizaOS plugins or projects. By default, it publishes to GitHub. You can choose to publish to npm instead using the `--npm` flag. For plugins, it can also facilitate submission to the ElizaOS registry.

## Usage

```bash
elizaos publish [options]
```

## Options

| Option                      | Description                                               |
| --------------------------- | --------------------------------------------------------- |
| `-t, --test`                | Run publish tests without actually publishing             |
| `-n, --npm`                 | Publish to npm                                            |
| `-s, --skip-registry`       | Skip publishing to the registry                           |
| `-p, --platform <platform>` | Specify platform compatibility (node, browser, universal) |
| `--dry-run`                 | Generate registry files locally without publishing        |
| `--no-banner`               | Skip display of startup banner                            |
| `--debug`                   | Enable debug logging                                      |

## GitHub Authentication

Publishing to GitHub (the default target) requires authentication. You can set your GitHub token in one of two ways:

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
4. Get GitHub credentials (if publishing to GitHub).
5. Build the package (e.g., run `npm run build`).
6. Publish to the target (GitHub by default, or npm if `--npm` is used).
7. For plugins published to GitHub, create a Pull Request to add it to the ElizaOS registry (unless `--skip-registry` is used).

### Project Type Detection

ElizaOS automatically detects if your package is a plugin or project based on `package.json` conventions (e.g., name containing `plugin-`).

## Platform Compatibility

You can specify the platform compatibility of your package in `package.json` or potentially via flags if supported.

```bash
# Example: Specify universal compatibility in package.json (preferred)
# "platform": "universal"

# Example: Specify via flag (if available, check command help)
# elizaos publish --platform universal
```

## Publishing Targets

### Publishing to GitHub (Default)

```bash
# Publish the current project/plugin to GitHub
elizaos publish
```

This creates/updates a GitHub repository and, for plugins, initiates registry submission.

### Publishing to npm

Make your component available on the npm registry:

```bash
# Ensure you are logged into npm
npm login

# Publish to npm
elizaos publish --npm
```

Note: Publishing plugins to npm currently requires manual steps to get them added to the ElizaOS registry.

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

When publishing plugins to GitHub (default), ElizaOS attempts to create a Pull Request to add your plugin to the official registry, making it discoverable via `elizaos plugins list`.

To skip this step:

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

# Test your plugin
elizaos test
```

### 3. Meet Registry Requirements

Before publishing (especially if aiming for the registry), ensure your plugin meets all requirements:

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
# Publish to GitHub (default) and submit to registry
elizaos publish

# Or publish to npm (manual registry submission needed later)
# npm login
# elizaos publish --npm
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

## Examples (Reiteration)

### Publishing a Plugin to GitHub & Registry

```bash
cd my-plugin
elizaos publish
```

### Publishing to npm (No Automatic Registry Submission)

```bash
cd my-package
npm login
elizaos publish --npm
```

### Testing the Publishing Process

```bash
elizaos publish --test
```

## Troubleshooting

### Authentication Issues

- **npm**: Run `npm login`.
- **GitHub**: Check your `GITHUB_TOKEN` environment variable or re-enter your PAT when prompted. Ensure the PAT has the correct scopes (`repo`, `read:org`, `workflow`).

### Package Validation Failures

- Carefully check the output of `elizaos publish --test`.
- Ensure `package.json` is correct (name format, description, repository URL, `agentConfig`).
- Verify image dimensions and file sizes.
- Make sure the GitHub repository is public and has the `elizaos-plugins` topic.
