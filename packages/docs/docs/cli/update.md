---
sidebar_position: 11
---

# Update Command

The `update` command checks for and updates ElizaOS dependencies in your project or plugin to the latest compatible versions. This helps you keep your ElizaOS installation current with the latest features, improvements, and bug fixes.

## Usage

```bash
npx @elizaos/cli update [options]
```

## Options

| Option         | Description                                       |
| -------------- | ------------------------------------------------- |
| `--check`      | Check for available updates without applying them |
| `--skip-build` | Skip building the project after updating          |

## Update Process

When you run the `update` command, ElizaOS will:

1. Detect whether you're in a project or plugin directory
2. Find all ElizaOS packages in your dependencies
3. Update them to match the current CLI version
4. Install the updated dependencies
5. Build the project with the new dependencies (unless `--skip-build` is specified)

## Project Type Detection

The update command automatically detects whether you're working with:

1. **Project**: A complete ElizaOS project with agents
2. **Plugin**: An ElizaOS plugin that provides extensions

It determines this by checking the package.json metadata, particularly:

- If the package name starts with `@elizaos/plugin-`
- If keywords include `elizaos-plugin`

## Workspace References

The command properly handles workspace references in monorepo setups:

- Packages with versions like `workspace:*` are identified as workspace references
- These are skipped during the update process as they're meant to be managed by the monorepo

## Examples

### Check For Updates

Check what updates are available without applying them:

```bash
npx @elizaos/cli update --check
```

Example output:

```
Checking for available updates...
Current CLI version: 1.3.5
To apply updates, run this command without the --check flag
```

### Update Dependencies

Update all ElizaOS dependencies to match the CLI version:

```bash
npx @elizaos/cli update
```

Example output:

```
Detected project directory
Current CLI version: 1.3.5
Found 5 ElizaOS packages: @elizaos/core, @elizaos/runtime, @elizaos/knowledge, @elizaos/models, @elizaos/plugin-discord
Updating @elizaos/core to version 1.3.5...
Updating @elizaos/runtime to version 1.3.5...
Updating @elizaos/knowledge to version 1.3.5...
Updating @elizaos/models to version 1.3.5...
Updating @elizaos/plugin-discord to version 1.3.5...
Dependencies updated successfully
Installing updated dependencies...
Project successfully updated to the latest ElizaOS packages
```

### Skip Building

Update dependencies but skip the build step:

```bash
npx @elizaos/cli update --skip-build
```

## Version Management

The update command will automatically handle different types of updates:

- For minor or patch updates, it will proceed automatically
- For major version updates that might include breaking changes, it will ask for confirmation

## Best Practices

Here are some recommended practices when updating ElizaOS dependencies:

1. **Check First**: Use `--check` to see what updates are available before applying them
2. **Backup Your Project**: Always make a backup of your project before updating
3. **Test After Updating**: Make sure your project works correctly after updating
4. **Review Changelogs**: Check the ElizaOS changelog for any breaking changes in new versions

## Troubleshooting

### Dependency Resolution Problems

If you encounter issues with dependency resolution:

```bash
# Run the command with full Node.js error stack traces
NODE_OPTIONS=--stack-trace-limit=100 npx @elizaos/cli update
```

### Build Failures

If the build fails after updating:

```bash
# Skip the automatic build and build manually with more verbose output
npx @elizaos/cli update --skip-build
npx @elizaos/cli build --verbose
```

### Version Mismatches

If you need a specific version rather than the latest:

```bash
# Manually install the specific version needed
npm install @elizaos/core@1.2.3
```

## Related Commands

- [`build`](./projects.md): Build your project manually
- [`start`](./start.md): Start your project with updated dependencies
- [`dev`](./dev.md): Run your project in development mode
