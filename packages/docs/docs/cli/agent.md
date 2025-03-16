---
sidebar_position: 7
---

# Agent Command

The `agent` command allows you to manage, configure, and interact with ElizaOS agents. Use this command to list, get information, start, stop, and update your agents.

## Usage

```bash
npx @elizaos/cli agent <action> [options]
```

## Actions

| Action         | Description                                      |
| -------------- | ------------------------------------------------ |
| `list`, `ls`   | List all agents in the project                   |
| `get`, `g`     | Show detailed information about a specific agent |
| `start`, `s`   | Start an agent                                   |
| `stop`, `st`   | Stop an agent                                    |
| `remove`, `rm` | Remove an agent                                  |
| `set`          | Update agent configuration                       |

## Options

The available options vary by action. Here are some common options:

| Option                | Description                                                   |
| --------------------- | ------------------------------------------------------------- |
| `-n, --name <name>`   | Agent id, name, or index number from list                     |
| `-j, --json`          | Output in JSON format                                         |
| `-p, --path <path>`   | Local path to character JSON file (for start)                 |
| `-r, --remote <url>`  | Remote URL to character JSON file (for start)                 |
| `-c, --config <json>` | Configuration as JSON string (for set)                        |
| `-f, --file <path>`   | Path to configuration file (for set) or output file (for get) |
| `-o, --output <file>` | Output to file (for get)                                      |

## Managing Agents

### List Agents

List all agents in the current project:

```bash
npx @elizaos/cli agent list

# With JSON output
npx @elizaos/cli agent list --json
```

The output includes:

- Agent name
- Agent ID
- Status

### Get Agent Information

Get detailed information about a specific agent:

```bash
# Get agent by name, ID, or index
npx @elizaos/cli agent get --name customer-support

# Save agent configuration to JSON file
npx @elizaos/cli agent get --name customer-support --json

# Specify output file
npx @elizaos/cli agent get --name customer-support --json --output ./my-agent.json
```

### Start an Agent

Start an agent using various methods:

```bash
# Start by name
npx @elizaos/cli agent start --name customer-support

# Start from local JSON file
npx @elizaos/cli agent start --path ./agents/my-agent.json

# Start from remote URL
npx @elizaos/cli agent start --remote https://example.com/agents/my-agent.json

# Start with inline JSON
npx @elizaos/cli agent start --json '{"name":"My Agent","description":"A custom agent"}'
```

### Stop an Agent

Stop a running agent:

```bash
npx @elizaos/cli agent stop --name customer-support
```

### Remove an Agent

Remove an agent from the system:

```bash
npx @elizaos/cli agent remove --name customer-support
```

### Update Agent Configuration

Modify an existing agent's configuration:

```bash
# Update using JSON string
npx @elizaos/cli agent set --name customer-support --config '{"name":"Customer Care Bot"}'

# Update using JSON file
npx @elizaos/cli agent set --name customer-support --file ./updated-config.json
```

## Agent Configuration

ElizaOS agents are configured through a combination of:

- Agent definition file
- Knowledge files
- Runtime configuration options

A typical agent definition looks like:

```typescript
{
  "id": "customer-support",
  "name": "Customer Support Bot",
  "description": "Helps customers with common questions and issues",
  "character": {
    "persona": "You are a friendly and knowledgeable customer support agent.",
    "goals": ["Resolve customer issues efficiently", "Provide accurate information"],
    "constraints": [
      "Never share private customer information",
      "Escalate complex issues to human agents"
    ]
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-4",
    "temperature": 0.7
  },
  "knowledge": [
    "./knowledge/shared/company-info.md",
    "./knowledge/customer-support/faq.md",
    "./knowledge/customer-support/policies.md"
  ],
  "services": {
    "discord": { "enabled": true, "channels": ["support"] },
    "web": { "enabled": true }
  }
}
```

## Examples

### Basic Agent Management

```bash
# List all available agents
npx @elizaos/cli agent list

# Get information about a specific agent
npx @elizaos/cli agent get --name support-bot

# Stop a running agent
npx @elizaos/cli agent stop --name support-bot

# Remove an agent
npx @elizaos/cli agent remove --name old-agent
```

### Starting Agents

```bash
# Start an agent by name
npx @elizaos/cli agent start --name customer-support

# Start an agent from a local file
npx @elizaos/cli agent start --path ./agents/sales-bot.json
```

### Updating Configuration

```bash
# Update an agent's name and description
npx @elizaos/cli agent set --name tech-support --config '{"name":"Technical Support","description":"Technical help desk support"}'

# Update configuration from a file
npx @elizaos/cli agent set --name tech-support --file ./updated-config.json
```

## Troubleshooting

### Agent not found

If you get an "Agent not found" error:

```bash
# Check available agents
npx @elizaos/cli agent list

# Try using the agent ID directly
npx @elizaos/cli agent get --name agent_123456
```

### Configuration errors

If you encounter errors when updating configuration:

```bash
# Validate your JSON syntax
# Use a proper JSON validator

# Check the structure against the expected schema
# Refer to the agent configuration example
```

### Connection issues

If you can't connect to the agent runtime:

```bash
# Check if the runtime is running
npx @elizaos/cli start

# By default, the CLI connects to http://localhost:3000
# If using a different address, set the AGENT_RUNTIME_URL environment variable
AGENT_RUNTIME_URL=http://my-server:3000 npx @elizaos/cli agent list
```

## Related Commands

- [`create`](./create.md): Create a new project with agents
- [`start`](./start.md): Start your project with agents
- [`dev`](./dev.md): Run your project in development mode
- [`env`](./env.md): Configure environment variables
