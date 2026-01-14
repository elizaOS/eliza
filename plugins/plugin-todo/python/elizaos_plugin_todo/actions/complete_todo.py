from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
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
class CompleteTodoResult:
    success: bool
    text: str
    todo_id: UUID | None = None
    error: str | None = None


async def handle_complete_todo(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> CompleteTodoResult | None:
    if not state:
        error_msg = "Unable to process request without state context."
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["COMPLETE_TODO_ERROR"],
                    "source": message.content.source if message.content else None,
                }
            )
        return CompleteTodoResult(success=False, text=error_msg, error=error_msg)

    if not message.room_id or not message.entity_id:
        error_msg = "I cannot complete a todo without a room and entity context."
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["COMPLETE_TODO_ERROR"],
                    "source": message.content.source if message.content else None,
                }
            )
        return CompleteTodoResult(success=False, text=error_msg, error=error_msg)

    # Prefer the runtime (task-backed persistence) when available, otherwise fall back to
    # a pre-injected in-memory TodoDataService on `runtime.db` (used by tests/mocks).
    runtime_or_db = (
        runtime
        if hasattr(runtime, "create_task") and hasattr(runtime, "get_tasks")
        else (runtime.db if hasattr(runtime, "db") else None)
    )
    data_service = create_todo_data_service(runtime_or_db)

    filters = TodoFilters(
        room_id=message.room_id,
        is_completed=False,
    )
    available_todos = await data_service.get_todos(filters)

    if len(available_todos) == 0:
        error_msg = "You don't have any incomplete tasks to mark as done. Would you like to create a new task?"
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["COMPLETE_TODO_NO_TASKS"],
                    "source": message.content.source if message.content else None,
                }
            )
        return CompleteTodoResult(success=False, text=error_msg)

    task_id = None
    if options and options.parameters and "task_id" in options.parameters:
        task_id = UUID(str(options.parameters["task_id"]))

    if not task_id:
        task = available_todos[0]
    else:
        task = next((t for t in available_todos if t.id == task_id), None)
        if not task:
            error_msg = (
                "I couldn't find a task matching the provided ID. Here are your current tasks:\n\n"
                + "\n".join(f"- {t.name}" for t in available_todos)
            )
            if callback:
                await callback(
                    {
                        "text": error_msg,
                        "actions": ["COMPLETE_TODO_NOT_FOUND"],
                        "source": message.content.source if message.content else None,
                    }
                )
            return CompleteTodoResult(success=False, text=error_msg, error="Task not found")

    update_params = UpdateTodoParams(
        is_completed=True,
        completed_at=datetime.utcnow(),
        metadata=task.metadata,
    )
    await data_service.update_todo(task.id, update_params)

    if task.type.value == "daily":
        response_text = f'✅ Daily task completed: "{task.name}"'
    elif task.type.value == "one-off":
        completed_on_time = True if not task.due_date else datetime.utcnow() <= task.due_date
        time_status = "on time" if completed_on_time else "late"
        priority = task.priority.value if task.priority else 4
        response_text = f'✅ Task completed: "{task.name}" (Priority {priority}, {time_status})'
    elif task.type.value == "aspirational":
        response_text = f'🌟 Congratulations on achieving your aspirational goal: "{task.name}"!\n\nThis is a significant accomplishment.'
    else:
        response_text = f'✅ Marked "{task.name}" as completed.'

    if callback:
        await callback(
            {
                "text": response_text,
                "actions": ["COMPLETE_TODO"],
                "source": message.content.source if message.content else None,
            }
        )

    return CompleteTodoResult(success=True, text=response_text, todo_id=task.id)


async def validate_complete_todo(
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


COMPLETE_TODO_ACTION = {
    "name": "COMPLETE_TODO",
    "similes": ["MARK_COMPLETE", "FINISH_TASK", "DONE", "TASK_DONE", "TASK_COMPLETED"],
    "description": "Marks a todo item as completed.",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "I completed my taxes"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": '✅ Task completed: "Finish taxes" (Priority 2, on time)',
                    "actions": ["COMPLETE_TODO"],
                },
            },
        ],
        [
            {
                "name": "{{name1}}",
                "content": {"text": "I did my 50 pushups today"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": '✅ Daily task completed: "Do 50 pushups"',
                    "actions": ["COMPLETE_TODO"],
                },
            },
        ],
    ],
}
