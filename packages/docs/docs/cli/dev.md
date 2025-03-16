---
sidebar_position: 5
---

# Dev Command

The `dev` command runs your ElizaOS project or plugin in development mode with auto-rebuild and restart on file changes. This is the recommended way to develop and test your implementations locally.

## Usage

```bash
npx @elizaos/cli dev [options]
```

## Options

| Option         | Description                                                          |
| -------------- | -------------------------------------------------------------------- |
| `--port`, `-p` | Port to listen on                                                    |
| `--configure`  | Reconfigure services and AI models (skips using saved configuration) |
| `--character`  | Path or URL to character file to use instead of default              |
| `--build`      | Build the project before starting                                    |

## Development Features

When you run `dev`, ElizaOS provides several developer-friendly features:

1. **Auto Rebuilding**: Automatically rebuilds your project when source files change
2. **Auto Restarting**: Restarts the server after rebuilds to apply changes
3. **File Watching**: Monitors your source files for changes
4. **TypeScript Support**: Compiles TypeScript files during rebuilds

## What Happens During Dev Mode

When you run the `dev` command, ElizaOS:

1. Detects whether you're in a project or plugin directory
2. Builds the project initially
3. Starts the server using the `start` command with your options
4. Sets up file watching for .ts, .js, .tsx, and .jsx files
5. Rebuilds and restarts when files change

## Examples

### Basic Development Mode

Start your project in development mode:

```bash
# Navigate to your project
cd my-agent-project

# Start development mode
npx @elizaos/cli dev
```

### Custom Port

Run the development server on a specific port:

```bash
npx @elizaos/cli dev --port 8080
```

### Using a Custom Character

Use a specific character file:

```bash
npx @elizaos/cli dev --character ./characters/custom-assistant.json
```

### Force Configuration

Skip using saved configuration and reconfigure services:

```bash
npx @elizaos/cli dev --configure
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

## Project Type Detection

The dev command automatically detects whether you're working with:

1. **Project**: A complete ElizaOS project with agents
2. **Plugin**: An ElizaOS plugin that provides extensions

It determines this by checking:

- The package.json metadata
- Export patterns in src/index.ts
- Project structure

## Exiting Dev Mode

To stop the development server:

- Press `Ctrl+C` in the terminal
- The server and file watcher will gracefully shut down

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
- [`build`](./projects.md): Build your project manually
- [`project`](./projects.md): Manage project settings
