"""Create todo action for Todo plugin."""

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
    TodoFilters,
    TodoMetadata,
)

if TYPE_CHECKING:
    from elizaos.types import (
        ActionExample,
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )

logger = logging.getLogger(__name__)


@dataclass
class CreateTodoResult:
    """Result of a create todo action."""

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
    """Handle create todo action.

    Args:
        runtime: The agent runtime.
        message: The message that triggered the action.
        state: Optional state context.
        options: Optional handler options.
        callback: Optional callback for streaming responses.
        responses: Optional previous responses.

    Returns:
        The action result.
    """
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

    # Compose state with relevant providers
    if not state:
        state = await runtime.compose_state(message, ["TODOS", "RECENT_MESSAGES"])

    # Extract todo info from message
    # For now, we'll use a simplified extraction - in production this would use LLM
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

    # Get the data service
    data_service = create_todo_data_service(runtime.db if hasattr(runtime, "db") else None)

    # Check for duplicates
    existing_todos = await data_service.get_todos(
        {
            "entity_id": message.entity_id,
            "room_id": message.room_id,
            "is_completed": False,
        }
    )

    # Simple extraction - in production, use LLM to extract structured data
    todo_name = message_text.strip()
    task_type = TaskType.ONE_OFF  # Default
    priority = Priority.MEDIUM

    # Check for keywords to determine task type
    if "daily" in message_text.lower():
        task_type = TaskType.DAILY
    elif "aspirational" in message_text.lower() or "goal" in message_text.lower():
        task_type = TaskType.ASPIRATIONAL

    duplicate_todo = next(
        (t for t in existing_todos if t.name.strip() == todo_name.strip()), None
    )

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

    # Get room details for world_id
    room = await runtime.get_room(message.room_id) if hasattr(runtime, "get_room") else None
    world_id = (
        room.world_id if room and hasattr(room, "world_id") else message.world_id or runtime.agent_id
    )

    # Create tags
    tags = ["TODO"]
    if task_type == TaskType.DAILY:
        tags.append("daily")
    elif task_type == TaskType.ONE_OFF:
        tags.append("one-off")
        if priority:
            tags.append(f"priority-{priority.value}")
    elif task_type == TaskType.ASPIRATIONAL:
        tags.append("aspirational")

    # Create metadata
    metadata = {
        "created_at": datetime.utcnow().isoformat(),
    }

    # Create the todo
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
            success_message = f'✅ Added new daily task: "{todo_name}". This task will reset each day.'
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

        return CreateTodoResult(
            success=True, text=success_message, todo_id=created_todo_id
        )

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
    """Validate if create todo action can be executed.

    Args:
        runtime: The agent runtime.
        message: The message.
        state: Optional state.

    Returns:
        True if the action can be executed.
    """
    # No validation needed - let handler decide
    return True


# Action definition for elizaOS integration
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
