---
sidebar_position: 10
---

# Publish Command

The `publish` command allows you to package and publish your ElizaOS plugins or projects to the ElizaOS registry and npm, making them available for others to use.

## Usage

```bash
npx @elizaos/cli publish [options]
```

## Options

| Option                      | Description                                               |
| --------------------------- | --------------------------------------------------------- |
| `-r, --registry <registry>` | Target registry (default: "elizaOS/registry")             |
| `-n, --npm`                 | Publish to npm instead of GitHub                          |
| `-t, --test`                | Test publish process without making changes               |
| `-p, --platform <platform>` | Specify platform compatibility (node, browser, universal) |
| `--dry-run`                 | Generate registry files locally without publishing        |
| `--skip-registry`           | Skip publishing to the registry                           |

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
npx @elizaos/cli publish -p node

# Specify that your plugin works in browsers only
npx @elizaos/cli publish -p browser

# Specify that your plugin works everywhere (default)
npx @elizaos/cli publish -p universal
```

## Publishing Targets

### Publishing to npm

Make your component available on the npm registry:

```bash
npx @elizaos/cli publish -n
```

Before publishing to npm, make sure you're logged in:

```bash
npm login
```

### Publishing to GitHub

By default, packages are published to GitHub:

```bash
npx @elizaos/cli publish
```

This requires GitHub credentials, which you'll be prompted for if not already configured.

## Testing Before Publishing

### Test Mode

Run tests without actually publishing:

```bash
npx @elizaos/cli publish -t
```

This will:

1. Validate the package structure
2. Check your GitHub credentials
3. Test the build process
4. Not actually publish anything

### Dry Run

Generate registry files locally without publishing:

```bash
npx @elizaos/cli publish --dry-run
```

This creates the registry metadata files locally for inspection.

## Registry Integration

By default, your package will be submitted to the ElizaOS registry when publishing. This makes it discoverable by other ElizaOS users.

If you don't want to publish to the registry:

```bash
npx @elizaos/cli publish --skip-registry
```

## Examples

### Publishing a Plugin to GitHub

```bash
# Navigate to plugin directory
cd my-plugin

# Publish to GitHub
npx @elizaos/cli publish
```

### Publishing to npm

```bash
# Navigate to your package directory
cd my-package

# Publish to npm
npx @elizaos/cli publish -n
```

### Testing the Publishing Process

```bash
# Test the publishing process without making changes
npx @elizaos/cli publish -t
```

### Publishing with Platform Specification

```bash
# Publish a Node.js plugin
npx @elizaos/cli publish -p node
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

## Related Commands

- [`plugin`](./plugins.md): Manage plugin publishing
- [`project`](./projects.md): Manage projects
