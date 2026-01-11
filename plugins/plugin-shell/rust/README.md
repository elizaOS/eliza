# elizaOS Shell Plugin (Rust)

A secure shell command execution library for elizaOS that allows executing terminal commands within a restricted directory with command history tracking.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-shell = "1.2.0"
```

## Features

- **Cross-platform support**: Works on Linux, macOS, and Windows
- **Directory restriction**: Commands are restricted to a specified directory for safety
- **Command filtering**: Configurable list of forbidden commands
- **Timeout protection**: Automatic termination of long-running commands
- **Command history**: Tracks command execution history per conversation
- **File operation tracking**: Monitors file creation, modification, and deletion
- **Type safe**: Full Rust type safety with comprehensive error handling

## Usage

```rust
use elizaos_plugin_shell::{ShellConfig, ShellService, CommandResult};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create configuration
    let config = ShellConfig::builder()
        .enabled(true)
        .allowed_directory("/path/to/safe/directory")
        .timeout_ms(30000)
        .build()?;

    // Create service
    let mut service = ShellService::new(config);

    // Execute a command
    let result = service.execute_command("ls -la", Some("conv-123")).await;

    match result {
        Ok(r) if r.success => println!("Output: {}", r.stdout),
        Ok(r) => println!("Error: {}", r.stderr),
        Err(e) => println!("Failed: {}", e),
    }

    // Get command history
    let history = service.get_command_history("conv-123", Some(10));

    // Clear history
    service.clear_command_history("conv-123");

    Ok(())
}
```

## Configuration

The plugin can be configured via environment variables:

- `SHELL_ENABLED`: Enable/disable the plugin (default: false)
- `SHELL_ALLOWED_DIRECTORY`: Directory to restrict commands to
- `SHELL_TIMEOUT`: Command timeout in milliseconds (default: 30000)
- `SHELL_FORBIDDEN_COMMANDS`: Comma-separated list of forbidden commands

## Security

The plugin enforces several security measures:

1. **Directory Restriction**: All commands execute within the allowed directory
2. **Forbidden Commands**: Dangerous commands are blocked by default
3. **Path Traversal Protection**: Blocks `../` and similar patterns
4. **No Shell Expansion**: Commands execute without dangerous shell interpretation
5. **Timeout Protection**: Commands auto-terminate after timeout

## License

MIT



