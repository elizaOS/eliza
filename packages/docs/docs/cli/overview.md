---
sidebar_position: 1
---

# ElizaOS CLI

The ElizaOS Command Line Interface (CLI) provides a comprehensive set of tools to create, manage, and interact with ElizaOS projects and agents.

## Installation

Install the ElizaOS CLI globally using npm:

```bash
npm install -g @elizaos/cli
```

Or use it directly with npx:

```bash
npx @elizaos/cli [command]
```

## Available Commands

| Command                    | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| [`create`](./create.md)    | Create new projects, plugins, or agents              |
| [`start`](./start.md)      | Start an ElizaOS project or agent                    |
| [`dev`](./create.md)       | Run a project in development mode with hot reloading |
| [`agent`](./agent.md)      | Manage agent configurations and state                |
| [`plugin`](./plugins.md)   | Manage plugins in your project                       |
| [`project`](./projects.md) | Manage project configuration and settings            |
| [`env`](./env.md)          | Configure environment variables and API keys         |
| [`publish`](./publish.md)  | Publish packages to npm registry                     |
| [`update`](./update.md)    | Update ElizaOS components                            |
| [`test`](./test.md)        | Run tests for your project                           |

## Quick Start

### Creating a new project

```bash
# Create a new project using the interactive wizard
npx @elizaos/cli create

# Or specify a name directly
npx @elizaos/cli create my-agent-project
```

### Starting a project

```bash
# Navigate to your project directory
cd my-agent-project

# Start the project
npx @elizaos/cli start
```

### Development mode

```bash
# Run in development mode with hot reloading
npx @elizaos/cli dev
```

## Global Options

These options apply to most commands:

| Option            | Description                   |
| ----------------- | ----------------------------- |
| `--help`, `-h`    | Display help information      |
| `--version`, `-v` | Display version information   |
| `--debug`         | Enable debug logging          |
| `--quiet`         | Suppress non-essential output |
| `--json`          | Output results in JSON format |

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
npx @elizaos/cli plugin add @elizaos/plugin-discord

# Remove a plugin
npx @elizaos/cli plugin remove @elizaos/plugin-discord

# List installed plugins
npx @elizaos/cli plugin list
```

## Environment Configuration

Configure your API keys and environment variables with the `env` command:

```bash
# Set OpenAI API key
npx @elizaos/cli env set OPENAI_API_KEY your-api-key

# List all environment variables
npx @elizaos/cli env list
```
