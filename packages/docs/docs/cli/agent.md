---
sidebar_position: 7
title: Agent Command
description: Managing ElizaOS agents through the CLI - list, configure, start, stop, and update agents
keywords: [CLI, agent, management, configuration, commands, options, actions]
image: /img/cli.jpg
---

# Agent Command

The `agent` command allows you to manage, configure, and interact with ElizaOS agents. Use this command to list, get information, start, stop, and update your agents.

## Global Options

These options can be used with any `agent` subcommand:

- `-r, --remote-url <url>`: Specify the URL of the remote agent runtime. Overrides the `AGENT_RUNTIME_URL` environment variable.

## Usage

Install the CLI first (`npm install -g @elizaos/cli@beta`)

```bash
elizaos agent <action> [options]
```

## Actions

| Action         | Description                                     |
| -------------- | ----------------------------------------------- |
| `list`, `ls`   | List available agents                           |
| `get`, `g`     | Get detailed information about a specific agent |
| `start`, `s`   | Start an agent using a character definition     |
| `stop`, `st`   | Stop a running agent                            |
| `remove`, `rm` | Remove an agent                                 |
| `set`          | Update agent configuration                      |

## Options

The available options vary by action:

| Option                     | Action(s)                   | Description                               | Required |
| -------------------------- | --------------------------- | ----------------------------------------- | -------- |
| `-n, --name <name>`        | `get`,`stop`,`remove`,`set` | Agent id, name, or index number from list | Yes      |
| `-n, --name <n>`           | `start`                     | Character name to start the agent with    | No       |
| `-j, --json`               | `list`, `get`               | Output as JSON                            | No       |
| `-j, --json <json>`        | `start`                     | Character JSON string                     | No       |
| `--path <path>`            | `start`                     | Local path to character JSON file         | No       |
| `--remote-character <url>` | `start`                     | Remote URL to character JSON file         | No       |
| `-c, --config <json>`      | `set`                       | Agent configuration as JSON string        | No       |
| `-f, --file <path>`        | `set`                       | Path to agent configuration JSON file     | No       |
| `-o, --output <file>`      | `get`                       | Output to file (default: `{name}.json`)   | No       |

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
elizaos agent start --remote-character https://example.com/agents/my-agent.json

# Stop a running agent
elizaos agent stop --name customer-support
```

</TabItem>
<TabItem value="config" label="Update & Remove Agents">

```bash
# Update agent configuration using JSON string
elizaos agent set --name customer-support --config '{"llm": {"model": "gpt-4-turbo"}}'

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
