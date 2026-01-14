# Agent Orchestrator Plugin (Rust)

Rust implementation of the Agent Orchestrator plugin for ElizaOS.

## Overview

This plugin orchestrates tasks across registered agent providers without performing
file I/O directly - that responsibility belongs to sub-agent workers.

## Features

- Task lifecycle management (create, pause, resume, cancel)
- Provider-based execution model
- Event system for task state changes
- Cross-platform parity with TypeScript and Python implementations
- Optional WASM support

## Usage

```rust
use elizaos_plugin_agent_orchestrator::{
    configure_agent_orchestrator_plugin,
    AgentOrchestratorPluginOptions,
    AgentOrchestratorService,
    AgentProvider,
    OrchestratedTask,
    ProviderTaskExecutionContext,
    TaskResult,
};
use std::sync::Arc;

// Define your agent provider
struct MyProvider;

#[async_trait::async_trait]
impl AgentProvider for MyProvider {
    fn id(&self) -> &str {
        "my-agent"
    }

    fn label(&self) -> &str {
        "My Agent"
    }

    async fn execute_task(
        &self,
        task: &OrchestratedTask,
        ctx: &ProviderTaskExecutionContext,
    ) -> TaskResult {
        (ctx.append_output)("Hello from my-agent".to_string());
        (ctx.update_progress)(100);
        TaskResult::success("done")
    }
}

// Configure the plugin before runtime initialization
configure_agent_orchestrator_plugin(
    AgentOrchestratorPluginOptions::new(
        vec![Arc::new(MyProvider)],
        "my-agent",
        || std::env::current_dir().unwrap().to_string_lossy().to_string(),
    )
);
```

## Actions

- `CREATE_TASK` - Create a new orchestrated task
- `LIST_TASKS` - List all tasks
- `SWITCH_TASK` - Switch current task context
- `SEARCH_TASKS` - Search tasks by query
- `PAUSE_TASK` - Pause a running task
- `RESUME_TASK` - Resume a paused task
- `CANCEL_TASK` - Cancel a task

## Provider Trait

Providers must implement the `AgentProvider` trait:

```rust
#[async_trait::async_trait]
pub trait AgentProvider: Send + Sync {
    fn id(&self) -> &str;
    fn label(&self) -> &str;
    fn description(&self) -> Option<&str> { None }
    
    async fn execute_task(
        &self,
        task: &OrchestratedTask,
        ctx: &ProviderTaskExecutionContext,
    ) -> TaskResult;
}
```

## Building

```bash
cargo build --release

# With WASM support
cargo build --release --features wasm
```

## Testing

```bash
cargo test
```

## License

MIT
