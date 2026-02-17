# Agent Orchestrator Plugin

Multi-language orchestration plugin for elizaOS that manages task lifecycles, subagent spawning, agent-to-agent communication, sandboxed execution, and cross-platform messaging.

## Overview

This plugin provides:

- **Task lifecycle management** — create, pause, resume, cancel tasks
- **Subagent spawning** — spawn background subagents for autonomous task execution
- **Agent-to-agent communication** — send messages between agent sessions
- **Sandboxed execution** — isolated Docker containers for secure tool execution
- **Cross-platform messaging** — unified API for sending messages to Discord, Telegram, Slack, and more
- **Provider-based execution model** — register custom agent providers that execute tasks
- **Event system** — subscribe to task, subagent, sandbox, and messaging state changes
- **Cross-platform parity** — TypeScript, Python, and Rust implementations with identical APIs

The orchestrator does **not** perform file I/O directly. File operations, shell commands, and other implementation work are delegated to sub-agent workers configured via providers or executed in sandboxed environments.

## Implementations

| Language   | Path                | Status |
|------------|---------------------|--------|
| TypeScript | `typescript/`       | ✅     |
| Python     | `python/`           | ✅     |
| Rust       | `rust/`             | ✅     |

All implementations share the same:
- Type definitions (TaskStatus, TaskStep, TaskResult, OrchestratedTask, etc.)
- Service API (create, pause, resume, cancel, search, etc.)
- Actions for tasks, subagents, and messaging
- Provider interface (AgentProvider with executeTask)

## Installation

### TypeScript / Node.js

```bash
npm install @elizaos/plugin-agent-orchestrator
```

### Python

```bash
pip install elizaos-plugin-agent-orchestrator
```

### Rust

```toml
[dependencies]
elizaos-plugin-agent-orchestrator = "2.0"
```

## Quick Start

### TypeScript

```typescript
import {
  agentOrchestratorPlugin,
  configureAgentOrchestratorPlugin,
} from "@elizaos/plugin-agent-orchestrator";

// Define your agent provider
const myProvider = {
  id: "my-agent",
  label: "My Agent",
  executeTask: async (task, ctx) => {
    await ctx.appendOutput("Hello from my-agent");
    await ctx.updateProgress(100);
    return { success: true, summary: "done", filesCreated: [], filesModified: [] };
  },
};

// Configure before runtime.initialize()
configureAgentOrchestratorPlugin({
  providers: [myProvider],
  defaultProviderId: "my-agent",
  getWorkingDirectory: () => process.cwd(),
});

// Register plugin
runtime.plugins.push(agentOrchestratorPlugin);
```

### Python

```python
from elizaos_plugin_agent_orchestrator import (
    configure_agent_orchestrator_plugin,
    AgentOrchestratorPluginOptions,
    TaskResult,
    plugin,
)

class MyProvider:
    id = "my-agent"
    label = "My Agent"
    description = None

    async def execute_task(self, task, ctx):
        await ctx.append_output("Hello from my-agent")
        await ctx.update_progress(100)
        return TaskResult(success=True, summary="done")

configure_agent_orchestrator_plugin(
    AgentOrchestratorPluginOptions(
        providers=[MyProvider()],
        default_provider_id="my-agent",
        get_working_directory=lambda: os.getcwd(),
    )
)

runtime.register_plugin(plugin)
```

### Rust

```rust
use elizaos_plugin_agent_orchestrator::{
    configure_agent_orchestrator_plugin,
    AgentOrchestratorPluginOptions,
    AgentProvider,
    TaskResult,
};
use std::sync::Arc;

struct MyProvider;

#[async_trait::async_trait]
impl AgentProvider for MyProvider {
    fn id(&self) -> &str { "my-agent" }
    fn label(&self) -> &str { "My Agent" }

    async fn execute_task(&self, task: &OrchestratedTask, ctx: &ProviderTaskExecutionContext) -> TaskResult {
        (ctx.append_output)("Hello from my-agent".to_string());
        (ctx.update_progress)(100);
        TaskResult::success("done")
    }
}

configure_agent_orchestrator_plugin(
    AgentOrchestratorPluginOptions::new(
        vec![Arc::new(MyProvider)],
        "my-agent",
        || std::env::current_dir().unwrap().to_string_lossy().to_string(),
    )
);
```

## Actions

### Task Management

| Action | Description |
|--------|-------------|
| `CREATE_TASK` | Create a new orchestrated task |
| `LIST_TASKS` | List all tasks |
| `SWITCH_TASK` | Switch current task context |
| `SEARCH_TASKS` | Search tasks by query |
| `PAUSE_TASK` | Pause a running task |
| `RESUME_TASK` | Resume a paused task |
| `CANCEL_TASK` | Cancel a task |

### Subagent Management

| Action | Description |
|--------|-------------|
| `SPAWN_SUBAGENT` | Spawn a background subagent for a task |
| `SEND_TO_SESSION` | Send a message to another agent session |
| `LIST_SUBAGENTS` | List active and recent subagent runs |
| `CANCEL_SUBAGENT` | Cancel a running subagent |
| `GET_SUBAGENT_STATUS` | Get detailed status of a subagent run |

### Cross-Platform Messaging

| Action | Description |
|--------|-------------|
| `SEND_CROSS_PLATFORM_MESSAGE` | Send a message to any supported platform (Discord, Telegram, Slack, etc.) |
| `SEND_TO_DELIVERY_CONTEXT` | Send a message using a delivery context (from subagent system) |
| `SEND_TO_ROOM` | Send a message to an Eliza room (uses room metadata for routing) |
| `SEND_TO_SESSION_MESSAGE` | Send a message to a session by its key |
| `LIST_MESSAGING_CHANNELS` | List available messaging channels/platforms |

## Task Lifecycle

```
pending → running → completed
                 ↘ failed
         ↓
       paused → running (resume)
         ↓
      cancelled
```

## Provider Interface

Providers implement task execution logic. The orchestrator calls `executeTask` when a task starts.

```typescript
interface AgentProvider {
  id: string;              // Unique identifier
  label: string;           // Human-readable name
  description?: string;    // Optional description

  executeTask(
    task: OrchestratedTask,
    ctx: ProviderTaskExecutionContext,
  ): Promise<TaskResult>;
}
```

### Execution Context

The context provides callbacks for reporting progress:

- `appendOutput(line)` — Add output to task history
- `updateProgress(percent)` — Update progress (0-100)
- `updateStep(stepId, status, output?)` — Update a plan step
- `isCancelled()` — Check if task was cancelled
- `isPaused()` — Check if task is paused

### Suggested Provider IDs

| ID | Description |
|----|-------------|
| `eliza` | Default Eliza worker with plugin-code |
| `claude-code` | Claude Code / Claude Agent SDK |
| `codex` | OpenAI Codex |
| `sweagent` | SWE-agent methodology |
| `opencode` | OpenCode CLI |
| `custom:*` | Your custom providers |

## Examples

See `typescript/examples/` for:

- **agent-team.ts** — Simple multi-agent team (planner, executor, reviewer)
- **star-trek-bridge.ts** — Star Trek bridge crew simulation

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ELIZA_CODE_ACTIVE_SUB_AGENT` | Override the default provider for new tasks |

### Character Settings

Configure subagents, agent-to-agent communication, and sandboxing through your character's settings:

```json
{
  "name": "MyAgent",
  "settings": {
    "subagents": {
      "enabled": true,
      "model": "anthropic/claude-3-sonnet",
      "thinking": "medium",
      "timeoutSeconds": 300,
      "allowAgents": ["*"],
      "archiveAfterMinutes": 60
    },
    "agentToAgent": {
      "enabled": true,
      "allow": [
        { "source": "*", "target": "*" }
      ]
    },
    "sandbox": {
      "mode": "non-main",
      "scope": "session",
      "workspaceAccess": "rw",
      "workspaceRoot": "~/.eliza/sandboxes",
      "docker": {
        "image": "ubuntu:22.04",
        "memoryLimit": "2g",
        "cpuLimit": "2",
        "network": "none"
      },
      "browser": {
        "enabled": false
      },
      "tools": {
        "allow": ["*"],
        "deny": []
      }
    }
  }
}
```

### Subagent Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | true | Enable subagent spawning |
| `model` | string | - | Default model for subagents |
| `thinking` | string | - | Default thinking level |
| `timeoutSeconds` | number | 300 | Timeout for subagent runs |
| `allowAgents` | string[] | [] | Allowed agent IDs for cross-agent spawning (* = all) |
| `archiveAfterMinutes` | number | 60 | Minutes before archiving completed runs |

### Agent-to-Agent Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | false | Enable A2A messaging |
| `allow` | array | [] | Allow rules for cross-agent communication |

Allow rules have `source` and `target` patterns. Use `*` to match any agent.

### Sandbox Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `mode` | string | "off" | "off", "non-main", or "all" |
| `scope` | string | "session" | "session", "agent", or "shared" |
| `workspaceAccess` | string | "rw" | "none", "ro", or "rw" |
| `workspaceRoot` | string | ~/.eliza/sandboxes | Root directory for sandbox workspaces |
| `docker.image` | string | ubuntu:22.04 | Docker image for containers |
| `docker.memoryLimit` | string | 2g | Memory limit for containers |
| `docker.cpuLimit` | string | 2 | CPU limit for containers |
| `docker.network` | string | none | Network mode (none, bridge, host) |
| `tools.allow` | string[] | [] | Allowed tool patterns (* = all) |
| `tools.deny` | string[] | [] | Denied tool patterns |

## Subagent System

Subagents are isolated agent runs that execute specific tasks and report results back.

### Spawning a Subagent

```typescript
const subagentService = runtime.getService("SUBAGENT");

const result = await subagentService.spawnSubagent(
  {
    task: "Research the latest AI news",
    label: "news-research",
    model: "anthropic/claude-3-sonnet",
    runTimeoutSeconds: 300,
    cleanup: "keep",
  },
  {
    sessionKey: "agent:mybot:dm:user123",
    roomId: currentRoomId,
  }
);

console.log(result.runId, result.childSessionKey);
```

### Subagent Lifecycle

1. **Spawn** — Create a new room with subagent metadata
2. **Execute** — Process the initial task message
3. **Complete** — Run ends (success, error, or timeout)
4. **Announce** — Send result summary to the requester
5. **Cleanup** — Archive or delete based on cleanup setting

### Events

| Event | Description |
|-------|-------------|
| `SUBAGENT_SPAWN_REQUESTED` | Subagent spawn initiated |
| `SUBAGENT_RUN_STARTED` | Execution began |
| `SUBAGENT_RUN_COMPLETED` | Execution succeeded |
| `SUBAGENT_RUN_FAILED` | Execution failed |
| `SUBAGENT_RUN_TIMEOUT` | Execution timed out |
| `SUBAGENT_ANNOUNCE_SENT` | Result announced to requester |

## Agent-to-Agent Communication

Send messages between agent sessions with policy-based access control.

```typescript
const subagentService = runtime.getService("SUBAGENT");

const result = await subagentService.sendToAgent(
  {
    sessionKey: "agent:other:dm:user456",
    message: "Please check the deployment status",
    timeoutSeconds: 30,
  },
  { sessionKey: currentSessionKey }
);

console.log(result.reply);
```

## Sandboxed Execution

Execute commands in isolated Docker containers.

```typescript
const sandboxService = runtime.getService("SANDBOX");

// Get or create a sandbox context
const context = await sandboxService.getSandboxContext(sessionKey);

// Execute a command
const result = await sandboxService.execute(sessionKey, {
  command: "npm install && npm test",
  cwd: "/project",
  timeoutMs: 60000,
});

console.log(result.stdout, result.exitCode);
```

### Tool Policy

Control which tools can run in sandboxes:

```json
{
  "sandbox": {
    "tools": {
      "allow": ["npm", "node", "git", "python"],
      "deny": ["rm -rf /*", "sudo *"]
    }
  }
}
```

## Cross-Platform Messaging

The MessagingService provides a unified interface for sending messages across different platforms. It automatically routes messages to the appropriate platform-specific service.

### Supported Channels

| Channel | Service | Description |
|---------|---------|-------------|
| `discord` | DISCORD | Discord text channels and DMs |
| `telegram` | TELEGRAM | Telegram chats and groups |
| `slack` | SLACK | Slack channels and DMs |
| `whatsapp` | WHATSAPP | WhatsApp conversations |
| `twitch` | TWITCH | Twitch chat |
| `internal` | - | Agent-to-agent messaging via Eliza events |

### Sending Messages

```typescript
const messagingService = runtime.getService("MESSAGING");

// Send to a specific channel
const result = await messagingService.send({
  target: {
    channel: "discord",
    to: "123456789012345678", // Discord channel ID
    replyToMessageId: "optionalMessageId",
  },
  content: {
    text: "Hello from the agent!",
    silent: false,
  },
});

console.log(result.success, result.messageId);
```

### Sending to Delivery Context

When working with subagents, you can send messages using the delivery context:

```typescript
const messagingService = runtime.getService("MESSAGING");

// The delivery context comes from the subagent system
const deliveryContext = {
  channel: "telegram",
  to: "-1001234567890",
  threadId: 12345,
};

const result = await messagingService.sendToDeliveryContext(
  deliveryContext,
  { text: "Subagent task completed!" }
);
```

### Sending to Rooms

Messages can be sent to Eliza rooms, which use their metadata for routing:

```typescript
const messagingService = runtime.getService("MESSAGING");

// Room metadata should include messagingChannel, messagingTo, etc.
const result = await messagingService.sendToRoom(roomId, {
  text: "Notification from room",
});
```

### Room Metadata for Messaging

Configure room metadata to enable automatic routing:

```typescript
// When creating or updating a room
await runtime.createRoom({
  id: roomId,
  type: "dm",
  metadata: {
    messagingChannel: "discord",
    messagingTo: "123456789012345678",
    messagingAccountId: "optional-account-id",
    messagingThreadId: "optional-thread-id",
  },
});
```

### Registering Custom Adapters

You can register custom messaging adapters for additional platforms:

```typescript
const messagingService = runtime.getService("MESSAGING");

messagingService.registerAdapter({
  channel: "custom_platform",
  isAvailable: () => true,
  send: async (params) => {
    // Custom send implementation
    return {
      success: true,
      messageId: "custom-msg-id",
      channel: "custom_platform",
      targetId: params.target.to,
      sentAt: Date.now(),
    };
  },
});
```

### Message Content Options

| Option | Type | Description |
|--------|------|-------------|
| `text` | string | Message text (required) |
| `attachments` | array | Files, images, videos to attach |
| `embed` | object | Rich embed/card data |
| `buttons` | array | Interactive buttons |
| `disableLinkPreview` | boolean | Disable URL previews |
| `silent` | boolean | Send without notification |

### Events

| Event | Description |
|-------|-------------|
| `MESSAGING_SEND_REQUESTED` | Message send initiated |
| `MESSAGING_SENT` | Message sent successfully |
| `MESSAGING_SEND_FAILED` | Message send failed |
| `MESSAGING_DELIVERED` | Message delivered (if supported) |
| `MESSAGING_READ` | Message read (if supported) |

Subscribe to events:

```typescript
const messagingService = runtime.getService("MESSAGING");

messagingService.on("MESSAGING_SENT", (payload) => {
  console.log(`Message ${payload.messageId} sent to ${payload.channel}`);
});

messagingService.on("MESSAGING_SEND_FAILED", (payload) => {
  console.error(`Failed to send: ${payload.error}`);
});
```

## Building

```bash
# Build all languages
bun run build

# Build individual
bun run build:ts
bun run build:rust
bun run build:python
```

## Testing

```bash
# Test all languages
bun run test

# Test individual
bun run test:ts
bun run test:rust
bun run test:python
```

## License

MIT
