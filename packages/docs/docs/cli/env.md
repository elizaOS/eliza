---
sidebar_position: 5
title: Environment Configuration
description: Configure environment variables and API keys for ElizaOS projects
keywords: [environment, configuration, API keys, secrets, settings, .env]
image: /img/cli.jpg
---

# Environment Command

The `env` command helps you manage environment variables and API keys for your ElizaOS projects. It provides a secure and convenient way to set, view, and manage sensitive configuration.

## Usage

```bash
elizaos env [command] [options]
```

## Subcommands

| Subcommand        | Description                                                   | Options                           |
| ----------------- | ------------------------------------------------------------- | --------------------------------- |
| `list`            | List all environment variables                                | `--system`, `--global`, `--local` |
| `edit-global`     | Edit global environment variables                             | `-y, --yes`                       |
| `edit-local`      | Edit local environment variables                              | `-y, --yes`                       |
| `reset`           | Reset environment variables and clean up database/cache files | `-y, --yes`                       |
| `set-path <path>` | Set a custom path for the global environment file             | `-y, --yes`                       |
| `interactive`     | Start interactive environment variable manager                | `-y, --yes`                       |

## Environment Levels

ElizaOS maintains two levels of environment variables:

1. **Global variables** - Stored in `~/.eliza/.env` by default or in a custom location if set
2. **Local variables** - Stored in `.env` in your current project directory

Global variables are applied to all projects, while local variables are specific to the current project.

## Interactive Mode

The interactive mode provides a user-friendly way to manage environment variables:

```bash
elizaos env interactive
```

This opens a menu with options to:

- List environment variables
- Edit global environment variables
- Edit local environment variables
- Set custom global environment path
- Reset environment variables

## Managing Environment Variables

### Listing Variables

View all configured environment variables:

```bash
elizaos env list
```

This will display:

- System information (OS, architecture, CLI version, etc.)
- Global environment variables from `~/.eliza/.env` or your custom path
- Local environment variables from `./.env` in your current directory

If no local `.env` file exists, the command will display a warning and instructions for creating one. This helps you quickly see if your project is missing required configuration.

You can also filter the output:

```bash
elizaos env list --system  # Show only system information
elizaos env list --global  # Show only global environment variables
elizaos env list --local   # Show only local environment variables
```

### Editing Global Variables

Edit the global environment variables interactively:

```bash
elizaos env edit-global
```

This provides an interactive interface to:

- View existing global variables
- Add new variables
- Edit existing variables
- Delete variables

### Editing Local Variables

Edit the local environment variables in the current project:

```bash
elizaos env edit-local
```

If no local `.env` file exists, you will be prompted to create one. The editor will then allow you to add new variables to the created file.

### Setting Custom Environment Path

Set a custom location for the global environment file:

```bash
elizaos env set-path /path/to/custom/location
```

If the specified path is a directory, the command will use `/path/to/custom/location/.env`.

The command supports tilde expansion, so you can use paths like `~/eliza-config/.env`. Non-existent directories will be created if you confirm.

This setting affects where global environment variables are stored and loaded from in all ElizaOS commands.

### Resetting Environment Variables and Data

Reset environment variables and optionally delete database and cache files:

```bash
elizaos env reset
```

This command provides an interactive selection interface where you can choose which items to reset:

- **Global environment variables** - Clears values in global `.env` file while preserving keys
- **Local environment variables** - Clears values in local `.env` file while preserving keys
- **Cache folder** - Deletes the cache folder
- **Global database files** - Deletes global database files (including PGLite data)
- **Local database files** - Deletes local database files

The command intelligently detects:

- Missing files/folders (skipped automatically)
- External PostgreSQL usage (warns that only local files will be removed)
- PGLite configuration (ensures the correct folders are removed)

After selecting items, you'll be shown a summary and asked for confirmation before proceeding.

Use the `-y, --yes` flag to automatically reset all valid items without prompts:

```bash
elizaos env reset --yes
```

With `--yes`, the command will:

1. Select only items that exist and can be reset
2. Show a list of what will be reset
3. Perform the reset without additional confirmation
4. Display a detailed summary of actions taken

## Key Variables

ElizaOS commonly uses these environment variables:

| Variable             | Description                                  |
| -------------------- | -------------------------------------------- |
| `OPENAI_API_KEY`     | OpenAI API key for model access              |
| `ANTHROPIC_API_KEY`  | Anthropic API key for Claude models          |
| `TELEGRAM_BOT_TOKEN` | Token for Telegram bot integration           |
| `DISCORD_BOT_TOKEN`  | Token for Discord bot integration            |
| `POSTGRES_URL`       | PostgreSQL database connection string        |
| `PGLITE_DATA_DIR`    | Directory for PGLite database files          |
| `MODEL_PROVIDER`     | Default model provider to use                |
| `LOG_LEVEL`          | Logging verbosity (debug, info, warn, error) |
| `PORT`               | HTTP API port number                         |

## Security Best Practices

1. **Never commit .env files** to version control
2. **Use separate environments** for development, testing, and production
3. **Set up global variables** for commonly used API keys
4. **Regularly rotate API keys** for security

## Examples

### Viewing Environment Variables

```bash
# List all variables
elizaos env list
```

Output example:

```
System Information:
  Platform: darwin (24.3.0)
  Architecture: arm64
  CLI Version: 1.0.0-beta.51
  Package Manager: bun v1.2.5

Global environment variables (.eliza/.env):
  OPENAI_API_KEY: sk-1234...5678
  MODEL_PROVIDER: openai

Local environment variables (.env):
  PORT: 8080
  LOG_LEVEL: debug
```

If the `.env` file is missing:

```
Local Environment Variables:
Path: /current/directory/.env
  No local .env file found
  ✖ Missing .env file. Create one in your project directory to set local environment variables.
```

### Setting Custom Environment Path

```bash
# Set a custom path for global environment variables
elizaos env set-path ~/projects/eliza-config/.env
```

### Interactive Editing

```bash
# Start interactive mode
elizaos env interactive

# Edit only global variables
elizaos env edit-global

# Edit only local variables
elizaos env edit-local
```

### Resetting Environment

```bash
# Interactive reset with selection
elizaos env reset

# Reset with default selections
elizaos env reset --yes
```

Example reset output:

```
The following items will be reset:
  • Global environment variables
  • Local environment variables
  • Cache folder

Reset Summary:
  Values Cleared:
    • Global environment variables
    • Local environment variables
  Deleted:
    • Cache folder
  Skipped:
    • Global database files (not found)
    • Local database files (not found)

Environment reset complete
```

## Related Commands

- [`start`](./start.md): Start your project with the configured environment
- [`dev`](./dev.md): Run in development mode with the configured environment
- [`create`](./create.md): Create a new project with initial environment setup
