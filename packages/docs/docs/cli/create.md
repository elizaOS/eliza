---
sidebar_position: 2
title: Create Command
description: Initialize a new project, plugin, or agent with an interactive setup process
keywords: [create, project, plugin, setup, scaffolding, initialization, configuration]
image: /img/cli.jpg
---

# Create Command

Initialize a new project, plugin, or agent.

## Usage

```bash
# Interactive mode (recommended)
elizaos create

# With specific options
elizaos create [options] [name]
```

## Getting Help

```bash
# View detailed help
elizaos create --help
```

## Options

| Option              | Description                                               |
| ------------------- | --------------------------------------------------------- |
| `-d, --dir <dir>`   | Installation directory (default: `.`)                     |
| `-y, --yes`         | Skip confirmation and use defaults (default: `false`)     |
| `-t, --type <type>` | Type of template to use (`project`, `plugin`, or `agent`) |
| `[name]`            | Name for the project, plugin, or agent (optional)         |

## Interactive Process

When you run `elizaos create` without options, it launches an interactive wizard:

1. **What would you like to name your project?** - Enter your project name
2. **Select your database:** - Choose between:
   - `pglite` (local, file-based database)
   - `postgres` (requires connection details)

## Default Values (with -y flag)

When using the `-y` flag to skip prompts:

- **Default name**: `myproject`
- **Default type**: `project`
- **Default database**: `pglite`

## Examples

### Interactive Creation (Recommended)

```bash
# Start interactive wizard
elizaos create
```

This will prompt you for:

- Project name
- Database selection (pglite or postgres)

### Quick Creation with Defaults

```bash
# Create project with defaults (name: "myproject", database: pglite)
elizaos create -y
```

### Specify Project Name

```bash
# Create project with custom name, interactive database selection
elizaos create my-awesome-project

# Create project with custom name and skip prompts
elizaos create my-awesome-project -y
```

### Create Different Types

```bash
# Create a plugin interactively
elizaos create -t plugin

# Create a plugin with defaults
elizaos create -t plugin -y

# Create an agent character file
elizaos create -t agent my-character-name
```

### Custom Directory

```bash
# Create in specific directory
elizaos create -d ./my-projects/new-agent

# Create plugin in specific directory
elizaos create -t plugin -d ./plugins/my-plugin
```

## Project Types

### Project (Default)

Creates a complete ElizaOS project with:

- Agent configuration and character files
- Knowledge directory for RAG
- Database setup (PGLite or Postgres)
- Test structure
- Build configuration

**Default structure:**

```
myproject/
├── src/
│   └── index.ts          # Main character definition
├── knowledge/            # Knowledge files for RAG
├── __tests__/           # Component tests
├── e2e/                 # End-to-end tests
├── .elizadb/           # PGLite database (if selected)
├── package.json
└── tsconfig.json
```

### Plugin

Creates a plugin that extends ElizaOS functionality:

```bash
elizaos create -t plugin my-plugin
```

**Plugin structure:**

```
plugin-my-plugin/         # Note: "plugin-" prefix added automatically
├── src/
│   └── index.ts         # Plugin implementation
├── images/              # Logo and banner for registry
├── package.json
└── tsconfig.json
```

### Agent

Creates a standalone agent character definition file:

```bash
elizaos create -t agent my-character
```

This creates a single `.json` file with character configuration.

## After Creation

The CLI will automatically:

1. **Install dependencies** using bun
2. **Build the project** (for projects and plugins)
3. **Show next steps**:
   ```bash
   cd myproject
   elizaos start
   # Visit http://localhost:3000
   ```

## Database Selection

### PGLite (Recommended for beginners)

- Local file-based database
- No setup required
- Data stored in `.elizadb/` directory

### Postgres

- Requires existing Postgres database
- Prompts for connection details during setup
- Better for production deployments

## Troubleshooting

### Creation Failures

```bash
# Check if you can write to the target directory
touch test-file && rm test-file

# If permission denied, change ownership or use different directory
elizaos create -d ~/my-projects/new-project
```

### Dependency Installation Issues

```bash
# If bun install fails, try manual installation
cd myproject
bun install

# For network issues, clear cache and retry
bun pm cache rm
bun install
```

### Database Connection Problems

**PGLite Issues:**

- Ensure sufficient disk space in target directory
- Check write permissions for `.elizadb/` directory

**Postgres Issues:**

- Verify database server is running
- Test connection with provided credentials
- Ensure database exists and user has proper permissions

### Build Failures

```bash
# Check for TypeScript errors
bun run build

# If build fails, check dependencies
bun install
bun run build
```

### Template Not Found

```bash
# Verify template type is correct
elizaos create -t project    # Valid: project, plugin, agent
elizaos create -t invalid    # Invalid template type
```

## Related Commands

- [`start`](./start.md): Start your created project
- [`dev`](./dev.md): Run your project in development mode
- [`env`](./env.md): Configure environment variables
