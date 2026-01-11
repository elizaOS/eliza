# @elizaos/plugin-shell

A secure shell command execution plugin for ElizaOS that allows agents to run terminal commands within a restricted directory with command history tracking.

**Available in three languages with full feature parity:**

- 🟦 **TypeScript** - Primary implementation for Node.js
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
   SHELL_ENABLED=true
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

- ✅ **Cross-platform support**: Works on Linux, macOS, and Windows
- ✅ **Directory restriction**: Commands are restricted to a specified directory for safety
- ✅ **Command filtering**: Configurable list of forbidden commands
- ✅ **Timeout protection**: Automatic termination of long-running commands
- ✅ **Command history**: Tracks command execution history per conversation
- ✅ **File operation tracking**: Monitors file creation, modification, and deletion
- ✅ **Shell context provider**: Provides command history and working directory to agent context
- ✅ **Output capture**: Returns both stdout and stderr from executed commands
- ✅ **Safety first**: Disabled by default, requires explicit enabling
- ✅ **Multi-language**: Available in TypeScript, Python, and Rust

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

# Using pnpm
pnpm add @elizaos/plugin-shell
```

### Python

```bash
pip install elizaos-plugin-shell
```

### Rust

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-shell = "1.2.0"
```

## Configuration

Set the following environment variables:

```bash
# REQUIRED: Enable the shell plugin (disabled by default for safety)
SHELL_ENABLED=true

# REQUIRED: Set the allowed directory (commands can only run here)
SHELL_ALLOWED_DIRECTORY=/home/user/safe-workspace

# OPTIONAL: Set custom timeout in milliseconds (default: 30000)
SHELL_TIMEOUT=60000

# OPTIONAL: Add additional forbidden commands (comma-separated)
SHELL_FORBIDDEN_COMMANDS=rm,mv,cp,chmod,chown,shutdown,reboot
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
```

### Python

```python
from elizaos_plugin_shell import ShellService, ShellConfig

config = ShellConfig.from_env()
service = ShellService(config)

result = await service.execute_command("ls -la", "conversation-123")
if result.success:
    print(f"Output: {result.stdout}")
```

### Rust

```rust
use elizaos_plugin_shell::{ShellConfig, ShellService};

let config = ShellConfig::from_env()?;
let mut service = ShellService::new(config);

let result = service.execute_command("ls -la", Some("conversation-123")).await?;
if result.success {
    println!("Output: {}", result.stdout);
}
```

## 📋 Available Actions

### EXECUTE_COMMAND

Executes ANY shell command within the allowed directory, including file operations.

**Examples:**

- `run ls -la` - List files with details
- `execute npm test` - Run tests
- `create a file called hello.txt` - Creates a new file
- `check git status` - Show git repository status

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

### Python

```bash
cd python
pip install -e ".[dev]"  # Install with dev dependencies
pytest                    # Run tests
mypy elizaos_plugin_shell # Type check
```

### Rust

```bash
cd rust
cargo build --release  # Build
cargo test             # Run tests
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

| Field               | Type     | Default | Description                       |
| ------------------- | -------- | ------- | --------------------------------- |
| `enabled`           | boolean  | false   | Whether shell is enabled          |
| `allowedDirectory`  | string   | cwd     | Directory to restrict commands to |
| `timeout`           | number   | 30000   | Timeout in milliseconds           |
| `forbiddenCommands` | string[] | [...]   | List of forbidden commands        |

## 🤝 Contributing

Contributions are welcome! Please ensure:

1. All three language implementations stay in feature parity
2. Tests pass for all languages
3. Follow the code style of each language
4. Update documentation as needed

## 📝 License

MIT - See [LICENSE](./LICENSE) for details.
