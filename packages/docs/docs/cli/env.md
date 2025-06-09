---
sidebar_position: 5
title: Environment Configuration
description: Configure environment variables and API keys for ElizaOS projects
keywords: [environment, configuration, API keys, secrets, settings, .env]
image: /img/cli.jpg
---

# Environment Command

Manage environment variables and secrets.

## Usage

```bash
elizaos env [command] [options]
```

## Subcommands

| Subcommand    | Description                                                                           | Options               |
| ------------- | ------------------------------------------------------------------------------------- | --------------------- |
| `list`        | List all environment variables                                                        | `--system`, `--local` |
| `edit-local`  | Edit local environment variables                                                      | `-y, --yes`           |
| `reset`       | Reset environment variables and clean up database/cache files (interactive selection) | `-y, --yes`           |
| `interactive` | Interactive environment variable management                                           | `-y, --yes`           |

## Options

### List Command Options

| Option     | Description                           |
| ---------- | ------------------------------------- |
| `--system` | List only system information          |
| `--local`  | List only local environment variables |

### General Options

| Option      | Description                   |
| ----------- | ----------------------------- |
| `-y, --yes` | Automatically confirm prompts |

## Examples

### Viewing Environment Variables

```bash
# List all variables (system info + local .env)
elizaos env list

# Show only system information
elizaos env list --system

# Show only local environment variables
elizaos env list --local
```

Example output:

```
System Information:
  Platform: darwin (24.3.0)
  Architecture: arm64
  CLI Version: 1.0.0
  Package Manager: bun v1.2.5

Local Environment Variables:
Path: /current/directory/.env
  OPENAI_API_KEY: sk-1234...5678
  MODEL_PROVIDER: openai
  PORT: 8080
  LOG_LEVEL: debug
```

### Managing Local Environment Variables

```bash
# Edit local environment variables interactively
elizaos env edit-local

# Display variables and exit (--yes flag skips interactive editing)
elizaos env edit-local --yes
```

The edit-local command allows you to:

- View existing local variables
- Add new variables
- Edit existing variables
- Delete variables

**Note**: The `--yes` flag displays current variables and exits without interactive editing, since variable modification requires user input.

### Interactive Management

```bash
# Start interactive environment manager
elizaos env interactive
```

Interactive mode provides a menu with options to:

- List environment variables
- Edit local environment variables
- Reset environment variables

**Note**: The `--yes` flag is ignored in interactive mode since it requires user input by design.

### Resetting Environment and Data

```bash
# Interactive reset with item selection
elizaos env reset

# Automatic reset with default selections
elizaos env reset --yes
```

The reset command allows you to selectively reset:

- **Local environment variables** - Clears values in local `.env` file while preserving keys
- **Cache folder** - Deletes the cache folder (`~/.eliza/cache`)
- **Local database files** - Deletes local database files (PGLite data directory)

## Environment File Structure

ElizaOS uses local environment variables stored in `.env` files in your project directory:

- **Local variables** - Stored in `./.env` in your current project directory

### Missing .env File Handling

If no local `.env` file exists:

- Commands will detect this and offer to create one
- The `list` command will show helpful guidance
- The `edit-local` command will prompt to create a new file

## Common Environment Variables

| Variable             | Description                                  |
| -------------------- | -------------------------------------------- |
| `OPENAI_API_KEY`     | OpenAI API key for model access              |
| `ANTHROPIC_API_KEY`  | Anthropic API key for Claude models          |
| `TELEGRAM_BOT_TOKEN` | Token for Telegram bot integration           |
| `DISCORD_BOT_TOKEN`  | Token for Discord bot integration            |
| `POSTGRES_URL`       | PostgreSQL database connection string        |
| `SQLITE_DATA_DIR`    | Directory for PGLite database files          |
| `MODEL_PROVIDER`     | Default model provider to use                |
| `LOG_LEVEL`          | Logging verbosity (debug, info, warn, error) |
| `PORT`               | HTTP API port number                         |

## Database Configuration Detection

The reset command intelligently detects your database configuration:

- **External PostgreSQL** - Warns that only local files will be removed
- **PGLite** - Ensures the correct local database directories are removed
- **Missing configuration** - Skips database-related reset operations

## Security Features

- **Value masking** - Sensitive values (API keys, tokens) are automatically masked in output
- **Local-only storage** - Environment variables are stored locally in your project
- **No global secrets** - Prevents accidental exposure across projects

## Troubleshooting

### Missing .env File

```bash
# Check if .env file exists
ls -la .env

# Create .env file from example
cp .env.example .env

# Edit the new file
elizaos env edit-local
```

### Permission Issues

```bash
# Check file permissions
ls -la .env

# Fix permissions if needed
chmod 600 .env
```

### Database Reset Issues

```bash
# Check what exists before reset
elizaos env list

# Reset only specific items
elizaos env reset

# Force reset with defaults
elizaos env reset --yes
```

### Environment Not Loading

```bash
# Verify environment file exists and has content
cat .env

# Check for syntax errors in .env file
elizaos env list --local
```

## Related Commands

- [`start`](./start.md): Start your project with the configured environment
- [`dev`](./dev.md): Run in development mode with the configured environment
- [`test`](./test.md): Run tests with environment configuration
- [`create`](./create.md): Create a new project with initial environment setup
