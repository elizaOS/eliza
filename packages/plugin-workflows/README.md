# @elizaos/plugin-workflows

Deterministic workflow execution system for ElizaOS that enables guaranteed action sequences triggered by specific events.

## Overview

The workflow plugin provides a way to define and execute deterministic workflows within ElizaOS. This allows you to create guaranteed "when X, do Y" behaviors that bypass the LLM for critical operations while still maintaining compatibility with the agent's conversational abilities.

## Features

- **Event-driven triggers**: React to system events (messages, entity joins, etc.)
- **Scheduled workflows**: Run workflows on a cron schedule
- **Conditional logic**: Branch execution based on runtime conditions
- **Parallel execution**: Run multiple actions simultaneously
- **Loop support**: Iterate over arrays and collections
- **Template substitution**: Use dynamic values from context
- **Error handling**: Retry policies and error recovery
- **Hybrid operation**: Mix deterministic workflows with LLM-based responses

## Installation

```bash
npm install @elizaos/plugin-workflows
```

## Quick Start

1. **Register the plugin**:

```typescript
import { workflowPlugin } from '@elizaos/plugin-workflows';

const agent = new Agent({
  plugins: [workflowPlugin],
  // ... other configuration
});
```

2. **Create a workflow**:

```json
{
  "name": "welcome-workflow",
  "description": "Welcome new members",
  "enabled": true,
  "triggers": [
    {
      "type": "event",
      "event": "ENTITY_JOINED",
      "conditions": [
        {
          "field": "$.source",
          "operator": "equals",
          "value": "discord"
        }
      ]
    }
  ],
  "steps": [
    {
      "id": "welcome",
      "type": "action",
      "action": {
        "name": "SEND_MESSAGE",
        "inputs": {
          "text": "Welcome {{trigger.metadata.username}}!",
          "roomId": "{{trigger.roomId}}"
        }
      }
    }
  ]
}
```

3. **Register the workflow** via the CREATE_WORKFLOW action or programmatically:

```typescript
const workflowService = runtime.getService('workflow');
await workflowService.registerWorkflow(workflowDefinition);
```

## Workflow Schema

### Triggers

Workflows can be triggered by:

- **Events**: System events like MESSAGE_RECEIVED, ENTITY_JOINED
- **Schedule**: Cron expressions for periodic execution
- **Manual**: Direct execution via action or API
- **Webhook**: External HTTP triggers (coming soon)

### Steps

Steps define the execution flow:

- **action**: Execute a registered ElizaOS action
- **condition**: Branch based on conditions
- **parallel**: Run multiple steps simultaneously
- **loop**: Iterate over collections

### Conditions

Conditions support:

- `equals`: Exact match
- `contains`: Substring search
- `matches`: Regular expression
- `exists`: Field presence check
- `gt`/`lt`: Numeric comparisons

### Template Syntax

Use `{{path}}` to reference values:

- `{{trigger.roomId}}`: Access trigger payload
- `{{steps.stepId.result}}`: Previous step results
- `{{inputs.paramName}}`: Workflow inputs

## Actions

The plugin provides these actions:

- `CREATE_WORKFLOW`: Create a new workflow from JSON
- `TOGGLE_WORKFLOW`: Enable/disable a workflow
- `LIST_WORKFLOWS`: List all registered workflows
- `EXECUTE_WORKFLOW`: Manually trigger a workflow

## Examples

### Discord Welcome Workflow

```json
{
  "name": "discord-welcome",
  "description": "Welcome new Discord members",
  "triggers": [
    {
      "type": "event",
      "event": "ENTITY_JOINED",
      "conditions": [
        {
          "field": "$.source",
          "operator": "equals",
          "value": "discord"
        }
      ]
    }
  ],
  "steps": [
    {
      "id": "welcome-message",
      "type": "action",
      "action": {
        "name": "SEND_MESSAGE",
        "inputs": {
          "text": "Welcome {{trigger.metadata.username}} to our server! 🎉",
          "roomId": "{{trigger.roomId}}"
        }
      }
    }
  ]
}
```

### Conditional Response Workflow

```json
{
  "name": "help-handler",
  "description": "Provide contextual help",
  "triggers": [
    {
      "type": "event",
      "event": "MESSAGE_RECEIVED",
      "conditions": [
        {
          "field": "$.content.text",
          "operator": "matches",
          "regex": "^/help"
        }
      ]
    }
  ],
  "steps": [
    {
      "id": "check-topic",
      "type": "condition",
      "condition": {
        "if": {
          "field": "$.content.text",
          "operator": "contains",
          "value": "workflow"
        },
        "then": "workflow-help",
        "else": "general-help"
      }
    },
    {
      "id": "workflow-help",
      "type": "action",
      "action": {
        "name": "SEND_MESSAGE",
        "inputs": {
          "text": "Workflow commands:\n• list workflows\n• execute workflow <id>",
          "roomId": "{{trigger.roomId}}"
        }
      }
    },
    {
      "id": "general-help",
      "type": "action",
      "action": {
        "name": "SEND_MESSAGE",
        "inputs": {
          "text": "Available commands:\n• /help\n• /status\n• /settings",
          "roomId": "{{trigger.roomId}}"
        }
      }
    }
  ]
}
```

### Scheduled Report Workflow

```json
{
  "name": "daily-summary",
  "description": "Post daily activity summary",
  "triggers": [
    {
      "type": "schedule",
      "schedule": "0 9 * * *"
    }
  ],
  "steps": [
    {
      "id": "gather-stats",
      "type": "action",
      "action": {
        "name": "GET_DAILY_STATS"
      },
      "next": "format-report"
    },
    {
      "id": "format-report",
      "type": "action",
      "action": {
        "name": "SEND_MESSAGE",
        "inputs": {
          "text": "Daily Summary:\n{{steps.gather-stats.messageCount}} messages\n{{steps.gather-stats.activeUsers}} active users",
          "roomId": "{{config.reportChannel}}"
        }
      }
    }
  ]
}
```

## Hybrid Mode

The workflow system integrates seamlessly with ElizaOS's LLM capabilities:

1. **Workflow Mode**: When a workflow matches, it executes deterministically
2. **Standard Mode**: No matching workflows, LLM handles the interaction
3. **Mixed Mode**: Workflows handle specific triggers, LLM handles everything else

The `workflowMode` provider informs the LLM about active workflows, preventing conflicts.

## Best Practices

1. **Keep workflows focused**: Each workflow should have a single, clear purpose
2. **Use conditions wisely**: Complex branching can be hard to debug
3. **Test incrementally**: Start simple and add complexity gradually
4. **Handle errors**: Use retry policies and error handlers
5. **Document workflows**: Use clear names and descriptions
6. **Version control**: Store workflow definitions in your repository

## Debugging

Enable debug logging to see workflow execution:

```bash
DEBUG=elizaos:workflow:* npm start
```

View workflow execution history:

```typescript
const execution = await workflowService.getExecution(executionId);
console.log(execution.status, execution.outputs);
```

## Limitations

- Workflows are stored in memory (database persistence coming soon)
- No built-in versioning (use git for version control)
- Limited to registered actions (custom actions supported via plugins)
- JSONPath expressions have limited functionality

## Contributing

Contributions are welcome! Please see the main ElizaOS contributing guide.

## License

MIT 