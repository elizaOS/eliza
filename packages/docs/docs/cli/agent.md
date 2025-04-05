---
sidebar_position: 7
---

# Agent Command

The `agent` command allows you to manage, configure, and interact with ElizaOS agents. Use this command to list, get information, start, stop, and update your agents.

## Usage

Install the CLI first (`npm install -g @elizaos/cli@beta`)

```bash
elizaos agent <action> [options]
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

## Usage Examples

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
<TabItem value="list" label="List & Get Agents">

```bash
# List all agents with their status
elizaos agent list

# List in JSON format
elizaos agent list --json

# Get detailed information about an agent
elizaos agent get --name customer-support

# Save agent configuration to file
elizaos agent get --name customer-support --json --output ./my-agent.json
```

</TabItem>
<TabItem value="start" label="Start & Stop Agents">

```bash
# Start an agent by name
elizaos agent start --name customer-support

# Start from local JSON file
elizaos agent start --path ./agents/my-agent.json

# Start from remote URL
elizaos agent start --remote https://example.com/agents/my-agent.json

# Stop a running agent
elizaos agent stop --name customer-support
```

</TabItem>
<TabItem value="config" label="Update & Remove Agents">

```bash
# Update agent configuration using JSON string
elizaos agent set --name customer-support --config '{"name":"Customer Care Bot"}'

# Update configuration from file
elizaos agent set --name customer-support --file ./updated-config.json

# Remove an agent
elizaos agent remove --name old-agent
```

</TabItem>
</Tabs>

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

## FAQ

### How do I fix "Agent not found" errors?

Check available agents using `elizaos agent list` and try using the agent ID directly with `elizaos agent get --name agent_123456`.

### What should I do if I encounter configuration errors?

Validate your JSON syntax using a proper JSON validator and check the structure against the expected schema in the agent configuration example.

### How do I resolve connection issues with the agent runtime?

First check if the runtime is running with `elizaos start`. If using a different address than the default (http://localhost:3000), set the AGENT_RUNTIME_URL environment variable: `AGENT_RUNTIME_URL=http://my-server:3000 elizaos agent list`.

## Related Commands

- [`create`](./create.md): Create a new project with agents
- [`start`](./start.md): Start your project with agents
- [`dev`](./dev.md): Run your project in development mode
- [`env`](./env.md): Configure environment variables
