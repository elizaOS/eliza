---
sidebar_position: 7
title: Development Mode
description: Run ElizaOS projects in development mode with hot reloading and debugging
keywords: [development, hot reload, debugging, watch mode, local development]
image: /img/cli.jpg
---

# Dev Command

The `dev` command runs your ElizaOS project or plugin in development mode with auto-rebuild and restart on file changes. It provides detailed logging and is the recommended way to develop and test your implementations locally.

## Usage

> Note: Assumes you have the elizaos CLI tool installed

```bash
elizaos dev [options]
```

## Options

| Option                          | Description                        |
| ------------------------------- | ---------------------------------- |
| `-p, --port <port>`             | Port number to run the server on   |
| `-c, --configure`               | Reconfigure services and AI models |
| `-char, --character [paths...]` | Character file(s) to use           |
| `-b, --build`                   | Build the project before starting  |

## Development Features

When you run `dev`, ElizaOS provides several developer-friendly features:

1. **Auto Rebuilding**: Automatically rebuilds your project when source files change
2. **Auto Restarting**: Restarts the server after rebuilds to apply changes
3. **File Watching**: Monitors your source files for changes
4. **TypeScript Support**: Compiles TypeScript files during rebuilds
5. **Detailed Error Messages**: Provides comprehensive error information

## What Happens During Dev Mode

When you run the `dev` command, ElizaOS:

1. Detects whether you're in a project or plugin directory
2. Builds the project initially
3. Starts the server using the `start` command with your options
4. Sets up file watching for .ts, .js, .tsx, and .jsx files
5. Rebuilds and restarts when files change

For more information about project detection and startup process, see the [Start Command](./start.md#project-detection).

## Examples

### Basic Development Mode

```bash
# Navigate to your project
cd my-agent-project

# Start development mode
elizaos dev
```

### Custom Port

```bash
elizaos dev --port 8080
```

### Using a Single Character

```bash
elizaos dev --character ./characters/custom-assistant.json
```

### Using Multiple Characters

```bash
# Pass multiple characters separated by spaces
elizaos dev --character ./character1.json ./character2.json

# Or by commas
elizaos dev --character "character1.json,character2.json"

# Characters can be specified without the .json extension
elizaos dev --character character1 character2
```

### Force Configuration

```bash
elizaos dev --configure
```

## Development Process

A typical development workflow with ElizaOS:

1. **Edit code**: Modify TypeScript/JavaScript files in your project
2. **Automatic rebuild**: The dev server detects changes and rebuilds
3. **Automatic restart**: The server restarts with your changes
4. **Test**: Interact with your updated implementation
5. **Repeat**: Continue the development cycle

## File Watching

The dev command watches for changes in your project's source files, specifically:

- TypeScript files (`.ts`, `.tsx`)
- JavaScript files (`.js`, `.jsx`)

The file watcher ignores:

- `node_modules/` directory
- `dist/` directory
- `.git/` directory

## Logs and Debugging

The dev mode provides information about the file watching and rebuild process:

```
[info] Running in project mode
[info] Building project...
[success] Build successful
[info] Starting server...
[info] Setting up file watching for directory: /path/to/your/project
[success] File watching initialized in: /path/to/your/project/src
[info] File event: change - src/index.ts
[info] Triggering rebuild for file change: src/index.ts
[info] Rebuilding project after file change...
[success] Rebuild successful, restarting server...
```

## Troubleshooting

### Build failures

If your project fails to build:

```
[error] Initial build failed: Error message
[info] Continuing with dev mode anyway...
```

The server will still start, but you'll need to fix the build errors for proper functionality.

### File watching issues

If file changes aren't being detected:

1. Check if your files are in the watched directories
2. Ensure you're modifying the right types of files (.ts, .js, .tsx, .jsx)
3. Check for error messages in the console

## Related Commands

- [`start`](./start.md): Run your project in production mode
- [`test`](./test.md): Run tests for your project
