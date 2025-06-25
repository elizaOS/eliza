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

| Subcommand       | Aliases | Description                             | Required Options                                  | Additional Options                                                           |
| ---------------- | ------- | --------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `list`           | `ls`    | List available agents                   |                                                   | `--format <format>`, `-r, --remote-url <url>`, `-p, --port <port>`           |
| `get`            | `g`     | Get agent details                       | `-c, --character <paths...>`                      | `--format <format>`, `-o, --output [file]`, `-r, --remote-url`, `-p, --port` |
| `start`          | `s`     | Start agent(s) with character profile(s) | `-c, --character <paths...>`                      | `-r, --remote-url <url>`, `-p, --port <port>`                                |
| `stop`           | `st`    | Stop agent(s)                           | `-c, --character <paths...>`                      | `-r, --remote-url <url>`, `-p, --port <port>`                                |
| `remove`         | `rm`    | Remove agent(s)                         | `-c, --character <paths...>`                      | `-r, --remote-url <url>`, `-p, --port <port>`                                |
| `set`            |         | Update agent configuration              | `-c, --character <path>` AND one of: `--config` OR `--file` | `-r, --remote-url <url>`, `-p, --port <port>`                                |
| `clear-memories` |         | Clear agent memories                    | `-c, --character <paths...>`                      | `-r, --remote-url <url>`, `-p, --port <port>`                                |

## Options Reference

### Common Options (All Subcommands)

- `-r, --remote-url <url>`: URL of the remote agent runtime
- `-p, --port <port>`: Port to listen on

### Output Options (for `list` and `get`)

- `--format <format>`: Specify the output format. Options are `table` (default), `json`, or `yaml`.
- `-j, --json`: A shorthand for `--format json`.
- `-o, --output [file]`: For the `get` command, saves the agent's configuration to a JSON file. If no filename is provided, defaults to `{name}.json`.

### Character Specification Options

- `-c, --character <paths...>`: Character name(s), file path(s), or URL(s) 
  - **Multiple characters supported** (except for `set` command)
  - **Formats**: Space-separated, comma-separated, or mixed
  - **Auto-extension**: `.json` extension added automatically if missing
  - **Path resolution**: Supports local files, URLs, and character names
  - **Examples**: 
    - `bobby,billy` (comma-separated)
    - `bobby billy` (space-separated)  
    - `./characters/bobby.json https://example.com/billy.json` (mixed formats)

### Set Specific Options

- `-c, --character <path>`: Character name, file path, or URL (single character only)
- `--config <json>`: Agent configuration as JSON string
- `--file <path>`: Path to agent configuration JSON file

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
# Get agent details by character name
elizaos agent get --character eliza

# Get multiple agents
elizaos agent get --character eliza,bobby
elizaos agent get --character eliza bobby

# Get agent by character file path
elizaos agent get --character ./characters/eliza.json

# Get agents from mixed sources
elizaos agent get --character eliza ./bobby.json https://example.com/alice.json

# Display configuration as JSON in console
elizaos agent get --character eliza --format json

# Display configuration as YAML in console
elizaos agent get --character eliza --format yaml

# Save agent configuration to file
elizaos agent get --character eliza --output

# Save to specific file
elizaos agent get --character eliza --output ./my-agent.json

# Using alias
elizaos agent g --character eliza
```

### Starting Agents

```bash
# Start single agent by character name or file
elizaos agent start --character eliza
elizaos agent start --character ./characters/eliza.json

# Start multiple agents (comma-separated)
elizaos agent start --character eliza,bobby

# Start multiple agents (space-separated)
elizaos agent start --character eliza bobby

# Start agents from mixed sources
elizaos agent start --character eliza ./bobby.json https://example.com/alice.json

# Using alias
elizaos agent s --character eliza

# Start on specific port
elizaos agent start --character eliza --port 4000
```

**Character Resolution:**
The CLI supports multiple formats and automatically resolves character paths:
- **Character names**: `eliza`, `bobby` (looks up existing agents)
- **Local files**: `./characters/eliza.json`, `eliza.json`
- **URLs**: `https://example.com/characters/eliza.json`
- **Auto-extension**: `.json` extension added automatically if missing
- **Multiple formats**: Supports comma-separated (`eliza,bobby`) and space-separated (`eliza bobby`)

### Stopping Agents

```bash
# Stop single agent
elizaos agent stop --character eliza

# Stop multiple agents (comma-separated)
elizaos agent stop --character eliza,bobby

# Stop multiple agents (space-separated)
elizaos agent stop --character eliza bobby

# Stop agents from mixed sources
elizaos agent stop --character eliza ./bobby.json

# Using alias
elizaos agent st --character eliza

# Stop agent on remote runtime
elizaos agent stop --character eliza --remote-url http://server:3000

# Stop all agents locally
elizaos agent stop --all
```

### Removing Agents

```bash
# Remove single agent
elizaos agent remove --character pmairca

# Remove multiple agents (comma-separated)
elizaos agent remove --character eliza,bobby

# Remove multiple agents (space-separated)
elizaos agent remove --character eliza bobby

# Remove agents from mixed sources
elizaos agent remove --character eliza ./bobby.json

# Using alias
elizaos agent rm --character pmairca

# Remove from remote runtime
elizaos agent remove --character pmairca --remote-url http://server:3000
```

### Updating Agent Configuration

```bash
# Update with JSON string (single character only)
elizaos agent set --character eliza --config '{"system":"Updated prompt"}'

# Update from configuration file (single character only)
elizaos agent set --character eliza --file ./updated-config.json

# Update agent on remote runtime
elizaos agent set --character pmairca --config '{"model":"gpt-4"}' --remote-url http://server:3000

# Update agent on specific port
elizaos agent set --character eliza --file ./config.json --port 4000
```

**Note:** The `set` command only accepts a single character, unlike other agent commands that support multiple characters.

### Clearing Agent Memories

```bash
# Clear memories for single agent
elizaos agent clear-memories --character eliza

# Clear memories for multiple agents (comma-separated)
elizaos agent clear-memories --character eliza,bobby

# Clear memories for multiple agents (space-separated)
elizaos agent clear-memories --character eliza bobby

# Clear memories on remote runtime
elizaos agent clear-memories --character eliza --remote-url http://server:3000
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

## Character Specification

Characters can be specified using multiple formats:

1. **Character Names**: Human-readable names of existing agents (e.g., "eliza", "bobby")
2. **File Paths**: Local character files (e.g., "./characters/eliza.json", "eliza.json")
3. **URLs**: Remote character files (e.g., "https://example.com/characters/eliza.json")
4. **Multiple Characters**: Space-separated or comma-separated lists (e.g., "eliza,bobby" or "eliza bobby")

**Features:**
- **Auto-extension**: `.json` extension added automatically if missing
- **Flexible parsing**: Supports mixed quotes, spaces, and commas
- **Path resolution**: Automatic resolution of character file locations

## Interactive Mode

All agent commands support interactive mode when run without required parameters:

```bash
# Interactive character selection
elizaos agent get
elizaos agent start
elizaos agent stop
elizaos agent remove
elizaos agent set
elizaos agent clear-memories
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
elizaos create --type agent eliza

# Or create project with character
elizaos create --type project my-project
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

# Start single or multiple agents
elizaos agent start --character ./eliza.json
elizaos agent start --character eliza,bobby

# Check agent status
elizaos agent get --character eliza

# Get multiple agent details
elizaos agent get --character eliza,bobby

# Update configuration (single agent only)
elizaos agent set --character eliza --config '{"system":"Updated prompt"}'

# Stop single or multiple agents
elizaos agent stop --character eliza
elizaos agent stop --character eliza,bobby

# Clear agent memories
elizaos agent clear-memories --character eliza

# Remove when no longer needed
elizaos agent remove --character eliza
elizaos agent remove --character eliza,bobby
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
