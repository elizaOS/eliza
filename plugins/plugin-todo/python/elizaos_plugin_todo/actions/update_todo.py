from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID

from elizaos_plugin_todo.data_service import create_todo_data_service
from elizaos_plugin_todo.types import TodoFilters, UpdateTodoParams

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
class UpdateTodoResult:
    success: bool
    text: str
    todo_id: UUID | None = None
    error: str | None = None


async def handle_update_todo(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> UpdateTodoResult | None:
    if not state:
        error_msg = "Unable to process request without state context."
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["UPDATE_TODO_ERROR"],
                    "source": message.content.source if message.content else None,
                }
            )
        return UpdateTodoResult(success=False, text=error_msg, error=error_msg)

    if not message.room_id:
        error_msg = "I cannot update a todo without a room context."
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["UPDATE_TODO_ERROR"],
                    "source": message.content.source if message.content else None,
                }
            )
        return UpdateTodoResult(success=False, text=error_msg, error=error_msg)

    # Prefer the runtime (task-backed persistence) when available, otherwise fall back to
    # a pre-injected in-memory TodoDataService on `runtime.db` (used by tests/mocks).
    runtime_or_db = (
        runtime
        if hasattr(runtime, "create_task") and hasattr(runtime, "get_tasks")
        else (runtime.db if hasattr(runtime, "db") else None)
    )
    data_service = create_todo_data_service(runtime_or_db)

    # Get all active todos for this room
    filters = TodoFilters(
        room_id=message.room_id,
        is_completed=False,
    )
    available_tasks = await data_service.get_todos(filters)

    if len(available_tasks) == 0:
        error_msg = (
            "You don't have any active tasks to update. Would you like to create a new task?"
        )
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["UPDATE_TODO_NO_TASKS"],
                    "source": message.content.source if message.content else None,
                }
            )
        return UpdateTodoResult(success=False, text=error_msg)

    task_id = None
    if options and options.parameters and "task_id" in options.parameters:
        task_id = UUID(str(options.parameters["task_id"]))

    if not task_id:
        task = available_tasks[0]
    else:
        task = next((t for t in available_tasks if t.id == task_id), None)
        if not task:
            error_msg = (
                "I couldn't determine which task you want to update. Could you be more specific? "
                "Here are your current tasks:\n\n"
                + "\n".join(f"- {t.name}" for t in available_tasks)
            )
            if callback:
                await callback(
                    {
                        "text": error_msg,
                        "actions": ["UPDATE_TODO_NOT_FOUND"],
                        "source": message.content.source if message.content else None,
                    }
                )
            return UpdateTodoResult(success=False, text=error_msg, error="Task not found")

    message_text = message.content.text if message.content else ""
    update_params = UpdateTodoParams()

    if "priority" in message_text.lower():
        if "high" in message_text.lower() or "1" in message_text:
            from elizaos_plugin_todo.types import Priority

            update_params.priority = Priority.HIGH
        elif "medium" in message_text.lower() or "3" in message_text:
            from elizaos_plugin_todo.types import Priority

            update_params.priority = Priority.MEDIUM

    if "urgent" in message_text.lower():
        update_params.is_urgent = True

    if not any(
        [
            update_params.name,
            update_params.description,
            update_params.priority,
            update_params.is_urgent is not None,
            update_params.due_date,
        ]
    ):
        error_msg = (
            f'I couldn\'t determine what changes you want to make to "{task.name}". '
            "Could you please specify what you want to update, such as the name, description, priority, or due date?"
        )
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["UPDATE_TODO_INVALID_UPDATE"],
                    "source": message.content.source if message.content else None,
                }
            )
            return UpdateTodoResult(success=False, text=error_msg, error="Invalid update")

    await data_service.update_todo(task.id, update_params)

    updated_task = await data_service.get_todo(task.id)

    if callback:
        await callback(
            {
                "text": f'✓ Task updated: "{updated_task.name if updated_task else task.name}" has been updated.',
                "actions": ["UPDATE_TODO_SUCCESS"],
                "source": message.content.source if message.content else None,
            }
        )

    return UpdateTodoResult(
        success=True,
        text=f'Task updated: "{updated_task.name if updated_task else task.name}"',
        todo_id=task.id,
    )


async def validate_update_todo(
    runtime: IAgentRuntime, message: Memory, state: State | None = None
) -> bool:
    if not message.room_id:
        return False

    # Prefer passing the runtime so the data service can persist via plugin-sql tasks.
    data_service = create_todo_data_service(runtime)
    filters = TodoFilters(
        room_id=message.room_id,
        is_completed=False,
    )
    todos = await data_service.get_todos(filters)
    return len(todos) > 0


UPDATE_TODO_ACTION = {
    "name": "UPDATE_TODO",
    "similes": ["EDIT_TODO", "MODIFY_TASK", "CHANGE_TASK", "MODIFY_TODO", "EDIT_TASK"],
    "description": "Updates an existing todo item immediately based on user description.",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Update my taxes task to be due on April 18 instead"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": '✓ Task updated: "Finish taxes" has been updated.',
                    "actions": ["UPDATE_TODO_SUCCESS"],
                },
            },
        ],
        [
            {
                "name": "{{name1}}",
                "content": {
                    "text": "Change the priority of my report task to high priority and make it urgent"
                },
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": '✓ Task updated: "Write report" has been updated.',
                    "actions": ["UPDATE_TODO_SUCCESS"],
                },
            },
        ],
    ],
}
