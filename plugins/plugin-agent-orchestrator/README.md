# Agent Orchestrator Plugin

Multi-language orchestration plugin for ElizaOS that manages task lifecycles and delegates execution to registered agent providers.

## Overview

This plugin provides:

- **Task lifecycle management** — create, pause, resume, cancel tasks
- **Provider-based execution model** — register custom agent providers that execute tasks
- **Event system** — subscribe to task state changes
- **Cross-platform parity** — TypeScript, Python, and Rust implementations with identical APIs

The orchestrator does **not** perform file I/O directly. File operations, shell commands, and other implementation work are delegated to sub-agent workers configured via providers.

## Implementations

| Language   | Path                | Status |
|------------|---------------------|--------|
| TypeScript | `typescript/`       | ✅     |
| Python     | `python/`           | ✅     |
| Rust       | `rust/`             | ✅     |

All implementations share the same:
- Type definitions (TaskStatus, TaskStep, TaskResult, OrchestratedTask, etc.)
- Service API (create, pause, resume, cancel, search, etc.)
- Actions (CREATE_TASK, LIST_TASKS, SWITCH_TASK, SEARCH_TASKS, PAUSE_TASK, RESUME_TASK, CANCEL_TASK)
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

| Action | Description |
|--------|-------------|
| `CREATE_TASK` | Create a new orchestrated task |
| `LIST_TASKS` | List all tasks |
| `SWITCH_TASK` | Switch current task context |
| `SEARCH_TASKS` | Search tasks by query |
| `PAUSE_TASK` | Pause a running task |
| `RESUME_TASK` | Resume a paused task |
| `CANCEL_TASK` | Cancel a task |

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

Environment variable: `ELIZA_CODE_ACTIVE_SUB_AGENT`

Set this to override the default provider for new tasks.

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
