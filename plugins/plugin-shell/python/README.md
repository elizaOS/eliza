# elizaOS Shell Plugin (Python)

A secure shell command execution plugin for elizaOS that allows agents to run terminal commands within a restricted directory with command history tracking.

## Installation

```bash
pip install elizaos-plugin-shell
```

## Features

- **Cross-platform support**: Works on Linux, macOS, and Windows
- **Directory restriction**: Commands are restricted to a specified directory for safety
- **Command filtering**: Configurable list of forbidden commands
- **Timeout protection**: Automatic termination of long-running commands
- **Command history**: Tracks command execution history per conversation
- **File operation tracking**: Monitors file creation, modification, and deletion
- **Type safe**: Full type annotations with Pydantic models

## Configuration

Set the following environment variables:

```bash
# Enable the shell plugin (disabled by default for safety)
SHELL_ENABLED=true

# Set the allowed directory (commands can only run here)
SHELL_ALLOWED_DIRECTORY=/path/to/safe/directory

# Optional: Set custom timeout in milliseconds (default: 30000)
SHELL_TIMEOUT=60000

# Optional: Add additional forbidden commands (comma-separated)
SHELL_FORBIDDEN_COMMANDS=rm,mv,cp,chmod,chown,shutdown,reboot
```

## Usage

```python
from elizaos_plugin_shell import ShellService, ShellConfig

# Load configuration
config = ShellConfig.from_env()

# Create service
service = ShellService(config)

# Execute a command
result = await service.execute_command("ls -la", conversation_id="conv-123")

if result.success:
    print(f"Output: {result.stdout}")
else:
    print(f"Error: {result.stderr}")

# Get command history
history = service.get_command_history("conv-123", limit=10)

# Clear history
service.clear_command_history("conv-123")
```

## Security

The plugin enforces several security measures:

1. **Directory Restriction**: All commands execute within `SHELL_ALLOWED_DIRECTORY`
2. **Forbidden Commands**: Dangerous commands are blocked by default
3. **Path Traversal Protection**: Blocks `../` and similar patterns
4. **No Shell Expansion**: Commands execute without dangerous shell interpretation
5. **Timeout Protection**: Commands auto-terminate after timeout

## License

MIT



