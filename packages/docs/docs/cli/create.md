---
sidebar_position: 2
---

# Create Command

The `create` command is used to scaffold new ElizaOS projects or plugins. It guides you through an interactive setup process to generate the appropriate files and configurations.

## Usage

```bash
npx @elizaos/cli create [options]
```

## Options

| Option         | Description                                                            |
| -------------- | ---------------------------------------------------------------------- |
| `--dir`, `-d`  | Installation directory (defaults to project name in current directory) |
| `--yes`, `-y`  | Skip confirmation prompts                                              |
| `--type`, `-t` | Type to create: `project` or `plugin`                                  |

## Project Types

### Project

A standard ElizaOS project with agent configuration, knowledge setup, and essential components.

```bash
npx @elizaos/cli create --type project
```

This creates a complete project structure:

```
my-agent-project/
├── knowledge/          # Knowledge files for RAG
├── src/                # Source code directory
├── package.json
└── other configuration files
```

### Plugin

A plugin that extends ElizaOS functionality with custom actions, services, providers, or other extensions.

```bash
npx @elizaos/cli create --type plugin
```

This creates a plugin structure:

```
my-plugin/
├── src/                # Plugin source code
├── package.json
└── other configuration files
```

## Interactive Process

When run without all options specified, the command launches an interactive wizard:

1. **Project Type**: If not specified, select between project or plugin
2. **Project Name**: Enter a name for your project or plugin
3. **Database Selection**: For projects, choose your database (PGLite or Postgres)
4. **Database Configuration**: For Postgres, you'll be prompted for your database URL

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

## After Creation

Once your project is created:

1. Navigate to the project directory:

   ```bash
   cd my-project-name
   ```

2. Start your project:

   ```bash
   npx @elizaos/cli start
   ```

   Or start in development mode:

   ```bash
   npx @elizaos/cli dev
   ```

3. Visit `http://localhost:3000` to view your project in the browser

For plugins, you can:

1. Start development:

   ```bash
   npx @elizaos/cli start
   ```

2. Test your plugin:

   ```bash
   npx @elizaos/cli test
   ```

3. Publish your plugin:

   ```bash
   npx @elizaos/cli plugins publish
   ```

## Related Commands

- [`start`](./start.md): Start your created project
- [`dev`](./dev.md): Run your project in development mode
- [`env`](./env.md): Configure environment variables
- [`plugin`](./plugins.md): Manage plugins in your project
