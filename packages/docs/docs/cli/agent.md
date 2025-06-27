---
sidebar_position: 7
title: Agent Command
description: Managing ElizaOS agents through the CLI - list, configure, start, stop, and update agents
keywords: [CLI, agent, management, configuration, commands, options, actions]
image: /img/cli.jpg
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Agent Command

Manage ElizaOS agents.

<Tabs>
<TabItem value="overview" label="Overview & Options" default>

## Usage

```bash
elizaos agent [options] [command]
```

## Subcommands

| Subcommand | Aliases | Description                             | Required Options                                               | Additional Options                                                           |
| ---------- | ------- | --------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `list`     | `ls`    | List available agents                   |                                                                | `--format <format>`, `-r, --remote-url <url>`, `-p, --port <port>`           |
| `get`      | `g`     | Get agent details                       | `-n, --name <name>`                                            | `--format <format>`, `-o, --output [file]`, `-r, --remote-url`, `-p, --port` |
| `start`    | `s`     | Start an agent with a character profile | One of: `-n, --name`, `--path`, `--remote-character`           | `-r, --remote-url <url>`, `-p, --port <port>`                                |
| `stop`     | `st`    | Stop an agent                           | `-n, --name <name>`                                            | `-r, --remote-url <url>`, `-p, --port <port>`                                |
| `remove`   | `rm`    | Remove an agent                         | `-n, --name <name>`                                            | `-r, --remote-url <url>`, `-p, --port <port>`                                |
| `set`      |         | Update agent configuration              | `-n, --name <name>` AND one of: `-c, --config` OR `-f, --file` | `-r, --remote-url <url>`, `-p, --port <port>`                                |

## Options Reference

### Common Options (All Subcommands)

- `-r, --remote-url <url>`: URL of the remote agent runtime
- `-p, --port <port>`: Port to listen on

### Output Options (for `list` and `get`)

- `--format <format>`: Specify the output format. Options are `table` (default), `json`, or `yaml`.
- `-j, --json`: A shorthand for `--format json`.
- `-o, --output [file]`: For the `get` command, saves the agent's configuration to a JSON file. If no filename is provided, defaults to `{name}.json`.

### Get Specific Options

- `-n, --name <name>`: Agent id, name, or index number from list (required)

### Start Specific Options

- `-n, --name <name>`: Name of an existing agent to start
- `--path <path>`: Path to local character JSON file
- `--remote-character <url>`: URL to remote character JSON file

### Stop/Remove Specific Options

- `-n, --name <name>`: Agent id, name, or index number from list (required)

### Set Specific Options

- `-n, --name <name>`: Agent id, name, or index number from list (required)
- `-c, --config <json>`: Agent configuration as JSON string
- `-f, --file <path>`: Path to agent configuration JSON file

</TabItem>
<TabItem value="examples" label="Examples">

### Listing Agents

```bash
# List all available agents
elizaos agent list

# Using alias
elizaos agent ls

# List agents in JSON format
elizaos agent list --format json
# Or using the shorthand
elizaos agent list --j

# List agents in YAML format
elizaos agent list --format yaml

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
elizaos agent get --name eliza --format json

# Display configuration as YAML in console
elizaos agent get --name eliza --format yaml

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

# Using alias
elizaos agent st --name eliza

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

</TabItem>
<TabItem value="guides" label="Guides & Concepts">

## Output Formatting

The `list` and `get` commands support multiple output formats via the `--format` option, making it easy to use the CLI in scripts or for human readability.

### `table` (Default)

The default format is a human-readable table, best for viewing in the terminal.

```bash
$ elizaos agent list
┌─────────┬──────────────┬─────────┬──────────┐
│ (index) │     name     │   id    │  status  │
├─────────┼──────────────┼─────────┼──────────┤
│    0    │   'eliza'    │ 'agent…'│ 'running'│
└─────────┴──────────────┴─────────┴──────────┘
```

### `json`

Outputs raw JSON data. Useful for piping into other tools like `jq`. The `-j` flag is a convenient shorthand for `--format json`.

```bash
# Get JSON output
elizaos agent get --name eliza --format json
```

### `yaml`

Outputs YAML data, which can be more human-readable than JSON for complex configurations.

```bash
# Get YAML output
elizaos agent get --name eliza --format yaml
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

</TabItem>
<TabItem value="troubleshooting" label="Troubleshooting">

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

</TabItem>
</Tabs>
