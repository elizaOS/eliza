# Logger Command

The `elizaos logger` command provides logging configuration for ElizaOS agents. It supports multiple output destinations (transports), customizable log levels, and flexible formatting options.

## Overview

ElizaOS provides a comprehensive logging system that can be configured through:
- Interactive CLI commands
- Persistent configuration files (stored in local `.eliza` directory)
- Command-line options during agent startup

### Architecture

The logging system is split between two layers:

- **Core Logger** (`@elizaos/core`): Handles console output with pretty formatting, browser-compatible
- **CLI Layer** (`@elizaos/cli`): Adds advanced features like file output, manages hybrid logging

This architecture ensures:
- ✅ Browser compatibility (core logger has no Node.js dependencies)
- ✅ Advanced CLI features (file logging, format options)
- ✅ Clean separation of concerns

## Quick Start

### Interactive Configuration

Run the interactive logger configuration wizard:

```bash
elizaos logger
```

This will present you with a simple menu with three options:
- **Configure basic settings**: Set log level, transport, and format options
- **Show current configuration**: Display current logger settings
- **Reset to defaults**: Reset configuration to default values

## Configuration Options

### Log Levels

Available log levels (from most to least verbose):
- `trace` - Most detailed logging
- `debug` - Debug information
- `info` - General information (default)
- `warn` - Warning messages
- `error` - Error messages
- `fatal` - Critical errors only

### Transport Types

#### Console Transport
Default transport that outputs to the terminal with pretty formatting.

#### File Transport (Hybrid)
Outputs logs to both console and file:

```bash
# Clean text format: console pretty + file clean text
elizaos start --log-transport file --log-file ./logs/eliza.log

# JSON format: console and file both get raw JSON (consistent)
elizaos start --log-transport file --log-file ./logs/eliza.log --log-json
```

**Note**: File transport provides hybrid logging. Use `--log-json` for consistent raw JSON format across both console and file outputs.

### Available Transports

ElizaOS currently supports two logging transports:

1. **Console Transport** - Default console output with pretty formatting
2. **File Transport** - Hybrid logging (console + file output)

**Note**: Advanced transports like CloudWatch, Elasticsearch, or multi-transport configurations are not currently implemented. If you need these features, consider implementing custom logging in your agent or using external log forwarding tools.

## Integration with Start Command

Apply logging configuration when starting your agent:

```bash
# Basic usage (console only, pretty format)
elizaos start --log-level debug

# Hybrid logging (console pretty + file clean text)
elizaos start --log-transport file --log-file ./logs/agent.log

# Consistent JSON format (both console and file get raw JSON)
elizaos start --log-transport file --log-file ./logs/agent.log --log-json
```

### Logging Behavior

- **Console transport** (`console`): Pretty formatting with colors by default
- **File transport** (`file`): Hybrid logging (console + file)
  - **Without `--log-json`**: Console gets pretty formatting, file gets clean text format `[2025-01-19 21:59:25] INFO: message`
  - **With `--log-json`**: Both console and file get raw JSON format for consistency

**Key principle**: Console and file formats are consistent when using `--log-json` to avoid confusion during debugging.

### Supported Transport Options

| Transport | Description | CLI Option |
|-----------|-------------|------------|
| `console` | Console output only with pretty formatting | `--log-transport console` |
| `file` | Hybrid: console + file output | `--log-transport file` |

## Configuration File

Configurations are persisted in `.eliza/logger.config.json` (in the directory where you run the agent):

```json
{
  "level": "info",
  "transport": "console",
  "jsonFormat": false,
  "file": ".eliza/logs/eliza.log"
}
```

### Configuration Priority

The logging system follows this priority order:
1. **CLI options** (highest priority)
2. **Environment variables**
3. **Configuration file** (`.eliza/logger.config.json`)
4. **Default values** (lowest priority)

## File Paths

### Default Log File Location

When using file transport without specifying a path, logs are stored in:
```
.eliza/logs/eliza.log
```

This ensures logs are kept local to your project directory rather than in a global location.

### Custom Log File Paths

You can specify any path for log files:

```bash
elizaos start --log-transport file --log-file ./custom/path/app.log
```

## Examples

### Development Setup
```bash
# Configure for development
elizaos logger
# Select: Configure basic settings
# Choose: debug level, console transport, no JSON format
```

### Production Setup
```bash
# Configure for production
elizaos logger  
# Select: Configure basic settings
# Choose: warn level, file transport, JSON format
# File will be saved to: .eliza/logs/eliza.log (default)
```

### Debug Session
```bash
# Start with debug logging to file
elizaos start --log-level debug --log-transport file --log-file .eliza/logs/debug.log
```

### JSON Logging for Analysis
```bash
# Consistent JSON format for log analysis tools
elizaos start --log-transport file --log-file .eliza/logs/app.log --log-json
```

## Troubleshooting

### Configuration Not Persisting
- Ensure the `.eliza` directory is writable
- Check that the configuration file `.eliza/logger.config.json` is not corrupted

### File Logging Not Working
- Verify the log file directory exists and is writable
- Check disk space availability
- Ensure proper file permissions

### Performance Issues
- Consider using higher log levels (warn, error) in production
- Use JSON format for better performance when processing large log volumes
- Ensure log file rotation is set up for long-running applications

## Future Enhancements

The following transport types are planned for future releases:

- **CloudWatch Transport** - Direct AWS CloudWatch integration
- **Elasticsearch Transport** - Direct Elasticsearch logging
- **Multi-Transport** - Simultaneous logging to multiple destinations

For now, if you need these features, consider:
- Using external log forwarding tools (like Fluentd, Logstash)
- Implementing custom logging in your agent
- Using file transport with external log processors