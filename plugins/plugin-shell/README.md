# @elizaos/plugin-shell

A comprehensive shell command execution plugin for ElizaOS with PTY support, background execution, session management, and security restrictions.

**Key Features:**

- 🔄 **PTY Support** - Run interactive terminal applications with full pseudo-terminal support
- ⏱️ **Background Execution** - Long-running commands automatically background with session management
- 📋 **Session Management** - Track, poll, and interact with running processes
- 🔒 **Security First** - Directory restrictions, forbidden commands, and timeout protection
- 📝 **Command History** - Per-conversation command tracking

**Available in three languages:**

- 🟦 **TypeScript** - Primary implementation for Node.js (full feature support)
- 🐍 **Python** - Native Python implementation
- 🦀 **Rust** - High-performance Rust implementation

## 🚨 TL;DR - Quick Setup

**Just want your agent to execute commands? Here's the fastest path:**

1. **Install the plugin**:

   ```bash
   cd your-eliza-project
   bun add @elizaos/plugin-shell
   ```

2. **Create/update your `.env`**:

   ```bash
   SHELL_ALLOWED_DIRECTORY=/path/to/safe/directory
   ```

3. **Add to your character**:

   ```typescript
   const character = {
     // ... other config
     plugins: ["@elizaos/plugin-shell"],
   };
   ```

4. **Run:** `bun start`

⚠️ **Security note:** The agent can ONLY execute commands within `SHELL_ALLOWED_DIRECTORY` - choose wisely!

## Features

### Core Features
- ✅ **Cross-platform support**: Works on Linux, macOS, and Windows
- ✅ **Directory restriction**: Commands are restricted to a specified directory for safety
- ✅ **Command filtering**: Configurable list of forbidden commands
- ✅ **Timeout protection**: Automatic termination of long-running commands
- ✅ **Command history**: Tracks command execution history per conversation
- ✅ **File operation tracking**: Monitors file creation, modification, and deletion
- ✅ **Shell context provider**: Provides command history and working directory to agent context
- ✅ **Output capture**: Returns both stdout and stderr from executed commands
- ✅ **Safety first**: Disabled by default, requires explicit enabling

### Advanced Features (TypeScript)
- ✅ **PTY Support**: Run interactive terminal applications (vim, htop, etc.) with `@lydell/node-pty`
- ✅ **Background Execution**: Commands automatically background after configurable yield window
- ✅ **Session Management**: Track running/finished sessions, poll output, send keys
- ✅ **Process Control**: List, poll, log, write, send-keys, submit, paste, kill, clear, remove
- ✅ **Output Truncation**: Configurable max output with intelligent truncation
- ✅ **Platform-specific Shell**: Auto-detects shell (bash, sh, PowerShell on Windows)

## Project Structure

```
plugin-shell/
├── typescript/          # TypeScript implementation
│   ├── actions/         # EXECUTE_COMMAND, CLEAR_SHELL_HISTORY
│   ├── providers/       # SHELL_HISTORY provider
│   ├── services/        # ShellService
│   ├── utils/           # Path validation, security checks
│   ├── types/           # Type definitions
│   └── __tests__/       # Unit tests
├── python/              # Python implementation
│   ├── elizaos_plugin_shell/
│   │   ├── service.py   # ShellService
│   │   ├── path_utils.py
│   │   └── types.py
│   └── tests/           # Python tests
├── rust/                # Rust implementation
│   ├── src/
│   │   ├── lib.rs
│   │   ├── service.rs   # ShellService
│   │   ├── path_utils.rs
│   │   └── types.rs
│   └── tests/           # Integration tests
└── package.json         # NPM package config
```

## Installation

### TypeScript (Node.js)

```bash
# Using bun (recommended)
bun add @elizaos/plugin-shell

# Using npm
npm install @elizaos/plugin-shell
```
## Configuration

Set the following environment variables:

```bash
# Set the allowed directory (commands can only run here)
SHELL_ALLOWED_DIRECTORY=/home/user/safe-workspace

# OPTIONAL: Set custom timeout in milliseconds (default: 30000)
SHELL_TIMEOUT=60000

# OPTIONAL: Add additional forbidden commands (comma-separated)
SHELL_FORBIDDEN_COMMANDS=rm,mv,cp,chmod,chown,shutdown,reboot

# OPTIONAL: Maximum output characters to capture (default: 200000)
SHELL_MAX_OUTPUT_CHARS=200000

# OPTIONAL: Milliseconds before backgrounding (default: 10000)
SHELL_BACKGROUND_MS=10000

# OPTIONAL: Allow background execution (default: true)
SHELL_ALLOW_BACKGROUND=true

# OPTIONAL: Session record TTL in milliseconds (default: 1800000 = 30min)
SHELL_JOB_TTL_MS=1800000
```

## Usage Examples

### TypeScript

```typescript
import { shellPlugin, ShellService } from "@elizaos/plugin-shell";

// Use as a plugin
const character = {
  plugins: [shellPlugin],
};

// Or use the service directly
const service = new ShellService(runtime);
const result = await service.executeCommand("ls -la", "conversation-123");

// Advanced: Use exec with PTY and background support
const execResult = await service.exec("npm install", {
  pty: true,         // Run with pseudo-terminal
  background: false, // Or yieldMs: 5000 to auto-background after 5s
  timeout: 300,      // 5 minute timeout
  workdir: "/project",
});

if (execResult.status === "running") {
  console.log(`Background session: ${execResult.sessionId}`);
  
  // Poll for updates
  const pollResult = await service.processAction({
    action: "poll",
    sessionId: execResult.sessionId,
  });
  console.log(pollResult.message);
}

// Get the service from an Eliza agent runtime
const shellService = runtime.getService<ShellService>("shell");
```
## 📋 Available Actions

### EXECUTE_COMMAND

Executes ANY shell command within the allowed directory, including file operations.

**Examples:**

- `run ls -la` - List files with details
- `execute npm test` - Run tests
- `create a file called hello.txt` - Creates a new file
- `check git status` - Show git repository status

### MANAGE_PROCESS

Manage running and finished shell sessions. Supports the following operations:

| Action      | Description                                    |
|-------------|------------------------------------------------|
| `list`      | List all running and finished sessions         |
| `poll`      | Get new output from a running session          |
| `log`       | Get session output with offset/limit           |
| `write`     | Write data to session stdin                    |
| `send-keys` | Send terminal key sequences (arrows, ctrl, etc)|
| `submit`    | Send carriage return (Enter)                   |
| `paste`     | Paste text with bracketed paste mode           |
| `kill`      | Kill a running session                         |
| `clear`     | Clear a finished session record                |
| `remove`    | Kill (if running) and remove session           |

**Examples:**

- `list all running processes`
- `check session calm-harbor`
- `kill the process swift-reef`
- `send enter to session brisk-cove`

### CLEAR_SHELL_HISTORY

Clears the command history for the current conversation.

**Examples:**

- `clear my shell history`
- `reset the terminal history`

## 🧠 Shell History Provider

The plugin includes a `SHELL_HISTORY` provider that makes the following information available to the agent:

- **Recent Commands**: Last 10 executed commands with their outputs
- **Current Working Directory**: The current directory within the allowed path
- **Allowed Directory**: The configured safe directory boundary
- **File Operations**: Recent file creation, modification, and deletion operations

## 🔒 Security Considerations

### Directory Restriction

All commands execute within `SHELL_ALLOWED_DIRECTORY`:

- Attempts to navigate outside are blocked
- Absolute paths outside the boundary are rejected
- `cd ..` stops at the allowed directory root

### Forbidden Commands

By default, these potentially dangerous commands are blocked:

- **Destructive**: `rm -rf /`, `rmdir`
- **Permission changes**: `chmod 777`, `chown`, `chgrp`
- **System operations**: `shutdown`, `reboot`, `halt`, `poweroff`
- **Process control**: `kill -9`, `killall`, `pkill`
- **User management**: `sudo rm -rf`, `su`, `passwd`, `useradd`, `userdel`
- **Disk operations**: `format`, `fdisk`, `mkfs`, `dd if=/dev/zero`, `shred`

### Additional Safety Features

- **No Shell Expansion**: Commands execute without dangerous shell interpretation
- **Timeout Protection**: Commands auto-terminate after timeout
- **Command History**: All executed commands are logged for audit
- **Path Traversal Protection**: Blocks `../` and similar patterns

## 🧪 Development & Testing

### TypeScript

```bash
cd typescript
bun run build.ts     # Build
npx vitest           # Run tests
```
### All Languages

```bash
# From plugin root
bun run build          # Build TypeScript
bun run build:python   # Build Python
bun run build:rust     # Build Rust
bun run test           # Test TypeScript
bun run test:python    # Test Python
bun run test:rust      # Test Rust
```

## 📖 API Reference

### CommandResult

| Field        | Type                | Description                               |
| ------------ | ------------------- | ----------------------------------------- |
| `success`    | boolean             | Whether the command executed successfully |
| `stdout`     | string              | Standard output from the command          |
| `stderr`     | string              | Standard error output                     |
| `exitCode`   | number \| null      | Exit code of the command                  |
| `error`      | string \| undefined | Error message if command failed           |
| `executedIn` | string              | Directory where command was executed      |

### FileOperation

| Field             | Type                | Description                                                        |
| ----------------- | ------------------- | ------------------------------------------------------------------ |
| `type`            | FileOperationType   | Type of operation (create, write, read, delete, mkdir, move, copy) |
| `target`          | string              | Target file/directory path                                         |
| `secondaryTarget` | string \| undefined | Secondary target for move/copy                                     |

### ShellConfig

| Field                   | Type     | Default  | Description                          |
| ----------------------- | -------- | -------- | ------------------------------------ |
| `enabled`               | boolean  | false    | Whether shell is enabled             |
| `allowedDirectory`      | string   | cwd      | Directory to restrict commands to    |
| `timeout`               | number   | 30000    | Timeout in milliseconds              |
| `forbiddenCommands`     | string[] | [...]    | List of forbidden commands           |
| `maxOutputChars`        | number   | 200000   | Max output characters to capture     |
| `pendingMaxOutputChars` | number   | 200000   | Max pending output per stream        |
| `defaultBackgroundMs`   | number   | 10000    | Default background yield window      |
| `allowBackground`       | boolean  | true     | Allow background execution           |

### ProcessSession

| Field                 | Type                    | Description                           |
| --------------------- | ----------------------- | ------------------------------------- |
| `id`                  | string                  | Unique session identifier (slug)      |
| `command`             | string                  | The executed command                  |
| `pid`                 | number \| undefined     | Process ID                            |
| `startedAt`           | number                  | Start timestamp                       |
| `cwd`                 | string \| undefined     | Working directory                     |
| `aggregated`          | string                  | Accumulated output                    |
| `tail`                | string                  | Last 2000 chars of output             |
| `exited`              | boolean                 | Whether process has exited            |
| `exitCode`            | number \| null          | Exit code (if exited)                 |
| `exitSignal`          | string \| number \| null| Exit signal (if killed)               |
| `truncated`           | boolean                 | Whether output was truncated          |
| `backgrounded`        | boolean                 | Whether running in background         |

### ExecResult

```typescript
type ExecResult =
  | { status: "running"; sessionId: string; pid?: number; startedAt: number; cwd?: string; tail?: string }
  | { status: "completed" | "failed"; exitCode: number | null; durationMs: number; aggregated: string; cwd?: string; timedOut?: boolean; reason?: string }
```

### ExecuteOptions

| Field           | Type                        | Description                           |
| --------------- | --------------------------- | ------------------------------------- |
| `workdir`       | string                      | Working directory                     |
| `env`           | Record<string, string>      | Additional environment variables      |
| `yieldMs`       | number                      | Yield to background after this time   |
| `background`    | boolean                     | Run immediately in background         |
| `timeout`       | number                      | Timeout in seconds                    |
| `pty`           | boolean                     | Use pseudo-terminal                   |
| `conversationId`| string                      | Conversation ID for history tracking  |
| `scopeKey`      | string                      | Scope key for session isolation       |
| `sessionKey`    | string                      | Session key for notifications         |
| `notifyOnExit`  | boolean                     | Notify on background exit             |
| `onUpdate`      | (session) => void           | Callback for output updates           |

## 🤝 Contributing

Contributions are welcome! Please ensure:

1. All three language implementations stay in feature parity
2. Tests pass for all languages
3. Follow the code style of each language
4. Update documentation as needed

## 📝 License

MIT - See [LICENSE](./LICENSE) for details.
