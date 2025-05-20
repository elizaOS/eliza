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

| Option                     | Action(s)                   | Description                                | Required |
| -------------------------- | --------------------------- | ------------------------------------------ | -------- |
| `-n, --name <name>`        | `get`,`stop`,`remove`,`set` | Agent id, name, or index number from list  | No\*     |
| `-n, --name <name>`        | `start`                     | Name of an existing agent to start         | No\*     |
| `-j, --json`               | `list`, `get`               | Display output as JSON in terminal         | No       |
| `-j, --json <json>`        | `start`                     | Character JSON configuration string        | No\*     |
| `--path <path>`            | `start`                     | Local path to character JSON file          | No\*     |
| `--remote-character <url>` | `start`                     | URL to remote character JSON file          | No\*     |
| `-o, --output <file>`      | `get`                       | Save agent data to file without displaying | No       |
| `-c, --config <json>`      | `set`                       | Agent configuration as JSON string         | No\*     |
| `-f, --file <path>`        | `set`                       | Path to agent configuration JSON file      | No\*     |

_\*At least one of the starred options is required for the respective command, or an interactive menu will be displayed._

## Usage Examples

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
<TabItem value="list" label="List & Get Agents">

```console
# List all agents with their status
elizaos agent list

# List in JSON format
elizaos agent list --json

# Get detailed information about an agent
elizaos agent get --name customer-support

# Display agent configuration as JSON in terminal
elizaos agent get --name customer-support --json

# Save agent configuration to file without displaying in terminal
elizaos agent get --name customer-support --output ./my-agent.json

# Get agent with interactive selection (no parameters)
elizaos agent get
```

</TabItem>
<TabItem value="start" label="Start & Stop Agents">

```bash
# Start an existing agent by name
elizaos agent start --name customer-support

# Start from local JSON file (will create agent if it doesn't exist)
elizaos agent start --path ./agents/my-agent.json

# Start from a JSON string
elizaos agent start --json '{"name":"QuickAgent","system":"You are a test agent"}'

# Start from remote URL
elizaos agent start --remote-character https://example.com/agents/my-agent.json

# Start agent with interactive selection (no parameters)
elizaos agent start

# Stop a running agent
elizaos agent stop --name customer-support

# Stop agent with interactive selection
elizaos agent stop
```

</TabItem>
<TabItem value="config" label="Update & Remove Agents">

```bash
# Update agent configuration using JSON string
elizaos agent set --name customer-support --config '{"llm": {"model": "gpt-4-turbo"}}'

# Update configuration from file
elizaos agent set --name customer-support --file ./updated-config.json

# Update agent with interactive selection and editor
elizaos agent set

# Remove an agent
elizaos agent remove --name old-agent

# Remove agent with interactive selection
elizaos agent remove
```

</TabItem>
</Tabs>

## Interactive Mode

When you run any of the agent commands without specifying key parameters, ElizaOS will display an interactive menu to help you select the appropriate agent or options:

- `elizaos agent get` - Lists available agents for selection
- `elizaos agent start` - Shows available character files or agents to start
- `elizaos agent stop` - Lists running agents for selection
- `elizaos agent remove` - Lists available agents for selection
- `elizaos agent set` - Provides an interactive configuration experience

This makes it easier to manage your agents without needing to remember all command parameters.

## Agent Configuration

ElizaOS agents are configured through a combination of:

- Agent definition file
- Knowledge files
- Runtime configuration options

A typical agent definition looks like:

```json
{
  "name": "Customer Support Bot",
  "system": "You are a friendly and knowledgeable customer support agent.",
  "bio": ["Resolve customer issues efficiently", "Provide accurate information"],
  "plugins": ["@elizaos/plugin-openai", "@elizaos/plugin-discord"],
  "llm": {
    "provider": "openai",
    "model": "gpt-4",
    "temperature": 0.7
  },
  "knowledge": ["./knowledge/shared/company-info.md", "./knowledge/customer-support/faq.md"],
  "settings": {
    "voice": {
      "model": "en_US-female-medium"
    }
  }
}
```

## Agent Lifecycle

The agent command manages the full lifecycle of agents:

1. **Creation** - Create an agent from a character file using `elizaos create -t agent` or `elizaos agent start --path`
2. **Starting** - Start an agent's runtime using `elizaos agent start`
3. **Configuration** - View or modify an agent using `elizaos agent get` and `elizaos agent set`
4. **Stopping** - Stop a running agent with `elizaos agent stop`
5. **Removal** - Remove an agent with `elizaos agent remove`

## FAQ

### How do I fix "Agent not found" errors?

Check available agents using `elizaos agent list` and try using the agent ID directly with `elizaos agent get --name agent_123456`.

### What should I do if I encounter configuration errors?

Validate your JSON syntax using a proper JSON validator and check the structure against the expected schema in the agent configuration example.

### How do I resolve connection issues with the agent runtime?

First check if the runtime is running with `elizaos start`. If using a different address than the default (http://localhost:3000), set the AGENT_RUNTIME_URL environment variable: `AGENT_RUNTIME_URL=http://my-server:3000 elizaos agent list`.

## Related Commands

- [`create`](./create.md): Create a new agent character file
- [`start`](./start.md): Start your project with agents
- [`dev`](./dev.md): Run your project in development mode
- [`env`](./env.md): Configure environment variables
