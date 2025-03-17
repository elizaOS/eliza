---
sidebar_position: 3
---

# Start Command

The `start` command launches an ElizaOS project or agent in production mode. It initializes the agent runtime, loads plugins, connects to services, and starts handling interactions.

## Usage

```bash
npx @elizaos/cli start [options]
```

## Options

| Option               | Description                                                          |
| -------------------- | -------------------------------------------------------------------- |
| `-p, --port <port>`  | Port to listen on (default: 3000)                                    |
| `-c, --configure`    | Reconfigure services and AI models (skips using saved configuration) |
| `--character <path>` | Path or URL to character file to use instead of default              |
| `--build`            | Build the project before starting                                    |

## Starting a Project

When you run the `start` command, ElizaOS detects what's in your current directory:

1. If a project is detected, it loads all agents and plugins defined in the project
2. If a plugin is detected, it loads the default character with your plugin for testing
3. If neither is detected, it loads the default ElizaOS character

ElizaOS will:

1. Load and validate the configuration
2. Initialize the database system
3. Load required plugins
4. Start any configured services
5. Process knowledge files if present
6. Start the HTTP API server
7. Initialize agent runtimes
8. Begin listening for messages and events

```bash
# Navigate to your project directory
cd my-agent-project

# Start the project
npx @elizaos/cli start
```

## Environment Variables

The `start` command will look for an `.env` file in the project directory and load environment variables from it. You can also set environment variables directly:

```bash
# Set environment variables directly
OPENAI_API_KEY=your-api-key npx @elizaos/cli start
```

## Project Detection

ElizaOS automatically detects projects in the current directory by looking for:

1. A `package.json` with an `eliza.type` field set to `project`
2. A main entry point that exports a project configuration with agents
3. Other project indicators in the package metadata

## Plugin Testing

If you're developing a plugin, you can test it by running the `start` command in the plugin directory:

```bash
# In your plugin directory
cd my-plugin
npx @elizaos/cli start
```

This will load the default ElizaOS character with your plugin enabled for testing.

## Building Before Starting

To build your project before starting it:

```bash
npx @elizaos/cli start --build
```

This will compile your TypeScript files and prepare the project for execution.

## Examples

### Basic startup

```bash
cd my-agent-project
npx @elizaos/cli start
```

### Starting with configuration

```bash
npx @elizaos/cli start --configure
```

### Starting with a custom port

```bash
npx @elizaos/cli start --port 8080
```

### Starting with a custom character

```bash
npx @elizaos/cli start --character path/to/character.json
```

## Related Commands

- [`dev`](./dev.md): Run in development mode with hot reloading
- [`env`](./env.md): Configure environment variables
- [`plugin`](./plugins.md): Manage plugins
- [`project`](./projects.md): Manage projects
