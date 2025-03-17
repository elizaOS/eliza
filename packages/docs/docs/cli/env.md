---
sidebar_position: 4
---

# Environment Command

The `env` command helps you manage environment variables and API keys for your ElizaOS projects. It provides a secure and convenient way to set, view, and manage sensitive configuration.

## Usage

```bash
npx @elizaos/cli env [command] [options]
```

## Commands

| Command           | Description                                               |
| ----------------- | --------------------------------------------------------- |
| `list`            | List all environment variables                            |
| `edit-global`     | Edit global environment variables                         |
| `edit-local`      | Edit local environment variables                          |
| `reset`           | Reset all environment variables and wipe the cache folder |
| `set-path <path>` | Set a custom path for the global environment file         |
| `interactive`     | Start interactive environment variable manager            |

If no command is provided, a help message will be shown with available commands.

## Global vs Local Environment Variables

ElizaOS maintains two levels of environment variables:

1. **Global variables** - Stored in `~/.eliza/.env` by default or in a custom location if set
2. **Local variables** - Stored in `.env` in your current project directory

Global variables are applied to all projects, while local variables are specific to the current project.

## Interactive Mode

The interactive mode provides a user-friendly way to manage environment variables:

```bash
npx @elizaos/cli env interactive
```

This opens a menu with options to:

- List environment variables
- Edit global environment variables
- Edit local environment variables
- Set custom environment path
- Reset environment variables

## Managing Environment Variables

### Listing Variables

View all configured environment variables:

```bash
npx @elizaos/cli env list
```

This will display both global and local variables (if available).

### Editing Global Variables

Edit the global environment variables interactively:

```bash
npx @elizaos/cli env edit-global
```

This provides an interactive interface to:

- View existing global variables
- Add new variables
- Edit existing variables
- Delete variables

### Editing Local Variables

Edit the local environment variables in the current project:

```bash
npx @elizaos/cli env edit-local
```

If no local `.env` file exists, you will be prompted to create one.

### Setting Custom Environment Path

Set a custom location for the global environment file:

```bash
npx @elizaos/cli env set-path /path/to/custom/location
```

If the specified path is a directory, the command will use `/path/to/custom/location/.env`.

### Resetting Environment Variables

Reset all environment variables and clear the cache:

```bash
npx @elizaos/cli env reset
```

This will:

1. Remove the global `.env` file
2. Clear any custom environment path setting
3. Wipe the cache folder
4. Optionally reset the database folder (you'll be prompted)

## Examples

### Viewing Environment Variables

```bash
# List all variables
npx @elizaos/cli env list
```

Output example:

```
Global environment variables (.eliza/.env):
  OPENAI_API_KEY: sk-1234...5678
  MODEL_PROVIDER: openai

Local environment variables (.env):
  PORT: 8080
  LOG_LEVEL: debug
```

### Setting Custom Environment Path

```bash
# Set a custom path for global environment variables
npx @elizaos/cli env set-path ~/projects/eliza-config/.env
```

### Interactive Editing

```bash
# Start interactive mode
npx @elizaos/cli env interactive

# Edit only global variables
npx @elizaos/cli env edit-global

# Edit only local variables
npx @elizaos/cli env edit-local
```

## Key Variables

ElizaOS commonly uses these environment variables:

| Variable             | Description                                  |
| -------------------- | -------------------------------------------- |
| `OPENAI_API_KEY`     | OpenAI API key for model access              |
| `ANTHROPIC_API_KEY`  | Anthropic API key for Claude models          |
| `TELEGRAM_BOT_TOKEN` | Token for Telegram bot integration           |
| `DISCORD_BOT_TOKEN`  | Token for Discord bot integration            |
| `POSTGRES_URL`       | PostgreSQL database connection string        |
| `MODEL_PROVIDER`     | Default model provider to use                |
| `LOG_LEVEL`          | Logging verbosity (debug, info, warn, error) |
| `PORT`               | HTTP API port number                         |

## Security Best Practices

1. **Never commit .env files** to version control
2. **Use separate environments** for development, testing, and production
3. **Set up global variables** for commonly used API keys
4. **Regularly rotate API keys** for security

## Related Commands

- [`start`](./start.md): Start your project with the configured environment
- [`dev`](./dev.md): Run in development mode with the configured environment
- [`create`](./create.md): Create a new project with initial environment setup
