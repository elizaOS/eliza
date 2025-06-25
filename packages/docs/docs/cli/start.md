---
sidebar_position: 3
title: Start Command
description: Launch and manage ElizaOS projects and agents in production mode
keywords: [start, production, deployment, configuration, runtime, services, agents]
image: /img/cli.jpg
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Start Command

Start the Eliza agent with configurable plugins and services.

<Tabs>
<TabItem value="overview" label="Overview & Options" default>

## Usage

```bash
elizaos start [options]
```

## Options

| Option                   | Description                                                                    |
| ------------------------ | ------------------------------------------------------------------------------ |
| `-c, --configure`        | Force reconfiguration of services and AI models (bypasses saved configuration) |
| `--character [paths...]` | Character file(s) to use - accepts paths or URLs                               |
| `--build`                | Build the project before starting                                              |
| `--no-build`             | Skip the build step before starting                                            |
| `-p, --port <port>`      | Port to listen on (default: 3000)                                              |
| `--quiet`                | Suppress all non-error output to the console                                   |

</TabItem>
<TabItem value="examples" label="Examples">

### Basic Usage

```bash
# Start with default configuration
elizaos start

# Start on custom port
elizaos start --port 8080

# Build project before starting
elizaos start --build

# Force reconfiguration
elizaos start --configure
```

### Suppressing Output

```bash
# Start quietly, only showing errors
elizaos start --quiet
```

### Character Configuration

```bash
# Start with single character file
elizaos start --character ./character.json

# Start with multiple character files
elizaos start --character ./char1.json ./char2.json

# Mix local files and URLs
elizaos start --character ./local.json https://example.com/remote.json

# Character files without .json extension
elizaos start --character assistant support-bot

# Comma-separated format also works
elizaos start --character "char1.json,char2.json"
```

### Advanced Configurations

```bash
# Build and configure before starting
elizaos start --build --configure

# Start with specific character on custom port
elizaos start --character ./my-bot.json --port 4000

# Complete setup for production deployment
elizaos start --character ./production-bot.json --port 3000 --build
```

### Production Deployment

```bash
# With environment file
cp .env.production .env
elizaos start --build

# Background process (Linux/macOS)
nohup elizaos start --build > elizaos.log 2>&1 &
```

### Health Checks

```bash
# Verify service is running
curl http://localhost:3000/health

# Check process status
ps aux | grep elizaos

# Monitor logs
tail -f elizaos.log
```

</TabItem>
<TabItem value="guides" label="Guides & Concepts">

## Production Features

When you run `start`, ElizaOS provides production-ready features:

1. **Optimized Performance**: Runs with production optimizations
2. **Stable Configuration**: Uses saved configuration by default
3. **Service Management**: Handles service connections and disconnections
4. **Error Recovery**: Automatic recovery from transient errors
5. **Resource Management**: Efficient resource allocation and cleanup

## Startup Process

When you run the `start` command, ElizaOS:

1. **Project Detection**: Detects whether you're in a project or plugin directory
2. **Configuration Loading**: Loads and validates the configuration
3. **Database Initialization**: Initializes the database system
4. **Character Loading**: Loads character files (plugins are loaded from character.plugins array)
5. **Plugin Loading**: Loads plugins specified in each character's configuration
6. **Service Startup**: Starts any configured services
7. **Knowledge Processing**: Processes knowledge files if present
8. **API Server**: Starts the HTTP API server
9. **Agent Runtime**: Initializes agent runtimes
10. **Event Listening**: Begins listening for messages and events

### Plugin Loading

Plugins are loaded exclusively from character files. Each character specifies its required plugins in the `plugins` array:

```json
{
  "name": "MyAssistant",
  "plugins": [
    "@elizaos/plugin-openai",
    "@elizaos/plugin-discord"
  ],
  // ... other character configuration
}
```

The runtime will automatically install any missing plugins when starting. You don't need to manually install plugins in your project's package.json.

</TabItem>
<TabItem value="troubleshooting" label="Troubleshooting">

## Troubleshooting

### Startup Failures

```bash
# Check if another instance is running
ps aux | grep elizaos
pkill -f elizaos

# Clear any conflicting processes
# Press Ctrl+C in the terminal where elizaos start is running
elizaos start
```

### Port Conflicts

```bash
# Check what's using the port
lsof -i :3000

# Use different port
elizaos start --port 3001

# Or stop conflicting service
sudo kill -9 $(lsof -ti:3000)
elizaos start
```

### Character Loading Issues

```bash
# Verify character file exists and is valid JSON
cat ./character.json | jq .

# Test with absolute path
elizaos start --character /full/path/to/character.json

# Start without character to use default
elizaos start
```

### Plugin Loading Issues

If plugins fail to load:

1. **Check Character File**: Ensure plugins are listed in the character's `plugins` array
2. **Verify Plugin Names**: Use correct package names (e.g., `@elizaos/plugin-openai`)
3. **Network Issues**: The runtime needs internet access to install missing plugins
4. **Clear Cache**: Try clearing the npm cache if plugins fail to install

```bash
# Check character file plugins
cat character.json | jq .plugins

# Clear bun cache if needed
bun pm cache rm
```

### Configuration Problems

```bash
# Force reconfiguration to fix corrupted settings
elizaos start --configure

# Check environment variables
elizaos env list

# Reset environment if needed
elizaos env reset
elizaos start --configure
```

### Build Failures

```bash
# Clean build and retry
elizaos start --build

# Check for TypeScript errors
bun run build

# Install dependencies if missing
bun install
elizaos start --build
```

### Service Connection Issues

```bash
# Check internet connectivity
ping google.com

# Verify API keys are set
elizaos env list

# Test with minimal configuration
elizaos start --configure
```

</TabItem>
</Tabs>

## Project Detection

ElizaOS automatically detects the type of directory you're in and adjusts its behavior accordingly:

- **ElizaOS Projects**: Loads project configuration and starts defined agents
- **ElizaOS Plugins**: Runs in plugin test mode with the default character
- **Other Directories**: Uses the default Eliza character

## Configuration Management

### Default Configuration

- Uses saved configuration from previous runs
- Loads environment variables from `.env` file
- Applies project-specific settings

### Force Reconfiguration

```bash
# Bypass saved configuration and reconfigure all services
elizaos start --configure
```

This is useful when:

- You've changed API keys or service credentials
- You want to select different AI models
- Service configurations have changed
- Troubleshooting configuration issues

## Environment Variables

The `start` command automatically loads environment variables:

### From .env File

```bash
# ElizaOS looks for .env in the project directory
cd my-project
elizaos start  # Loads from ./my-project/.env
```

### Direct Environment Variables

```bash
# Set variables directly
OPENAI_API_KEY=your-key elizaos start

# Multiple variables
OPENAI_API_KEY=key1 DISCORD_TOKEN=token1 elizaos start
```

## Error Handling

### Character Loading Errors

If character files fail to load, ElizaOS will:

1. **Log Errors**: Display detailed error messages for each failed character
2. **Continue Starting**: Use any successfully loaded characters
3. **Fallback**: Use the default Eliza character if no characters load successfully

### Service Connection Errors

- Automatic retry for transient connection issues
- Graceful degradation when optional services are unavailable
- Error logging with recovery suggestions

## Port Management

### Default Port

- Default: `3000`
- Automatically detects if port is in use
- Suggests alternative ports if default is unavailable

### Custom Port

```bash
# Specify custom port
elizaos start --port 8080

# Check if port is available first
netstat -an | grep :8080
elizaos start --port 8080
```

## Build Process

### Automatic Building

```bash
# Build before starting (recommended for production)
elizaos start --build
```

### When to Use --build

- **First deployment**: Ensure all TypeScript is compiled
- **After code changes**: Refresh compiled output
- **Production deployment**: Guarantee latest build
- **Troubleshooting**: Eliminate build-related issues

## Health Checks

```bash
# Verify service is running
curl http://localhost:3000/health

# Check process status
ps aux | grep elizaos

# Monitor logs
tail -f elizaos.log
```

## Related Commands

- [`create`](./create.md): Create a new project to start
- [`dev`](./dev.md): Run in development mode with hot reloading
- [`agent`](./agent.md): Manage individual agents
- [`env`](./env.md): Configure environment variables
- [`stop`](./stop.md): Stop running agents
