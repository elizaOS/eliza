# @elizaos/plugin-todo

A multi-language Todo task management plugin for elizaOS, providing comprehensive task functionality with daily recurring, one-off, and aspirational tasks.

## 🌐 Multi-Language Support

This plugin is implemented in three languages for maximum flexibility:

| Language   | Package                | Registry  |
| ---------- | ---------------------- | --------- |
| TypeScript | `@elizaos/plugin-todo` | npm       |
| Rust       | `elizaos-plugin-todo`  | crates.io |
| Python     | `elizaos-plugin-todo`  | PyPI      |

All implementations share the same API design, behavior, and feature set.

## Features

- 📋 **Task Types** - Daily recurring, one-off with deadlines, and aspirational goals
- ⭐ **Priority Levels** - Critical, High, Medium, Low (1-4)
- ⏰ **Due Dates** - Track deadlines with automatic overdue detection
- 🏷️ **Tags** - Organize tasks with custom tags
- 🔔 **Reminders** - Automatic reminder notifications with quiet hours
- 💾 **Caching** - High-performance in-memory caching with LRU eviction
- 🔗 **Integration** - Connects with rolodex for multi-platform notifications
- 🧪 **Tested** - Comprehensive unit and integration tests

## Quick Start

### TypeScript

```typescript
import { todoPlugin } from "@elizaos/plugin-todo";
import { AgentRuntime } from "@elizaos/core";

// Register the plugin
const runtime = new AgentRuntime({
  plugins: [todoPlugin],
});

// The plugin provides actions:
// - CREATE_TODO: Create new tasks from natural language
// - COMPLETE_TODO: Mark tasks as completed
// - UPDATE_TODO: Modify existing tasks
// - CANCEL_TODO: Remove tasks
// - CONFIRM_TODO: Confirm pending task creation
```

### Rust

```rust
use elizaos_plugin_todo::{TodoClient, TodoConfig, TaskType, Priority, CreateTodoParams};
use uuid::Uuid;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = TodoConfig::from_env()?;
    let mut client = TodoClient::new(config)?;
    client.start().await?;

    let todo = client.create_todo(CreateTodoParams {
        name: "Finish report".to_string(),
        task_type: TaskType::OneOff,
        priority: Some(Priority::High),
        ..Default::default()
    }).await?;

    println!("Created: {}", todo.name);
    Ok(())
}
```

### Python

```python
import asyncio
from elizaos_plugin_todo import TodoClient, TodoConfig, TaskType, Priority

async def main():
    config = TodoConfig.from_env()

    async with TodoClient(config) as client:
        todo = await client.create_todo(
            name="Finish report",
            task_type=TaskType.ONE_OFF,
            priority=Priority.HIGH,
            agent_id=uuid4(),
            world_id=uuid4(),
            room_id=uuid4(),
            entity_id=uuid4(),
        )
        print(f"Created: {todo.name}")

asyncio.run(main())
```

## Installation

### TypeScript (npm)

```bash
npm install @elizaos/plugin-todo
# or
bun add @elizaos/plugin-todo
```

### Rust (Cargo)

```toml
[dependencies]
elizaos-plugin-todo = "1.0"
```

### Python (pip)

```bash
pip install elizaos-plugin-todo
```

## Configuration

All implementations use the same environment variables:

| Variable                        | Required | Default   | Description                    |
| ------------------------------- | -------- | --------- | ------------------------------ |
| `DATABASE_URL`                  | No       | -         | Database connection string     |
| `TODO_ENABLE_REMINDERS`         | No       | `true`    | Enable reminder notifications  |
| `TODO_REMINDER_INTERVAL_MS`     | No       | `30000`   | Reminder check interval (ms)   |
| `TODO_MIN_REMINDER_INTERVAL_MS` | No       | `1800000` | Min interval between reminders |
| `TODO_QUIET_HOURS_START`        | No       | `22`      | Quiet hours start (hour 0-23)  |
| `TODO_QUIET_HOURS_END`          | No       | `8`       | Quiet hours end (hour 0-23)    |
| `TODO_CACHE_MAX_SIZE`           | No       | `1000`    | Maximum cache entries          |
| `TODO_ENABLE_ROLODEX`           | No       | `true`    | Enable rolodex integration     |

## Task Types

### Daily Tasks

Recurring tasks that reset each day. Track streaks and completion status.

```typescript
// TypeScript
await client.create_todo({
  name: "Morning exercise",
  task_type: TaskType.DAILY,
});
```

### One-Off Tasks

Single tasks with optional due dates and priorities.

```typescript
await client.create_todo({
  name: "Finish taxes",
  task_type: TaskType.ONE_OFF,
  priority: Priority.HIGH,
  due_date: new Date("2024-04-15"),
  is_urgent: true,
});
```

### Aspirational Goals

Long-term goals without specific deadlines.

```typescript
await client.create_todo({
  name: "Learn a new language",
  task_type: TaskType.ASPIRATIONAL,
});
```

## API Reference

### Actions (TypeScript/elizaOS)

| Action          | Description                             |
| --------------- | --------------------------------------- |
| `CREATE_TODO`   | Create a new task from natural language |
| `COMPLETE_TODO` | Mark a task as completed                |
| `UPDATE_TODO`   | Modify an existing task                 |
| `CANCEL_TODO`   | Delete a task                           |
| `CONFIRM_TODO`  | Confirm pending task creation           |

### Client Methods

| Method                       | Description                     |
| ---------------------------- | ------------------------------- |
| `create_todo(params)`        | Create a new todo               |
| `get_todo(id)`               | Get a todo by ID                |
| `get_todos(filters)`         | Get todos with optional filters |
| `complete_todo(id)`          | Mark a todo as completed        |
| `uncomplete_todo(id)`        | Mark a todo as not completed    |
| `update_todo(id, updates)`   | Update a todo                   |
| `delete_todo(id)`            | Delete a todo                   |
| `get_overdue_todos(filters)` | Get overdue tasks               |
| `reset_daily_todos(filters)` | Reset daily tasks for new day   |
| `add_tags(id, tags)`         | Add tags to a todo              |
| `remove_tags(id, tags)`      | Remove tags from a todo         |

### Types

```typescript
// Task Types
type TaskType = "daily" | "one-off" | "aspirational";

// Priority Levels
type Priority = 1 | 2 | 3 | 4; // 1 = Critical, 4 = Low

// Recurring Patterns
type RecurringPattern = "daily" | "weekly" | "monthly";

// Notification Types
type NotificationType = "overdue" | "upcoming" | "daily" | "system";
```

## Project Structure

```
plugin-todo/
├── typescript/           # TypeScript implementation
│   ├── index.ts         # Main entry point
│   ├── actions/         # Action handlers
│   ├── providers/       # Data providers
│   ├── services/        # Background services
│   ├── types/           # Type definitions
│   └── __tests__/       # Tests
├── rust/                 # Rust implementation
│   ├── src/
│   │   ├── lib.rs       # Library entry
│   │   ├── client.rs    # Todo client
│   │   ├── types.rs     # Type definitions
│   │   └── ...
│   └── tests/           # Integration tests
├── python/              # Python implementation
│   ├── elizaos_plugin_todo/
│   │   ├── __init__.py  # Package entry
│   │   ├── client.py    # Todo client
│   │   ├── types.py     # Type definitions
│   │   └── ...
│   └── tests/           # Tests
├── package.json         # npm package config
└── README.md           # This file
```

## Development

### Prerequisites

- **TypeScript**: Bun or Node.js 18+
- **Rust**: Rust 1.70+ with cargo
- **Python**: Python 3.11+

### Running Tests

```bash
# TypeScript
cd typescript
npx vitest

# Rust
cd rust
cargo test

# Python
cd python
pip install -e ".[dev]"
pytest
```

### Building

```bash
# TypeScript
bun run build

# Rust
cd rust && cargo build --release

# Python
cd python && pip install build && python -m build
```

### Linting

```bash
# TypeScript
bun run lint

# Rust
cd rust && cargo clippy

# Python
cd python && ruff check . && ruff format .
```

## Services

### TodoReminderService

Handles automatic reminder notifications:

- Checks for overdue tasks
- Sends upcoming task reminders
- Daily task reminders at configured times
- Rate limiting to prevent notification spam

### NotificationManager

Manages notification delivery:

- In-app notifications
- Browser notifications (when enabled)
- Quiet hours respect
- User preference management

### CacheManager

High-performance caching:

- LRU eviction
- TTL support
- Pattern-based operations
- Statistics tracking

## Integration

### Rolodex Integration

When `@elizaos/plugin-rolodex` is available, reminders are sent across all connected platforms:

```typescript
// Reminder automatically sent to Discord, Telegram, etc.
const reminderService = runtime.getService("TODO_REMINDER");
await reminderService.checkTasksForReminders();
```

### Database

Requires `@elizaos/plugin-sql` for persistent storage. Schema includes:

- `todos` table for task data
- `todo_tags` table for tag associations

## Error Handling

All implementations follow a **fail-fast** philosophy:

- Input validation with clear error messages
- No silent failures
- Descriptive error types

### Error Types

| Error               | Description                  |
| ------------------- | ---------------------------- |
| `ValidationError`   | Invalid input parameters     |
| `NotFoundError`     | Todo not found               |
| `DatabaseError`     | Database operation failed    |
| `ConfigError`       | Invalid configuration        |
| `ReminderError`     | Reminder operation failed    |
| `NotificationError` | Notification delivery failed |

## License

MIT - see [LICENSE](./rust/LICENSE)

## Contributing

See the [elizaOS contributing guide](https://github.com/elizaos/eliza/blob/main/CONTRIBUTING.md).
