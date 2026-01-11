# elizaOS Planning Plugin - Rust

Comprehensive planning and execution capabilities for elizaOS agents.

## Features

- **Message Classification**: Classify messages by complexity
- **Simple Planning**: Quick plan generation for basic tasks
- **Comprehensive Planning**: Multi-step plans with LLM generation
- **Execution Models**: Sequential, parallel, and DAG execution
- **Plan Validation**: Validates plans and detects cycles
- **Plan Adaptation**: Adapts plans based on execution results

Note: Benchmarking is not included in the Rust implementation. Use the Python or TypeScript versions for benchmarking.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-planning = "1.0"
```

## Usage

```rust
use elizaos_plugin_planning::{PlanningService, PlanningConfig, PlanningContext, ExecutionModel};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Create configuration
    let config = PlanningConfig::default();

    // Initialize service
    let service = PlanningService::new(config);
    service.start().await;

    // Create a planning context
    let context = PlanningContext {
        goal: "Build a comprehensive website".to_string(),
        constraints: vec![],
        available_actions: vec!["ANALYZE".to_string(), "CREATE".to_string()],
        available_providers: vec![],
        preferences: Some(PlanningPreferences {
            execution_model: Some(ExecutionModel::Sequential),
            max_steps: Some(5),
            timeout_ms: None,
        }),
    };

    // Create a plan
    let plan = service.create_comprehensive_plan(&context, None).await?;
    println!("Created plan with {} steps", plan.steps.len());

    // Create a simple message
    let message = Message {
        id: uuid::Uuid::new_v4(),
        entity_id: uuid::Uuid::new_v4(),
        room_id: uuid::Uuid::new_v4(),
        content: MessageContent {
            text: "Build a website".to_string(),
            source: None,
        },
    };

    // Execute the plan
    let result = service.execute_plan(&plan, &message).await?;
    println!("Execution success: {}", result.success);

    service.stop().await;

    Ok(())
}
```

## Configuration

| Setting                      | Default    | Description               |
| ---------------------------- | ---------- | ------------------------- |
| `PLANNING_MAX_STEPS`         | 10         | Maximum steps in a plan   |
| `PLANNING_TIMEOUT_MS`        | 60000      | Default execution timeout |
| `PLANNING_EXECUTION_MODEL`   | sequential | Default execution model   |
| `PLANNING_ENABLE_ADAPTATION` | true       | Enable plan adaptation    |

## Development

```bash
# Build
cargo build

# Run tests
cargo test

# Check lints
cargo clippy --all-targets -- -D warnings

# Format
cargo fmt
```

## License

MIT



