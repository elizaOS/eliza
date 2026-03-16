from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID

from elizaos_plugin_todo.data_service import create_todo_data_service
from elizaos_plugin_todo.types import (
    CreateTodoParams,
    Priority,
    TaskType,
    TodoFilters,
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
class ConfirmTodoResult:
    success: bool
    text: str
    todo_id: UUID | None = None
    error: str | None = None


async def handle_confirm_todo(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ConfirmTodoResult | None:
    """Handle confirm todo action.

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
    if not state:
        error_msg = "Unable to process confirmation without state context."
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["CONFIRM_TODO_ERROR"],
                    "source": message.content.source if message.content else None,
                }
            )
        return ConfirmTodoResult(success=False, text=error_msg, error=error_msg)

    pending_todo = None
    if state.data and isinstance(state.data, dict):
        pending_todo = state.data.get("pendingTodo")

    if not pending_todo:
        error_msg = "I don't have a pending task to confirm. Would you like to create a new task?"
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["CONFIRM_TODO_NO_PENDING"],
                    "source": message.content.source if message.content else None,
                }
            )
        return ConfirmTodoResult(success=False, text=error_msg)

    if not message.room_id or not message.entity_id:
        error_msg = "I cannot confirm a todo without a room and entity context."
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["CONFIRM_TODO_ERROR"],
                    "source": message.content.source if message.content else None,
                }
            )
        return ConfirmTodoResult(success=False, text=error_msg, error=error_msg)

    message_text = message.content.text if message.content else ""
    is_confirmation = any(
        word in message_text.lower()
        for word in ["yes", "yep", "yeah", "sure", "ok", "okay", "confirm", "create", "add"]
    )
    should_proceed = is_confirmation and not any(
        word in message_text.lower()
        for word in ["no", "nope", "cancel", "don't", "dont", "nevermind"]
    )

    if not is_confirmation:
        pending_name = (
            pending_todo.get("name", "task") if isinstance(pending_todo, dict) else "task"
        )
        error_msg = f'I\'m still waiting for your confirmation on the task "{pending_name}". Would you like me to create it?'
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["CONFIRM_TODO_WAITING"],
                    "source": message.content.source if message.content else None,
                }
            )
        return ConfirmTodoResult(success=False, text=error_msg)

    if not should_proceed:
        if state.data and isinstance(state.data, dict):
            state.data.pop("pendingTodo", None)

        error_msg = "Okay, I've cancelled the task creation. Let me know if you'd like to create a different task."
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["CONFIRM_TODO_CANCELLED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return ConfirmTodoResult(success=False, text="Task creation cancelled")

    # Prefer the runtime (task-backed persistence) when available, otherwise fall back to
    # a pre-injected in-memory TodoDataService on `runtime.db` (used by tests/mocks).
    runtime_or_db = (
        runtime
        if hasattr(runtime, "create_task") and hasattr(runtime, "get_tasks")
        else (runtime.db if hasattr(runtime, "db") else None)
    )
    data_service = create_todo_data_service(runtime_or_db)

    filters = TodoFilters(
        entity_id=message.entity_id,
        room_id=message.room_id,
        is_completed=False,
    )
    existing_todos = await data_service.get_todos(filters)

    pending_name = pending_todo.get("name", "").strip() if isinstance(pending_todo, dict) else ""
    duplicate_todo = next((t for t in existing_todos if t.name.strip() == pending_name), None)

    if duplicate_todo:
        if state.data and isinstance(state.data, dict):
            state.data.pop("pendingTodo", None)
        error_msg = f'It looks like you already have an active task named "{pending_name}". I haven\'t added a duplicate.'
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["CONFIRM_TODO_DUPLICATE"],
                    "source": message.content.source if message.content else None,
                }
            )
        return ConfirmTodoResult(success=False, text="Duplicate task found")

    room = await runtime.get_room(message.room_id) if hasattr(runtime, "get_room") else None
    world_id = (
        room.world_id
        if room and hasattr(room, "world_id")
        else message.world_id or runtime.agent_id
    )

    if isinstance(pending_todo, dict):
        task_type_str = pending_todo.get("taskType", "one-off")
        task_type = (
            TaskType(task_type_str)
            if task_type_str in ["daily", "one-off", "aspirational"]
            else TaskType.ONE_OFF
        )
        priority_val = pending_todo.get("priority")
        priority = (
            Priority(priority_val)
            if priority_val
            else (Priority.MEDIUM if task_type == TaskType.ONE_OFF else None)
        )
        urgent = pending_todo.get("urgent", False)
        pending_todo.get("dueDate")
        due_date = None
        tags = pending_todo.get("tags", [])
        metadata_dict = pending_todo.get("metadata", {})
    else:
        task_type = TaskType.ONE_OFF
        priority = Priority.MEDIUM
        urgent = False
        due_date = None
        tags = ["TODO"]
        metadata_dict = {}

    params = CreateTodoParams(
        agent_id=runtime.agent_id,
        world_id=world_id,
        room_id=message.room_id,
        entity_id=message.entity_id,
        name=pending_name,
        description=pending_todo.get("description", pending_name)
        if isinstance(pending_todo, dict)
        else pending_name,
        type=task_type,
        priority=priority if task_type == TaskType.ONE_OFF else None,
        is_urgent=urgent if task_type == TaskType.ONE_OFF else False,
        due_date=due_date,
        metadata=TodoMetadata(**metadata_dict) if metadata_dict else TodoMetadata(),
        tags=tags,
    )

    created_todo_id = await data_service.create_todo(params)

    if not created_todo_id:
        raise Exception("Failed to create todo")

    if state.data and isinstance(state.data, dict):
        state.data.pop("pendingTodo", None)

    if task_type == TaskType.DAILY:
        success_message = (
            f'✅ Created daily task: "{pending_name}". Complete it regularly to build your streak!'
        )
    elif task_type == TaskType.ONE_OFF:
        priority_text = f"Priority {priority.value if priority else 3}"
        urgent_text = ", Urgent" if urgent else ""
        success_message = f'✅ Created task: "{pending_name}" ({priority_text}{urgent_text})'
    else:
        success_message = f'✅ Created aspirational goal: "{pending_name}"'

    if callback:
        await callback(
            {
                "text": success_message,
                "actions": ["CONFIRM_TODO_SUCCESS"],
                "source": message.content.source if message.content else None,
            }
        )

    return ConfirmTodoResult(success=True, text=success_message, todo_id=created_todo_id)


async def validate_confirm_todo(
    runtime: IAgentRuntime, message: Memory, state: State | None = None
) -> bool:
    if not state or not state.data or not isinstance(state.data, dict):
        return False
    pending_todo = state.data.get("pendingTodo")
    return pending_todo is not None


CONFIRM_TODO_ACTION = {
    "name": "CONFIRM_TODO",
    "similes": ["CONFIRM_TASK", "APPROVE_TODO", "APPROVE_TASK", "TODO_CONFIRM"],
    "description": "Confirms or cancels a pending todo creation after user review.",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Add a todo to finish my taxes by April 15"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": "I'll create a one-off todo: 'Finish taxes' with Priority 2, Due April 15.\n\nIs this correct?",
                    "actions": ["CREATE_TODO_PREVIEW"],
                },
            },
            {
                "name": "{{name1}}",
                "content": {"text": "Yes, that looks good"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": "✅ Created task: 'Finish taxes' (Priority 2)",
                    "actions": ["CONFIRM_TODO_SUCCESS"],
                },
            },
        ],
    ],
}
