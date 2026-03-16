from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

from elizaos_plugin_todo.data_service import create_todo_data_service
from elizaos_plugin_todo.types import TaskType, TodoFilters

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)


async def get_todos(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    try:
        logger.debug(
            "[TodosProvider] Received state: %s",
            state.data.get("room") if state and state.data else "No room data in state",
        )
        logger.debug("[TodosProvider] Received message: %s", message)

        current_date = datetime.utcnow()
        seven_days_ago = current_date - timedelta(days=7)

        room_id = message.room_id
        if not room_id:
            logger.error("TodosProvider - message missing roomId")
            return ProviderResult(
                text="No room context available",
                values={},
                data={},
            )

        logger.debug("TodosProvider - message: %s", message)

        room_details = None
        if hasattr(runtime, "get_room"):
            room_details = await runtime.get_room(room_id)

        (
            room_details.world_id
            if room_details and hasattr(room_details, "world_id")
            else message.world_id or message.entity_id
        )
        logger.debug("TodosProvider - roomDetails: %s", room_details)

        # Prefer the runtime (task-backed persistence) when available, otherwise fall back to
        # a pre-injected in-memory TodoDataService on `runtime.db` (used by tests/mocks).
        runtime_or_db = (
            runtime
            if hasattr(runtime, "create_task") and hasattr(runtime, "get_tasks")
            else (runtime.db if hasattr(runtime, "db") else None)
        )
        data_service = create_todo_data_service(runtime_or_db)

        filters = TodoFilters(entity_id=message.entity_id)
        all_entity_todos = await data_service.get_todos(filters)

        logger.debug("TodosProvider - allEntityTodos: %s", all_entity_todos)

        pending_todos = [todo for todo in all_entity_todos if not todo.is_completed]

        completed_todos = [
            todo
            for todo in all_entity_todos
            if todo.is_completed
            and (
                (todo.completed_at and todo.completed_at >= seven_days_ago)
                or (todo.updated_at and todo.updated_at >= seven_days_ago)
            )
        ]

        daily_todos = [todo for todo in pending_todos if todo.type == TaskType.DAILY]
        formatted_daily_tasks = "\n".join(
            [
                f"- {todo.name} (daily, streak: {todo.metadata.streak or 0} day{'s' if (todo.metadata.streak or 0) != 1 else ''})"
                for todo in daily_todos
            ]
        )

        one_off_todos = [todo for todo in pending_todos if todo.type == TaskType.ONE_OFF]
        formatted_one_off_tasks = "\n".join(
            [
                f"- {todo.name} (P{todo.priority.value if todo.priority else 4}{' 🔴 URGENT' if todo.is_urgent else ''}, {'due ' + todo.due_date.strftime('%m/%d/%Y') if todo.due_date else 'no due date'})"
                for todo in one_off_todos
            ]
        )

        aspirational_todos = [todo for todo in pending_todos if todo.type == TaskType.ASPIRATIONAL]
        formatted_aspirational_tasks = "\n".join(
            [f"- {todo.name} (aspirational goal)" for todo in aspirational_todos]
        )

        formatted_completed_tasks = "\n".join(
            [
                f"- {todo.name} (completed {todo.completed_at.strftime('%m/%d/%Y') if todo.completed_at else 'recently'}, +{todo.metadata.points_awarded or 0} points)"
                for todo in completed_todos
            ]
        )

        # Build the provider output
        output = "# User's Todos (Tasks)\n\n"
        output += "These are the tasks which the agent is managing for the user. "
        output += "This is the actual list of todos, any other is probably from previous conversations.\n\n"

        # Daily tasks
        output += "\n## Daily Todos\n"
        output += formatted_daily_tasks or "No daily todos."

        output += "\n\n## One-off Todos\n"
        output += formatted_one_off_tasks or "No one-off todos."

        output += "\n\n## Aspirational Todos\n"
        output += formatted_aspirational_tasks or "No aspirational todos."

        output += "\n\n## Recently Completed (Last 7 Days)\n"
        output += formatted_completed_tasks or "No todos completed in the last 7 days."

        output += (
            "\n\nIMPORTANT: Do not tell the user that a task exists or has been added "
            "if it is not in the list above. As an AI, you may hallucinate, so it is important "
            "to ground your answer in the information above which we know to be true from the database.\n\n"
        )

        result = ProviderResult(
            data={
                "dailyTodos": [
                    {
                        "id": str(todo.id),
                        "name": todo.name,
                        "description": todo.description or None,
                        "type": todo.type.value,
                        "priority": todo.priority.value if todo.priority else None,
                        "isUrgent": todo.is_urgent,
                        "isCompleted": todo.is_completed,
                        "dueDate": todo.due_date.isoformat() if todo.due_date else None,
                        "completedAt": todo.completed_at.isoformat() if todo.completed_at else None,
                        "createdAt": todo.created_at.isoformat(),
                        "updatedAt": todo.updated_at.isoformat(),
                        "tags": todo.tags or [],
                    }
                    for todo in daily_todos
                ],
                "oneOffTodos": [
                    {
                        "id": str(todo.id),
                        "name": todo.name,
                        "description": todo.description or None,
                        "type": todo.type.value,
                        "priority": todo.priority.value if todo.priority else None,
                        "isUrgent": todo.is_urgent,
                        "isCompleted": todo.is_completed,
                        "dueDate": todo.due_date.isoformat() if todo.due_date else None,
                        "completedAt": todo.completed_at.isoformat() if todo.completed_at else None,
                        "createdAt": todo.created_at.isoformat(),
                        "updatedAt": todo.updated_at.isoformat(),
                        "tags": todo.tags or [],
                    }
                    for todo in one_off_todos
                ],
                "aspirationalTodos": [
                    {
                        "id": str(todo.id),
                        "name": todo.name,
                        "description": todo.description or None,
                        "type": todo.type.value,
                        "priority": todo.priority.value if todo.priority else None,
                        "isUrgent": todo.is_urgent,
                        "isCompleted": todo.is_completed,
                        "dueDate": todo.due_date.isoformat() if todo.due_date else None,
                        "completedAt": todo.completed_at.isoformat() if todo.completed_at else None,
                        "createdAt": todo.created_at.isoformat(),
                        "updatedAt": todo.updated_at.isoformat(),
                        "tags": todo.tags or [],
                    }
                    for todo in aspirational_todos
                ],
                "completedTodos": [
                    {
                        "id": str(todo.id),
                        "name": todo.name,
                        "description": todo.description or None,
                        "type": todo.type.value,
                        "priority": todo.priority.value if todo.priority else None,
                        "isUrgent": todo.is_urgent,
                        "isCompleted": todo.is_completed,
                        "dueDate": todo.due_date.isoformat() if todo.due_date else None,
                        "completedAt": todo.completed_at.isoformat() if todo.completed_at else None,
                        "createdAt": todo.created_at.isoformat(),
                        "updatedAt": todo.updated_at.isoformat(),
                        "tags": todo.tags or [],
                    }
                    for todo in completed_todos
                ],
            },
            values={
                "dailyTasks": formatted_daily_tasks or "None",
                "oneOffTasks": formatted_one_off_tasks or "None",
                "aspirationalTasks": formatted_aspirational_tasks or "None",
                "completedTasks": formatted_completed_tasks or "None",
            },
            text=output,
        )

        logger.debug("TodosProvider - result: %s", result)

        return result

    except Exception as e:
        logger.error("Error in TodosProvider: %s", str(e), exc_info=True)

        return ProviderResult(
            data={},
            values={},
            text="Sorry, there was an error retrieving your tasks.",
        )


TODOS_PROVIDER = Provider(
    name="TODOS",
    description="Information about the user's current tasks, completed tasks, and points",
    get=get_todos,
    dynamic=True,
)
