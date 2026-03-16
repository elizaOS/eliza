# elizaOS Todo Plugin - Python

Python implementation of the elizaOS Todo Plugin for task management.

## Installation

```bash
pip install elizaos-plugin-todo
```

## Quick Start

```python
import asyncio
from uuid import uuid4
from elizaos_plugin_todo import (
    TodoClient,
    TodoConfig,
    TaskType,
    Priority,
)

async def main():
    config = TodoConfig.from_env()

    async with TodoClient(config) as client:
        # Create a new todo
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

        # Complete the todo
        completed = await client.complete_todo(todo.id)
        print(f"Completed: {completed.is_completed}")

asyncio.run(main())
```

## Features

- **Task Types**: Daily recurring, one-off, and aspirational tasks
- **Priority Levels**: Critical (1), High (2), Medium (3), Low (4)
- **Due Dates**: Track deadlines for one-off tasks
- **Tags**: Organize tasks with custom tags
- **Reminders**: Automatic reminder notifications
- **Caching**: High-performance in-memory caching

## Configuration

Environment variables:

| Variable                    | Default | Description                   |
| --------------------------- | ------- | ----------------------------- |
| `DATABASE_URL`              | -       | Database connection string    |
| `TODO_ENABLE_REMINDERS`     | `true`  | Enable reminder notifications |
| `TODO_REMINDER_INTERVAL_MS` | `30000` | Reminder check interval (ms)  |
| `TODO_QUIET_HOURS_START`    | `22`    | Quiet hours start (hour)      |
| `TODO_QUIET_HOURS_END`      | `8`     | Quiet hours end (hour)        |

## API Reference

### TodoClient

Main client for todo operations.

```python
async with TodoClient(config) as client:
    # Create todo
    todo = await client.create_todo(name="...", task_type=TaskType.ONE_OFF, ...)

    # Get todos
    todos = await client.get_todos(room_id=room_id, is_completed=False)

    # Complete todo
    await client.complete_todo(todo_id)

    # Update todo
    await client.update_todo(todo_id, name="New name", priority=Priority.HIGH)

    # Delete todo
    await client.delete_todo(todo_id)
```

### Types

```python
from elizaos_plugin_todo import TaskType, Priority

# Task types
TaskType.DAILY       # Daily recurring task
TaskType.ONE_OFF     # One-off task with optional due date
TaskType.ASPIRATIONAL  # Long-term goal

# Priorities
Priority.CRITICAL  # 1 - Highest
Priority.HIGH      # 2
Priority.MEDIUM    # 3
Priority.LOW       # 4 - Lowest
```

## Testing

```bash
cd python
pip install -e ".[dev]"
pytest
```

## License

MIT



