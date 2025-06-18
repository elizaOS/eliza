---
sidebar_position: 20
title: Global Options
description: Global flags that can be used with any ElizaOS CLI command
keywords: [CLI, global options, flags, configuration, logging, help]
image: /img/cli.jpg
---

# Global CLI Options

These options can be used with any `elizaos` command to control its behavior.

## Usage

```bash
elizaos [global-options] <command> [command-options]
```

## Options Reference

### Output and Logging

-   `--no-emoji`: Disables emoji characters in the output. This is useful for CI/CD environments or terminals that do not render emojis correctly.
-   `--verbose`: Enables verbose logging, providing detailed, step-by-step output for debugging purposes.
-   `--quiet`: Suppresses all non-essential output, showing only critical errors.

### Configuration

-   `--config <path>`: Specifies a path to a custom configuration file, overriding the default configuration.
-   `--no-auto-install`: Disables the automatic prompt to install Bun if it is not detected.

### Help and Version

-   `-h, --help`: Displays detailed help information for any command or subcommand.
-   `-v, --version`: Shows the currently installed version of the ElizaOS CLI.

## Examples

### Controlling Output

```bash
# Get verbose output for the start command for debugging
elizaos --verbose start

# Run tests with clean output for a CI/CD pipeline
elizaos --no-emoji --quiet test
```

### Using a Custom Configuration

```bash
# Start the agent using a specific configuration file
elizaos --config ./path/to/my-config.json start
```

### Getting Information

```bash
# Check your CLI version
elizaos --version

# Get help for the 'agent' command
elizaos agent --help

# Get help for the 'agent start' subcommand
elizaos agent start --help
``` 