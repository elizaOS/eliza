---
sidebar_position: 11
title: Update Command
description: Update your project's ElizaOS dependencies and CLI to the latest published versions
keywords: [CLI, update, dependencies, versions, packages, maintenance]
image: /img/cli.jpg
---

# Update Command

Update ElizaOS CLI and project dependencies.

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

## Examples

### Basic Update

```bash
# Update both CLI and project dependencies (default)
elizaos update

# Update with confirmation of what will be updated
elizaos update
```

### Update Options

```bash
# Check for available updates without applying them
elizaos update --check

# Update only the global CLI
elizaos update --cli

# Update only project packages
elizaos update --packages

# Update without rebuilding afterward
elizaos update --skip-build
```

### Combined Options

```bash
# Check only CLI updates
elizaos update --check --cli

# Update packages without building
elizaos update --packages --skip-build

# Check packages only
elizaos update --check --packages
```

## Update Process

### Default Behavior

When you run `elizaos update` without options:

1. **Detects Project Type**: Determines if you're in an ElizaOS project or plugin
2. **Checks CLI Version**: Compares installed CLI with latest available
3. **Scans Dependencies**: Finds all `@elizaos/*` packages in package.json
4. **Shows Update Plan**: Lists what will be updated
5. **Prompts for Confirmation**: Asks before proceeding with updates
6. **Updates Packages**: Installs latest versions
7. **Rebuilds Project**: Compiles updated dependencies (unless `--skip-build`)

### CLI-Only Updates

```bash
elizaos update --cli
```

1. **Checks Global Installation**: Verifies CLI is installed globally
2. **Compares Versions**: Current vs latest available
3. **Updates CLI**: Installs latest version globally
4. **Confirms Update**: Shows success status

### Package-Only Updates

```bash
elizaos update --packages
```

1. **Scans Project**: Identifies ElizaOS dependencies
2. **Checks Versions**: Compares with latest available
3. **Updates Dependencies**: Installs latest versions
4. **Rebuilds**: Compiles project (unless `--skip-build`)

## Project Detection

The update command automatically detects:

- **ElizaOS Projects**: Updates project dependencies and rebuilds
- **ElizaOS Plugins**: Updates plugin dependencies and rebuilds
- **Non-ElizaOS Projects**: Shows error message

## Version Handling

### Package Selection

- Updates all `@elizaos/*` packages in dependencies and devDependencies
- Skips workspace references (e.g., `workspace:*`)
- Updates to the same version as the latest CLI

### Version Constraints

- Respects existing version prefixes (`^`, `~`, exact)
- Updates to latest published version on npm
- Handles pre-release versions appropriately

## Examples Output

### Check Mode

```bash
$ elizaos update --check

Checking for updates...
Current CLI version: 1.3.5
Latest CLI version: 1.4.0

ElizaOS packages that can be updated:
  - @elizaos/core (1.3.0) → 1.4.0
  - @elizaos/plugin-openai (1.2.5) → 1.4.0
  - @elizaos/plugin-discord (1.1.8) → 1.4.0

To apply updates, run: elizaos update
```

### CLI Update

```bash
$ elizaos update --cli

Updating ElizaOS CLI...
Current version: 1.3.5
Latest version: 1.4.0
✓ Successfully updated to 1.4.0
Please restart your terminal for changes to take effect.
```

### Package Update

```bash
$ elizaos update --packages

Updating project dependencies...
Found 3 ElizaOS packages to update:
  - @elizaos/core: 1.3.0 → 1.4.0
  - @elizaos/plugin-openai: 1.2.5 → 1.4.0
  - @elizaos/plugin-discord: 1.1.8 → 1.4.0

Proceed with update? (Y/n) Y
✓ Updated dependencies
✓ Installing packages...
✓ Building project...
Update completed successfully!
```

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

## Troubleshooting

### CLI Update Issues

```bash
# Check if CLI is installed globally
npm list -g @elizaos/cli

# Install CLI globally if needed
npm install -g @elizaos/cli

# Update with administrator privileges (if needed)
sudo npm install -g @elizaos/cli
```

### Package Update Failures

```bash
# Clear package manager cache
bun pm cache rm
rm -rf node_modules
bun i && bun run build

# Update with fresh installation
elizaos update --packages
```

### Build Failures After Update

```bash
# Check for TypeScript errors
bun run build

# Update with build skip, then manual build
elizaos update --skip-build
bun i && bun run build
```

### Dependency Resolution Issues

```bash
# Check for conflicting versions
bun pm ls

# Clear lockfile and reinstall
rm bun.lockb
bun i && bun run build
elizaos update
```

### Permission Errors

```bash
# For global CLI updates on macOS/Linux
sudo elizaos update --cli

# Or change npm global directory ownership
sudo chown -R $(whoami) ~/.npm
```

### Network Issues

```bash
# Check npm registry connectivity
npm ping

# Update with different registry
npm config set registry https://registry.npmjs.org/
elizaos update
```

## Best Practices

### Before Updating

```bash
# Always check first
elizaos update --check

# Backup your project
git add . && git commit -m "Pre-update backup"

# Check current versions
bun pm ls | grep @elizaos
```

### Safe Update Process

```bash
# 1. Check what will be updated
elizaos update --check

# 2. Update CLI first
elizaos update --cli

# 3. Update packages
elizaos update --packages

# 4. Test your project
elizaos start --build
```

### After Updating

```bash
# Verify update success
elizaos --version

# Test project functionality
elizaos dev

# Check for any issues
elizaos test
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
