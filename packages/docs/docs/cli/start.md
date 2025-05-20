---
sidebar_position: 3
title: Start Command
description: Launch and manage ElizaOS projects and agents in production mode
keywords: [start, production, deployment, configuration, runtime, services, agents]
image: /img/cli.jpg
---

# Start Command

The `start` command launches an ElizaOS project or agent in production mode. It initializes the agent runtime, loads plugins, connects to services, and starts handling interactions.

## Usage

```bash
elizaos start [options]
```

## Options

| Option                          | Description                                      |
| ------------------------------- | ------------------------------------------------ |
| `-p, --port <port>`             | Port to listen on (default: 3000)                |
| `-c, --configure`               | Force reconfiguration of services and AI models  |
| `-char, --character [paths...]` | Character file(s) to use - accepts paths or URLs |
| `-b, --build`                   | Build the project before starting                |

## Production Features

When you run `start`, ElizaOS provides production-ready features:

1. **Optimized Performance**: Runs with production optimizations
2. **Stable Configuration**: Uses saved configuration by default
3. **Service Management**: Handles service connections and disconnections
4. **Error Recovery**: Automatic recovery from transient errors
5. **Resource Management**: Efficient resource allocation and cleanup

## What Happens During Startup

When you run the `start` command, ElizaOS:

1. Detects whether you're in a project or plugin directory
2. Loads and validates the configuration
3. Initializes the database system
4. Loads required plugins
5. Starts any configured services
6. Processes knowledge files if present
7. Starts the HTTP API server
8. Initializes agent runtimes
9. Begins listening for messages and events

For development features and hot reloading, see the [Dev Command](./dev.md).

## Project Detection

ElizaOS automatically detects projects in the current directory by looking for:

1. A `package.json` with an `eliza.type` field set to `project`
2. A main entry point that exports a project configuration with agents
3. Other project indicators in the package metadata

## Environment Variables

The `start` command will look for an `.env` file in the project directory and load environment variables from it. You can also set environment variables directly:

```bash
# Set environment variables directly
OPENAI_API_KEY=your-api-key elizaos start
```

For detailed information about environment configuration, see the [Environment Command](./env.md).

## Examples

### Basic startup

```bash
cd my-agent-project
elizaos start
```

### Starting with configuration

```bash
elizaos start --configure
```

### Starting with a custom port

```bash
elizaos start --port 8080
```

### Starting with multiple characters

```bash
# Using the --character option with multiple paths
elizaos start --character ./character1.json ./character2.json

# You can also specify multiple paths together
elizaos start --character character1.json character2.json character3.json

# Characters can be specified without the .json extension
elizaos start --character character1 character2
```

### Using remote character URLs

```bash
# Load characters from URLs
elizaos start --character https://example.com/characters/assistant.json

# Mix URLs and local files
elizaos start --character https://example.com/char1.json ./local-character.json
```

## Building Before Starting

To build your project before starting it:

```bash
elizaos start --build
```

This will compile your TypeScript files and prepare the project for execution.

## Error Handling

If any character files fail to load, ElizaOS will:

1. Log errors for each failed character
2. Continue starting the server with any successfully loaded characters
3. Fall back to the default Eliza character if no characters could be loaded

## Related Commands

- [`dev`](./dev.md): Run in development mode with hot reloading
- [`env`](./env.md): Configure environment variables
