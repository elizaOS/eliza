---
sidebar_position: 1
---

# ElizaOS CLI

The ElizaOS Command Line Interface (CLI) provides a comprehensive set of tools to create, manage, and interact with ElizaOS projects and agents.

## Installation

Install the ElizaOS CLI globally using npm:

```bash
npm install -g @elizaos/cli@beta
```

Or use it directly with npx:

```bash
npx @elizaos/cli@beta [command]
```

## Available Commands

| Command                    | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| [`create`](./create.md)    | Create new projects, plugins, or agents              |
| [`start`](./start.md)      | Start an ElizaOS project or agent                    |
| [`dev`](./dev.md)          | Run a project in development mode with hot reloading |
| [`agent`](./agent.md)      | Manage agent configurations and state                |
| [`plugin`](./plugins.md)   | Manage plugins in your project                       |
| [`project`](./projects.md) | Manage project configuration and settings            |
| [`env`](./env.md)          | Configure environment variables and API keys         |
| [`publish`](./publish.md)  | Publish packages to npm registry                     |
| [`update`](./update.md)    | Update ElizaOS components                            |
| [`test`](./test.md)        | Run tests for your project                           |

## Global Options

These options apply to most commands:

| Option            | Description                   |
| ----------------- | ----------------------------- |
| `--help`, `-h`    | Display help information      |
| `--version`, `-v` | Display version information   |
| `--debug`         | Enable debug logging          |
| `--quiet`         | Suppress non-essential output |
| `--json`          | Output results in JSON format |

## Project Structure

For detailed information about project and plugin structure, see the [Quickstart Guide](../quickstart.md).

## Environment Configuration

For detailed information about environment configuration, see the [Environment Command](./env.md) documentation.

## Development vs Production

ElizaOS supports two main modes of operation:

1. **Development Mode** (`dev` command)

   - Hot reloading
   - Detailed error messages
   - File watching
   - See [Dev Command](./dev.md) for details

2. **Production Mode** (`start` command)
   - Optimized performance
   - Production-ready configuration
   - See [Start Command](./start.md) for details

## Quick Start

For a complete guide to getting started with ElizaOS, see the [Quickstart Guide](../quickstart.md).

## Related Documentation

- [Quickstart Guide](../quickstart.md): Complete workflow guide
- [Environment Configuration](./env.md): Managing environment variables

---

## Quick Start

> Note: This assumes you installed the CLI tool (`npm install -g @elizaos/cli@beta`)

### Creating a new project

```bash
# Create a new project using the interactive wizard
elizaos create

# Or specify a name directly
elizaos create my-agent-project
```

### Starting a project

```bash
# Navigate to your project directory
cd my-agent-project

# Start the project
elizaos start
```

### Development mode

```bash
# Run in development mode with hot reloading
elizaos dev
```

## Working with Projects

ElizaOS organizes work into projects, which can contain one or more agents along with their configurations, knowledge files, and dependencies. The CLI provides commands to manage the entire lifecycle of a project:

1. **Create** a new project with `create`
2. **Configure** settings with `env`
3. **Develop** using `dev` for hot reloading
4. **Test** functionality with `test`
5. **Start** in production with `start`
6. **Share** by publishing with `publish`

## Working with Plugins

Plugins extend the functionality of your agents. Manage them with the `plugin` command:

```bash
# Add a plugin to your project
elizaos plugin add @elizaos/plugin-discord

# Remove a plugin
elizaos plugin remove @elizaos/plugin-discord

# List installed plugins
elizaos plugin list
```

## Environment Configuration

Configure your API keys and environment variables with the `env` command:

```bash
# Set OpenAI API key
elizaos env set OPENAI_API_KEY your-api-key

# List all environment variables
elizaos env list
```
