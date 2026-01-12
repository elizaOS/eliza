"""Cancel todo action for Todo plugin."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID

from elizaos_plugin_todo.data_service import create_todo_data_service
from elizaos_plugin_todo.types import TodoFilters

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
class CancelTodoResult:
    """Result of a cancel todo action."""

    success: bool
    text: str
    todo_id: UUID | None = None
    error: str | None = None


async def handle_cancel_todo(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> CancelTodoResult | None:
    """Handle cancel todo action.

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
        error_msg = "Unable to process request without state context."
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["CANCEL_TODO_ERROR"],
                    "source": message.content.source if message.content else None,
                }
            )
        return CancelTodoResult(success=False, text=error_msg, error=error_msg)

    if not message.room_id:
        error_msg = "I cannot manage todos without a room context."
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["CANCEL_TODO_ERROR"],
                    "source": message.content.source if message.content else None,
                }
            )
        return CancelTodoResult(success=False, text=error_msg, error=error_msg)

    data_service = create_todo_data_service(runtime.db if hasattr(runtime, "db") else None)

    # Get all active todos for this room
    filters = TodoFilters(
        room_id=message.room_id,
        is_completed=False,
    )
    available_tasks = await data_service.get_todos(filters)

    if len(available_tasks) == 0:
        error_msg = "You don't have any active tasks to cancel. Would you like to create a new task?"
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["CANCEL_TODO_NO_TASKS"],
                    "source": message.content.source if message.content else None,
                }
            )
        return CancelTodoResult(success=False, text=error_msg)

    # Extract which task to cancel
    task_id = None
    if options and options.parameters and "task_id" in options.parameters:
        task_id = UUID(str(options.parameters["task_id"]))

    if not task_id:
        # Use first task as default
        task = available_tasks[0]
    else:
        task = next((t for t in available_tasks if t.id == task_id), None)
        if not task:
            error_msg = (
                "I couldn't determine which task you want to cancel. Could you be more specific? "
                "Here are your current tasks:\n\n"
                + "\n".join(f"- {t.name}" for t in available_tasks)
            )
            if callback:
                await callback(
                    {
                        "text": error_msg,
                        "actions": ["CANCEL_TODO_NOT_FOUND"],
                        "source": message.content.source if message.content else None,
                    }
                )
            return CancelTodoResult(
                success=False, text=error_msg, error="Could not determine which task to cancel"
            )

    # Delete the task
    await data_service.delete_todo(task.id)
    task_name = task.name or "task"

    if callback:
        await callback(
            {
                "text": f'✓ Task cancelled: "{task_name}" has been removed from your todo list.',
                "actions": ["CANCEL_TODO_SUCCESS"],
                "source": message.content.source if message.content else None,
            }
        )

    return CancelTodoResult(success=True, text=f"Task cancelled: {task_name}", todo_id=task.id)


async def validate_cancel_todo(
    runtime: IAgentRuntime, message: Memory, state: State | None = None
) -> bool:
    """Validate if cancel todo action can be executed.

    Args:
        runtime: The agent runtime.
        message: The message.
        state: Optional state.

    Returns:
        True if there are active todos to cancel.
    """
    if not message.room_id:
        return False

    data_service = create_todo_data_service(runtime.db if hasattr(runtime, "db") else None)
    filters = TodoFilters(
        room_id=message.room_id,
        is_completed=False,
    )
    todos = await data_service.get_todos(filters)
    return len(todos) > 0


# Action definition for elizaOS integration
CANCEL_TODO_ACTION = {
    "name": "CANCEL_TODO",
    "similes": ["DELETE_TODO", "REMOVE_TASK", "DELETE_TASK", "REMOVE_TODO"],
    "description": "Cancels and deletes a todo item from the user's task list immediately.",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Cancel my task to finish taxes"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": '✓ Task cancelled: "Finish taxes" has been removed from your todo list.',
                    "actions": ["CANCEL_TODO_SUCCESS"],
                },
            },
        ],
        [
            {
                "name": "{{name1}}",
                "content": {"text": "I don't want to do 50 pushups anymore, please delete that task"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": '✓ Task cancelled: "Do 50 pushups" has been removed from your todo list.',
                    "actions": ["CANCEL_TODO_SUCCESS"],
                },
            },
        ],
    ],
}
