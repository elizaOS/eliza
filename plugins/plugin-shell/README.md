# @elizaos/plugin-shell

A secure shell command execution plugin for ElizaOS that allows agents to run terminal commands within a restricted directory with command history tracking.

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

## Prerequisites

- Node.js 20+ and bun installed
- ElizaOS project set up
- A designated safe directory for command execution

## 🚀 Quick Start

### Step 1: Install the Plugin

```bash
# Using bun (recommended)
bun add @elizaos/plugin-shell

# Using npm
npm install @elizaos/plugin-shell

# Using pnpm
pnpm add @elizaos/plugin-shell
```

### Step 2: Configure Environment Variables

Create or edit `.env` file in your project root:

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

### Step 3: Add to Your Character

```typescript
import { Character } from "@elizaos/core";

const myCharacter: Character = {
    name: "DevAssistant",
    description: "A helpful development assistant",
    plugins: ["@elizaos/plugin-shell"],  // Add the shell plugin
    // ... rest of your character config
};
```

### Step 4: Run Your Agent

```bash
bun start
```

Your agent can now execute shell commands! Try:
- "Show me what files are in this directory"
- "Run ls -la"
- "Create a file called hello.txt"
- "Check the git status"

## 📋 Available Actions

### EXECUTE_COMMAND

Executes ANY shell command within the allowed directory, including file operations.

**Examples:**
- `run ls -la` - List files with details
- `execute npm test` - Run tests
- `show me the current directory` - Execute pwd
- `create a file called hello.txt` - Creates a new file
- `write 'Hello World' to output.txt` - Write content to file
- `make a new directory called src` - Create directory
- `check git status` - Show git repository status

### CLEAR_SHELL_HISTORY

Clears the command history for the current conversation.

**Examples:**
- `clear my shell history`
- `reset the terminal history`
- `delete command history`

## 🧠 Shell History Provider

The plugin includes a `SHELL_HISTORY` provider that makes the following information available to the agent:

- **Recent Commands**: Last 10 executed commands with their outputs
- **Current Working Directory**: The current directory within the allowed path
- **Allowed Directory**: The configured safe directory boundary
- **File Operations**: Recent file creation, modification, and deletion operations

This context helps the agent understand previous commands and maintain continuity in conversations.

## 🔒 Security Considerations

### 1. Directory Restriction
The plugin enforces that ALL commands execute within `SHELL_ALLOWED_DIRECTORY`:
- Attempts to navigate outside are blocked
- Absolute paths outside the boundary are rejected
- `cd ..` stops at the allowed directory root

### 2. Forbidden Commands
By default, these potentially dangerous commands are blocked:
- **Destructive**: `rm`, `rmdir`
- **Permission changes**: `chmod`, `chown`, `chgrp`
- **System operations**: `shutdown`, `reboot`, `halt`, `poweroff`
- **Process control**: `kill`, `killall`, `pkill`
- **User management**: `sudo`, `su`, `passwd`, `useradd`, `userdel`
- **Disk operations**: `format`, `fdisk`, `mkfs`, `dd`, `shred`

**Note:** Safe file operations ARE allowed: `touch`, `echo`, `cat`, `mkdir`, `ls`, etc.

### 3. Additional Safety Features
- **No Shell Expansion**: Commands execute without dangerous shell interpretation
- **Timeout Protection**: Commands auto-terminate after timeout
- **Command History**: All executed commands are logged for audit
- **Path Traversal Protection**: Blocks `../` and similar patterns

## 🎯 Common Use Cases

### Development Assistant
```bash
SHELL_ALLOWED_DIRECTORY=/home/user/projects
SHELL_TIMEOUT=120000  # 2 minutes for build commands
```

Your agent can help with:
- Running tests and builds
- Git operations
- File management
- Code generation

### System Monitor
```bash
SHELL_ALLOWED_DIRECTORY=/var/log
SHELL_FORBIDDEN_COMMANDS=rm,mv,cp,chmod,chown  # Read-only access
```

Your agent can:
- Check log files
- Monitor system status
- Generate reports

### Content Creator
```bash
SHELL_ALLOWED_DIRECTORY=/home/user/content
```

Your agent can:
- Create and organize files
- Process text files
- Manage content structure

## 🔧 Troubleshooting

### Plugin Not Working

**Checklist:**
- ✅ Is `SHELL_ENABLED=true` in your `.env`?
- ✅ Does `SHELL_ALLOWED_DIRECTORY` exist and is accessible?
- ✅ Is the plugin added to your character's `plugins` array?
- ✅ Check logs for "Shell service initialized"

### "Shell plugin is disabled"

**Solution:** Set `SHELL_ENABLED=true` in your `.env` file

### "Cannot navigate outside allowed directory"

**This is a security feature!** The agent cannot access files outside `SHELL_ALLOWED_DIRECTORY`.

**Solution:** 
- Move your work to the allowed directory, OR
- Change `SHELL_ALLOWED_DIRECTORY` to include your work area

### "Command is forbidden by security policy"

The command you're trying to run is in the forbidden list.

**Solution:** 
- Use alternative safe commands, OR
- Remove the command from `SHELL_FORBIDDEN_COMMANDS` if you trust your environment

### Command Not Found

The command might not be in the system PATH.

**Solution:**
- Use full paths: `/usr/bin/git` instead of `git`
- Ensure required tools are installed

## 📚 Advanced Configuration

### Per-Conversation History

Each conversation maintains its own:
- Command history (last 100 commands)
- Working directory context
- File operation tracking

This ensures privacy between different users/conversations.

### Custom Timeout for Long Operations

```bash
# For development environments with slow builds
SHELL_TIMEOUT=300000  # 5 minutes
```

### Minimal Forbidden Commands

```bash
# For trusted environments
SHELL_FORBIDDEN_COMMANDS=shutdown,reboot
```

### Read-Only Mode

```bash
# Block all write operations
SHELL_FORBIDDEN_COMMANDS=rm,rmdir,mv,cp,touch,mkdir,echo,cat,chmod,chown,dd
```

## 🧪 Development & Testing

```bash
# Clone the repository
git clone https://github.com/elizaos/eliza.git
cd eliza/packages/plugin-shell

# Install dependencies
bun install

# Build the plugin
bun run build

# Run tests
bun test

# Run with debug logging
DEBUG=eliza:* bun start
```

### Testing Your Setup

1. **Test Basic Commands**: Try `ls`, `pwd`, `echo test`
2. **Test Restrictions**: Try `cd /` (should fail)
3. **Test History**: Run commands then ask "what commands have I run?"
4. **Test File Ops**: Create a file, then check history for tracking

## 📊 How It Works

### Architecture
```
┌─────────────────┐     ┌──────────────────┐     ┌────────────────┐
│   Your Agent    │────▶│  Shell Plugin    │────▶│  cross-spawn   │
│                 │     │                  │     │                │
│  "run ls -la"   │     │ - Path validation│     │ - Secure exec  │
│                 │     │ - History track  │     │ - No shell     │
└─────────────────┘     │ - Timeout mgmt   │     └────────────────┘
                        └──────────────────┘
```

### Execution Flow
1. Agent receives command request
2. Plugin validates command safety
3. Checks directory boundaries
4. Executes via `cross-spawn` (no shell)
5. Captures output and errors
6. Tracks in conversation history
7. Returns formatted result

## 🤝 Contributing

Contributions are welcome! Please:
1. Check existing issues first
2. Follow the code style
3. Add tests for new features
4. Update documentation

### Running Plugin Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test src/__tests__/shellHistory.test.ts

# Run tests in watch mode
bun test --watch
```

## 📖 Additional Resources

- [ElizaOS Documentation](https://github.com/elizaos/eliza)
- [Security Best Practices](https://owasp.org/www-community/attacks/Command_Injection)
- [Cross-spawn Documentation](https://github.com/moxystudio/node-cross-spawn)

## 📝 License

This plugin is part of the ElizaOS project. See the main repository for license information. 