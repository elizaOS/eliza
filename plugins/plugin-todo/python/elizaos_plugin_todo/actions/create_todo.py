from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING
from uuid import UUID

from elizaos_plugin_todo.data_service import create_todo_data_service
from elizaos_plugin_todo.errors import ValidationError
from elizaos_plugin_todo.types import (
    CreateTodoParams,
    Priority,
    TaskType,
    TodoMetadata,
)

if TYPE_CHECKING:
    from elizaos.types import (
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )

logger = logging.getLogger(__name__)


@dataclass
class CreateTodoResult:
    success: bool
    text: str
    todo_id: UUID | None = None
    error: str | None = None


async def handle_create_todo(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> CreateTodoResult | None:
    if not message.room_id or not message.entity_id:
        error_msg = "I cannot create a todo without a room and entity context."
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["CREATE_TODO_FAILED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return CreateTodoResult(success=False, text=error_msg, error=error_msg)

    if not state:
        state = await runtime.compose_state(message, ["TODOS", "RECENT_MESSAGES"])

    message_text = message.content.text if message.content else ""
    if not message_text:
        error_msg = "I couldn't understand the details of the todo you want to create. Could you please provide more information?"
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["CREATE_TODO_FAILED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return CreateTodoResult(success=False, text=error_msg, error=error_msg)

    # Prefer the runtime (task-backed persistence) when available, otherwise fall back to
    # a pre-injected in-memory TodoDataService on `runtime.db` (used by tests/mocks).
    runtime_or_db = (
        runtime
        if hasattr(runtime, "create_task") and hasattr(runtime, "get_tasks")
        else (runtime.db if hasattr(runtime, "db") else None)
    )
    data_service = create_todo_data_service(runtime_or_db)

    existing_todos = await data_service.get_todos(
        {
            "entity_id": message.entity_id,
            "room_id": message.room_id,
            "is_completed": False,
        }
    )

    todo_name = message_text.strip()
    task_type = TaskType.ONE_OFF
    priority = Priority.MEDIUM

    if "daily" in message_text.lower():
        task_type = TaskType.DAILY
    elif "aspirational" in message_text.lower() or "goal" in message_text.lower():
        task_type = TaskType.ASPIRATIONAL

    duplicate_todo = next((t for t in existing_todos if t.name.strip() == todo_name.strip()), None)

    if duplicate_todo:
        logger.warning(f"Duplicate task found for name '{todo_name}'. ID: {duplicate_todo.id}")
        error_msg = f'It looks like you already have an active task named "{todo_name}". I haven\'t added a duplicate.'
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["CREATE_TODO_DUPLICATE"],
                    "source": message.content.source if message.content else None,
                }
            )
        return CreateTodoResult(success=False, text=error_msg, error="Duplicate task found")

    room = await runtime.get_room(message.room_id) if hasattr(runtime, "get_room") else None
    world_id = (
        room.world_id
        if room and hasattr(room, "world_id")
        else message.world_id or runtime.agent_id
    )

    tags = ["TODO"]
    if task_type == TaskType.DAILY:
        tags.append("daily")
    elif task_type == TaskType.ONE_OFF:
        tags.append("one-off")
        if priority:
            tags.append(f"priority-{priority.value}")
    elif task_type == TaskType.ASPIRATIONAL:
        tags.append("aspirational")

    metadata = {
        "created_at": datetime.utcnow().isoformat(),
    }

    try:
        params = CreateTodoParams(
            agent_id=runtime.agent_id,
            world_id=world_id,
            room_id=message.room_id,
            entity_id=message.entity_id,
            name=todo_name,
            description=todo_name,
            type=task_type,
            priority=priority if task_type == TaskType.ONE_OFF else None,
            is_urgent=False,
            due_date=None,
            metadata=TodoMetadata(**metadata),
            tags=tags,
        )
        created_todo_id = await data_service.create_todo(params)

        if not created_todo_id:
            raise ValidationError("Failed to create todo, dataService.create_todo returned None")

        # Generate success message
        if task_type == TaskType.DAILY:
            success_message = (
                f'✅ Added new daily task: "{todo_name}". This task will reset each day.'
            )
        elif task_type == TaskType.ONE_OFF:
            priority_text = f"Priority {priority.value if priority else 'default'}"
            success_message = f'✅ Added new one-off task: "{todo_name}" ({priority_text})'
        else:
            success_message = f'✅ Added new aspirational goal: "{todo_name}"'

        if callback:
            await callback(
                {
                    "text": success_message,
                    "actions": ["CREATE_TODO_SUCCESS"],
                    "source": message.content.source if message.content else None,
                }
            )

        return CreateTodoResult(success=True, text=success_message, todo_id=created_todo_id)

    except Exception as e:
        error_msg = f"Failed to create todo: {str(e)}"
        logger.error(error_msg, exc_info=True)
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["CREATE_TODO_FAILED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return CreateTodoResult(success=False, text=error_msg, error=str(e))


async def validate_create_todo(
    runtime: IAgentRuntime, message: Memory, state: State | None = None
) -> bool:
    return True


CREATE_TODO_ACTION = {
    "name": "CREATE_TODO",
    "similes": ["ADD_TODO", "NEW_TASK", "ADD_TASK", "CREATE_TASK"],
    "description": "Creates a new todo item from a user description (daily, one-off, or aspirational) immediately.",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Add a todo to finish my taxes by April 15"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": "✅ Added new one-off task: 'Finish taxes' (Priority 3)",
                    "actions": ["CREATE_TODO_SUCCESS"],
                },
            },
        ],
        [
            {
                "name": "{{name1}}",
                "content": {"text": "I want to add a daily task to do 50 pushups"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": "✅ Added new daily task: 'Do 50 pushups'. This task will reset each day.",
                    "actions": ["CREATE_TODO_SUCCESS"],
                },
            },
        ],
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Please add an aspirational goal to read more books"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": "✅ Added new aspirational goal: 'Read more books'",
                    "actions": ["CREATE_TODO_SUCCESS"],
                },
            },
        ],
    ],
}
