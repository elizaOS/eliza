---
sidebar_position: 1
title: ElizaOS CLI Overview
description: Comprehensive guide to the ElizaOS Command Line Interface (CLI) tools and commands
keywords: [CLI, commands, installation, configuration, development, production, plugins, projects]
image: /img/cli.jpg
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
elizaos [command]
```

## Available Commands

| Command                     | Description                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`create`](./create.md)     | Initialize a new project, plugin, or agent                                                                     |
| [`monorepo`](./monorepo.md) | Clone ElizaOS monorepo from a specific branch (defaults to develop)                                            |
| [`plugins`](./plugins.md)   | Manage ElizaOS plugins                                                                                         |
| [`agent`](./agent.md)       | Manage ElizaOS agents                                                                                          |
| [`tee`](./tee.md)           | Manage TEE deployments                                                                                         |
| [`start`](./start.md)       | Start the Eliza agent with configurable plugins and services                                                   |
| [`update`](./update.md)     | Update ElizaOS CLI and project dependencies                                                                    |
| [`test`](./test.md)         | Run tests for Eliza agent projects and plugins                                                                 |
| [`env`](./env.md)           | Manage environment variables and secrets                                                                       |
| [`dev`](./dev.md)           | Start the project or plugin in development mode with auto-rebuild, detailed logging, and file change detection |
| [`publish`](./publish.md)   | Publish a plugin to the registry                                                                               |
| [`stop`](./stop.md)         | Stop all running ElizaOS agents running locally                                                                |

## Global Options

These options apply to all commands:

| Option            | Description                 |
| ----------------- | --------------------------- |
| `--help`, `-h`    | Display help information    |
| `--version`, `-v` | Display version information |

## Project Structure

For detailed information about project and plugin structure, see the [Quickstart Guide](../quickstart.md).

## Environment Configuration

Configure your API keys and environment variables with the `env` command:

```bash
# Edit local environment variables interactively
elizaos env edit-local

# List all environment variables
elizaos env list

# Interactive environment manager
elizaos env interactive
```

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

Plugins extend the functionality of your agents. Use the `plugins` command for managing plugins and `publish` for publishing your own:

```bash
# List available plugins
elizaos plugins list

# Add a plugin to your project
elizaos plugins add @elizaos/plugin-discord

# Publish your plugin (from plugin directory)
elizaos publish

# Test publishing without making changes
elizaos publish --test
```

## Related Documentation

- [Quickstart Guide](../quickstart.md): Complete workflow guide
- [Environment Configuration](./env.md): Managing environment variables

---
