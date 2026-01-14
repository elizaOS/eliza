# Agent Orchestrator Plugin (Python)

Python implementation of the Agent Orchestrator plugin for ElizaOS.

## Overview

This plugin orchestrates tasks across registered agent providers without performing
file I/O directly - that responsibility belongs to sub-agent workers.

## Features

- Task lifecycle management (create, pause, resume, cancel)
- Provider-based execution model
- Event system for task state changes
- Cross-platform parity with TypeScript and Rust implementations

## Installation

```bash
pip install elizaos-plugin-agent-orchestrator
```

## Usage

```python
from elizaos_plugin_agent_orchestrator import (
    configure_agent_orchestrator_plugin,
    AgentOrchestratorPluginOptions,
    plugin,
)

# Define your agent provider
class MyProvider:
    id = "my-agent"
    label = "My Agent"
    description = "Custom agent provider"

    async def execute_task(self, task, ctx):
        await ctx.append_output("Hello from my-agent")
        await ctx.update_progress(100)
        return TaskResult(
            success=True,
            summary="done",
            files_created=[],
            files_modified=[],
        )

# Configure the plugin before runtime initialization
configure_agent_orchestrator_plugin(
    AgentOrchestratorPluginOptions(
        providers=[MyProvider()],
        default_provider_id="my-agent",
        get_working_directory=lambda: os.getcwd(),
    )
)

# Register the plugin with your runtime
runtime.register_plugin(plugin)
```

## Actions

- `CREATE_TASK` - Create a new orchestrated task
- `LIST_TASKS` - List all tasks
- `SWITCH_TASK` - Switch current task context
- `SEARCH_TASKS` - Search tasks by query
- `PAUSE_TASK` - Pause a running task
- `RESUME_TASK` - Resume a paused task
- `CANCEL_TASK` - Cancel a task

## Provider Interface

Providers must implement the `AgentProvider` protocol:

```python
class AgentProvider(Protocol):
    @property
    def id(self) -> str: ...
    
    @property
    def label(self) -> str: ...
    
    @property
    def description(self) -> Optional[str]: ...
    
    async def execute_task(
        self,
        task: OrchestratedTask,
        ctx: ProviderTaskExecutionContext,
    ) -> TaskResult: ...
```

## License

MIT
