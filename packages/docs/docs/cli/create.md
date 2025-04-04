---
sidebar_position: 2
---

# Create Command

The `create` command scaffolds new ElizaOS projects or plugins with an interactive setup process.

## Usage

```bash
elizaos create [options]
```

## Options

| Option         | Description                                                            |
| -------------- | ---------------------------------------------------------------------- |
| `--dir`, `-d`  | Installation directory (defaults to project name in current directory) |
| `--yes`, `-y`  | Skip confirmation prompts                                              |
| `--type`, `-t` | Type to create: `project` or `plugin`                                  |

## Project Types

### Project

Creates a standard ElizaOS project with agent configuration and knowledge setup.

```bash
npx @elizaos/cli create --type project
```

Project structure:

```
my-agent-project/
├── knowledge/          # Knowledge files for RAG
├── src/                # Source code directory
├── package.json
└── other configuration files
```

### Plugin

Creates a plugin that extends ElizaOS functionality.

```bash
npx @elizaos/cli create --type plugin
```

Plugin structure:

```
my-plugin/
├── src/                # Plugin source code
├── package.json
└── other configuration files
```

## Interactive Process

The command launches an interactive wizard when run without all options:

1. **Project Type**: Select between project or plugin
2. **Project Name**: Enter a name for your project/plugin
3. **Database Selection**: Choose database (PGLite or Postgres)
4. **Database Configuration**: Configure Postgres if selected

## Examples

### Creating a basic project

```bash
npx @elizaos/cli create
# Then follow the interactive prompts
```

### Creating a plugin

```bash
npx @elizaos/cli create --type plugin
# Then follow the interactive prompts
```

### Specifying a directory

```bash
npx @elizaos/cli create --dir ./my-projects/new-agent
```

### Skipping confirmation prompts

```bash
npx @elizaos/cli create --yes
```

## Next Steps

After creation, see the [Getting Started Guide](../getting-started.md) for next steps.

## Related Commands

- [`start`](./start.md): Start your created project
- [`dev`](./dev.md): Run your project in development mode
- [`env`](./env.md): Configure environment variables
- [`plugin`](./plugins.md): Manage plugins in your project
