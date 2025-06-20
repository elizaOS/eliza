---
sidebar_position: 11
title: Update Command
description: Update your project's ElizaOS dependencies and CLI to the latest published versions
keywords: [CLI, update, dependencies, versions, packages, maintenance]
image: /img/cli.jpg
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Update Command

Update ElizaOS CLI and project dependencies.

<Tabs>
<TabItem value="overview" label="Overview & Options" default>

## Usage

```bash
elizaos update [options]
```

## Options

| Option              | Description                                                         |
| ------------------- | ------------------------------------------------------------------- |
| `-c, --check`       | Check for available updates without applying them                   |
| `-sb, --skip-build` | Skip building after updating                                        |
| `--cli`             | Update only the global CLI installation (without updating packages) |
| `--packages`        | Update only packages (without updating the CLI)                     |

</TabItem>
<TabItem value="examples" label="Examples">

### Basic Update

```bash
# Update both CLI and project dependencies (default behavior)
elizaos update
```

### Checking for Updates

```bash
# Check for available updates without applying them
elizaos update --check
```

_Example Output:_

```bash
$ elizaos update --check

Checking for updates...
Current CLI version: 1.3.5
Latest CLI version: 1.4.0

ElizaOS packages that can be updated:
  - @elizaos/core (1.3.0) → 1.4.0
  - @elizaos/plugin-openai (1.2.5) → 1.4.0

To apply updates, run: elizaos update
```

### Scoped Updates

```bash
# Update only the global CLI
elizaos update --cli

# Update only project packages
elizaos update --packages
```

### Combined Options

```bash
# Check only for CLI updates
elizaos update --check --cli

# Update packages without rebuilding afterward
elizaos update --packages --skip-build
```

</TabItem>
<TabItem value="guides" label="Guides & Concepts">

## Update Process Explained

When you run `elizaos update`, it performs the following steps:

1.  **Detects Project Type**: Determines if you're in an ElizaOS project or plugin.
2.  **Checks CLI Version**: Compares your installed CLI version with the latest available on npm.
3.  **Scans Dependencies**: Finds all `@elizaos/*` packages in your project's `package.json`.
4.  **Shows Update Plan**: Lists the packages and/or CLI that have available updates.
5.  **Prompts for Confirmation**: Asks for your approval before making any changes.
6.  **Updates Packages**: Installs the latest versions of the packages.
7.  **Rebuilds Project**: Compiles the updated dependencies (unless `--skip-build` is used).

### Workspace & Monorepo Support

The update command is smart enough to detect monorepo workspaces. It will automatically skip any packages that are linked via `workspace:*` in your `package.json`, as these should be managed within the monorepo, not from the npm registry.

## Best Practices

### Safe Update Process

For the smoothest update experience, follow this sequence:

1.  **Check what will be updated**: `elizaos update --check`
2.  **Commit your current work**: `git commit -am "chore: pre-update savepoint"`
3.  **Update the CLI first**: `elizaos update --cli`
4.  **Then, update project packages**: `elizaos update --packages`
5.  **Test your project thoroughly**: `elizaos test`

</TabItem>
<TabItem value="troubleshooting" label="Troubleshooting">

## Troubleshooting

### CLI Update Issues

If you have trouble updating the global CLI:

```bash
# Check if the CLI is installed globally
bun pm ls -g @elizaos/cli

# If not, install it
bun install -g @elizaos/cli

# On macOS/Linux, you may need sudo
sudo bun install -g @elizaos/cli
# Or fix permissions on your bun directory
sudo chown -R $(whoami) ~/.bun
```

### Package Update Failures

If package updates fail, a clean reinstall usually fixes it:

```bash
# Clear caches and old dependencies
rm -rf node_modules
bun pm cache rm
rm bun.lockb

# Reinstall everything
bun install
```

### Build Failures After Update

If your project fails to build after an update:

```bash
# Try a clean build
bun run build

# Or try updating without the build step, then build manually
elizaos update --skip-build
bun install && bun run build
```

</TabItem>
</Tabs>

## Project Detection

The update command automatically detects:

- **ElizaOS Projects**: Updates project dependencies and rebuilds
- **ElizaOS Plugins**: Updates plugin dependencies and rebuilds
- **Non-ElizaOS Projects**: Shows error message

## Workspace Support

### Monorepo Detection

- Automatically detects workspace references
- Skips packages with `workspace:*` versions
- Shows which packages are workspace-managed

### Example with Workspaces

```bash
$ elizaos update --check

ElizaOS packages found:
  - @elizaos/core (workspace:*) → Skipped (workspace reference)
  - @elizaos/plugin-openai (1.2.5) → 1.4.0
  - @elizaos/plugin-discord (workspace:*) → Skipped (workspace reference)

Only non-workspace packages will be updated.
```

## Version Strategy

### Staying Current

- Update regularly to get latest features and fixes
- Use `--check` to monitor available updates
- Subscribe to ElizaOS release notes

### Stability Considerations

- Test updates in development before production
- Consider pinning versions for production deployments
- Review changelogs for breaking changes

## Related Commands

- [`create`](./create.md): Create new projects with latest versions
- [`start`](./start.md): Start your updated project
- [`dev`](./dev.md): Run in development mode after updates
- [`test`](./test.md): Test your project after updates
