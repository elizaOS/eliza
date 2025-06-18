---
sidebar_position: 7
title: Agent Command
description: Managing ElizaOS agents through the CLI - list, configure, start, stop, and update agents
keywords: [CLI, agent, management, configuration, commands, options, actions]
image: /img/cli.jpg
---

# Agent Command

Manage ElizaOS agents.

## Usage

```bash
elizaos agent [options] [command]
```

## Subcommands

| Subcommand | Aliases | Description                             | Required Options                                               | Additional Options                                                    |
| ---------- | ------- | --------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `list`     | `ls`    | List available agents                   |                                                                | `-j, --json`, `-r, --remote-url <url>`, `-p, --port <port>`           |
| `get`      | `g`     | Get agent details                       | `-n, --name <name>`                                            | `-j, --json`, `-o, --output [file]`, `-r, --remote-url`, `-p, --port` |
| `start`    | `s`     | Start an agent with a character profile | One of: `-n, --name`, `--path`, `--remote-character`           | `-r, --remote-url <url>`, `-p, --port <port>`                         |
| `stop`     | `st`    | Stop an agent                           | `-n, --name <name>` OR `--all`                                 | `-r, --remote-url <url>`, `-p, --port <port>`                         |
| `remove`   | `rm`    | Remove an agent                         | `-n, --name <name>`                                            | `-r, --remote-url <url>`, `-p, --port <port>`                         |
| `set`      |         | Update agent configuration              | `-n, --name <name>` AND one of: `-c, --config` OR `-f, --file` | `-r, --remote-url <url>`, `-p, --port <port>`                         |

## Options Reference

### Common Options (All Subcommands)

- `-r, --remote-url <url>`: URL of the remote agent runtime
- `-p, --port <port>`: Port to listen on

### List Specific Options

- `-j, --json`: Output as JSON

### Get Specific Options

- `-n, --name <name>`: Agent id, name, or index number from list (required)
- `-j, --json`: Display agent configuration as JSON in the console
- `-o, --output [file]`: Save agent config to JSON (defaults to `{name}.json`)

### Start Specific Options

- `-n, --name <name>`: Name of an existing agent to start
- `--path <path>`: Path to local character JSON file
- `--remote-character <url>`: URL to remote character JSON file

### Stop/Remove Specific Options

- `-n, --name <name>`: Agent id, name, or index number from list (required for single agent)
- `--all`: Stop all running ElizaOS agents locally (for stop command only)

### Set Specific Options

- `-n, --name <name>`: Agent id, name, or index number from list (required)
- `-c, --config <json>`: Agent configuration as JSON string
- `-f, --file <path>`: Path to agent configuration JSON file

## Examples

### Listing Agents

```bash
# List all available agents
elizaos agent list

# Using alias
elizaos agent ls

# List agents in JSON format
elizaos agent list --json

# List agents from remote runtime
elizaos agent list --remote-url http://server:3000

# List agents on specific port
elizaos agent list --port 4000
```

### Getting Agent Details

```bash
# Get agent details by name
elizaos agent get --name eliza

# Get agent by ID
elizaos agent get --name agent_123456

# Get agent by index from list
elizaos agent get --name 0

# Display configuration as JSON in console
elizaos agent get --name eliza --json

# Save agent configuration to file
elizaos agent get --name eliza --output

# Save to specific file
elizaos agent get --name eliza --output ./my-agent.json

# Using alias
elizaos agent g --name eliza
```

### Starting Agents

```bash
# Start existing agent by name
elizaos agent start --name eliza

# Start with local character file
elizaos agent start --path ./characters/eliza.json

# Start from remote character file
elizaos agent start --remote-character https://example.com/characters/eliza.json

# Using alias
elizaos agent s --name eliza

# Start on specific port
elizaos agent start --path ./eliza.json --port 4000
```

**Required Configuration:**
You must provide one of these options: `--name`, `--path`, or `--remote-character`

### Stopping Agents

```bash
# Stop agent by name
elizaos agent stop --name eliza

# Stop agent by ID
elizaos agent stop --name agent_123456

# Stop agent by index
elizaos agent stop --name 0

# Stop all running agents locally
elizaos agent stop --all

# Using alias
elizaos agent st --name eliza

# Stop all using alias
elizaos agent st --all

# Stop agent on remote runtime
elizaos agent stop --name eliza --remote-url http://server:3000
```

### Removing Agents

```bash
# Remove agent by name
elizaos agent remove --name pmairca

# Remove agent by ID
elizaos agent remove --name agent_123456

# Using alias
elizaos agent rm --name pmairca

# Remove from remote runtime
elizaos agent remove --name pmairca --remote-url http://server:3000
```

### Updating Agent Configuration

```bash
# Update with JSON string
elizaos agent set --name eliza --config '{"system":"Updated prompt"}'

# Update from configuration file
elizaos agent set --name eliza --file ./updated-config.json

# Update agent on remote runtime
elizaos agent set --name pmairca --config '{"model":"gpt-4"}' --remote-url http://server:3000

# Update agent on specific port
elizaos agent set --name eliza --file ./config.json --port 4000
```

## Character File Structure

When using `--path` or `--remote-character`, the character file should follow this structure:

```json
{
  "name": "eliza",
  "system": "You are a friendly and knowledgeable AI assistant named Eliza.",
  "bio": ["Helpful and engaging conversationalist", "Knowledgeable about a wide range of topics"],
  "plugins": ["@elizaos/plugin-openai", "@elizaos/plugin-discord"],
  "modelProvider": "openai",
  "settings": {
    "voice": {
      "model": "en_US-female-medium"
    }
  },
  "knowledge": ["./knowledge/general-info.md", "./knowledge/conversation-patterns.md"]
}
```

## Agent Identification

Agents can be identified using:

1. **Agent Name**: Human-readable name (e.g., "eliza", "pmairca")
2. **Agent ID**: System-generated ID (e.g., "agent_123456")
3. **List Index**: Position in `elizaos agent list` output (e.g., "0", "1", "2")

## Interactive Mode

All agent commands support interactive mode when run without required parameters:

```bash
# Interactive agent selection
elizaos agent get
elizaos agent start
elizaos agent stop
elizaos agent remove
elizaos agent set
```

## Remote Runtime Configuration

By default, agent commands connect to `http://localhost:3000`. Override with:

### Environment Variable

```bash
export AGENT_RUNTIME_URL=http://your-server:3000
elizaos agent list
```

### Command Line Option

```bash
elizaos agent list --remote-url http://your-server:3000
```

### Custom Port

```bash
elizaos agent list --port 4000
```

## Agent Lifecycle Workflow

### 1. Create Agent Character

```bash
# Create character file
elizaos create -type agent eliza

# Or create project with character
elizaos create -type project my-project
```

### 2. Start Agent Runtime

```bash
# Start the agent runtime server
elizaos start
```

### 3. Manage Agents

```bash
# List available agents
elizaos agent list

# Start an agent
elizaos agent start --path ./eliza.json

# Check agent status
elizaos agent get --name eliza

# Update configuration
elizaos agent set --name eliza --config '{"system":"Updated prompt"}'

# Stop agent
elizaos agent stop --name eliza

# Remove when no longer needed
elizaos agent remove --name eliza
```

## Troubleshooting

### Connection Issues

```bash
# Check if runtime is running
elizaos agent list

# If connection fails, start runtime first
elizaos start

# For custom URLs/ports
elizaos agent list --remote-url http://your-server:3000
```

### Agent Not Found

```bash
# List all agents to see available options
elizaos agent list

# Try using agent ID instead of name
elizaos agent get --name agent_123456

# Try using list index
elizaos agent get --name 0
```

### Configuration Errors

- Validate JSON syntax in character files and config strings
- Ensure all required fields are present in character definitions
- Check file paths are correct and accessible

## Related Commands

- [`create`](./create.md): Create a new agent character file
- [`start`](./start.md): Start the agent runtime server
- [`dev`](./dev.md): Run in development mode with hot-reload
- [`env`](./env.md): Configure environment variables for agents

```

```
