---
sidebar_position: 10
title: Publish Command
description: Package and publish your ElizaOS plugins and projects to make them available to others
keywords: [CLI, publish, registry, npm, GitHub, packages, distribution]
image: /img/cli.jpg
---

# Publish Command

The `publish` command allows you to package and publish your ElizaOS plugins or projects to the ElizaOS registry and npm, making them available for others to use.

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

## Publishing Process

When you run the `publish` command, ElizaOS will:

1. Detect if your package is a plugin or project
2. Validate the package structure and configuration
3. Check for GitHub credentials (if publishing to GitHub)
4. Build the package
5. Publish to npm or GitHub based on options
6. Update the ElizaOS registry with your package metadata

### Project Type Detection

ElizaOS automatically detects if your package is a plugin or project by:

- Checking if the package name contains `plugin-`
- Looking for type definitions in `package.json`
- Analyzing the package exports
- Examining the package description

For plugins, the package name should include `plugin-` (e.g., `@elizaos/plugin-discord`).

## Platform Compatibility

You can specify the platform compatibility of your package:

```bash
# Specify that your plugin works in Node.js only
elizaos publish -p node

# Specify that your plugin works in browsers only
elizaos publish -p browser

# Specify that your plugin works everywhere (default)
elizaos publish -p universal
```

## Publishing Targets

### Publishing to npm

Make your component available on the npm registry:

```bash
elizaos publish -n
```

Before publishing to npm, make sure you're logged in:

```bash
npm login
```

### Publishing to GitHub

By default, packages are published to GitHub:

```bash
elizaos publish
```

This requires GitHub credentials, which can be provided in two ways:

1. Set the `GITHUB_TOKEN` environment variable
2. Enter your GitHub Personal Access Token when prompted

Your GitHub token needs these permissions:

- `repo` (for repository access)
- `read:org` (for organization access)
- `workflow` (for workflow access)

## Testing Before Publishing

### Test Mode

Run tests without actually publishing:

```bash
elizaos publish -t
```

This will:

1. Validate the package structure
2. Check your GitHub credentials
3. Test the build process
4. Not actually publish anything

### Dry Run

Generate registry files locally without publishing:

```bash
elizaos publish --dry-run
```

This creates the registry metadata files locally for inspection.

## Registry Integration

By default, your package will be submitted to the ElizaOS registry when publishing. This makes it discoverable by other ElizaOS users.

If you don't want to publish to the registry:

```bash
elizaos publish --skip-registry
```

## Examples

### Publishing a Plugin to GitHub

```bash
# Navigate to plugin directory
cd my-plugin

# Publish to GitHub
elizaos publish
```

### Publishing to npm

```bash
# Navigate to your package directory
cd my-package

# Publish to npm
elizaos publish -n
```

### Testing the Publishing Process

```bash
# Test the publishing process without making changes
elizaos publish -t
```

### Publishing with Platform Specification

```bash
# Publish a Node.js plugin
elizaos publish -p node
```

## Troubleshooting

### Authentication Issues

If you encounter authentication errors:

```bash
# For npm publishing
npm login

# For GitHub publishing, the CLI will guide you through setting up credentials
```

### Package Validation Failures

If your package fails validation:

1. Ensure your `package.json` contains name, version, and description
2. For plugins, ensure the name includes `plugin-`
3. Make sure your package has a proper entry point
