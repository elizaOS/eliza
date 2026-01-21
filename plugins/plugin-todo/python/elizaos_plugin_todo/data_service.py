from __future__ import annotations

from datetime import datetime
from typing import Protocol, cast
from uuid import UUID, uuid4

from elizaos_plugin_todo.errors import NotFoundError, ValidationError
from elizaos_plugin_todo.types import (
    CreateTodoParams,
    Priority,
    TaskType,
    Todo,
    TodoFilters,
    TodoMetadata,
    UpdateTodoParams,
)


class TaskRuntime(Protocol):
    async def create_task(self, task: dict[str, object]) -> UUID: ...

    async def get_tasks(self, params: dict[str, object]) -> list[object]: ...

    async def get_task(self, id: UUID) -> object | None: ...

    async def update_task(self, id: UUID, task: dict[str, object]) -> None: ...

    async def delete_task(self, id: UUID) -> None: ...


class TodoDataService:
    def __init__(self, db_connection: object | None = None) -> None:
        self._db = db_connection
        self._todos: dict[UUID, Todo] = {}
        self._tags: dict[UUID, list[str]] = {}

    async def create_todo(self, params: CreateTodoParams) -> UUID:
        if not params.name or not params.name.strip():
            raise ValidationError("Todo name is required")

        if params.type == TaskType.ONE_OFF and params.priority is None:
            params.priority = Priority.MEDIUM

        now = datetime.utcnow()
        todo_id = uuid4()

        metadata = params.metadata or TodoMetadata()
        metadata.created_at = now.isoformat()

        todo = Todo(
            id=todo_id,
            agent_id=params.agent_id,
            world_id=params.world_id,
            room_id=params.room_id,
            entity_id=params.entity_id,
            name=params.name.strip(),
            description=params.description,
            type=params.type,
            priority=params.priority,
            is_urgent=params.is_urgent,
            is_completed=False,
            due_date=params.due_date,
            completed_at=None,
            created_at=now,
            updated_at=now,
            metadata=metadata,
            tags=params.tags or [],
        )

        self._todos[todo_id] = todo
        self._tags[todo_id] = params.tags or []

        return todo_id

    async def get_todo(self, todo_id: UUID) -> Todo | None:
        todo = self._todos.get(todo_id)
        if todo:
            todo.tags = self._tags.get(todo_id, [])
        return todo

    async def get_todos(self, filters: TodoFilters | dict | None = None) -> list[Todo]:
        todos = list(self._todos.values())

        # Convert dict to TodoFilters if necessary
        if isinstance(filters, dict):
            filters = TodoFilters(**filters)

        if filters:
            if filters.agent_id:
                todos = [t for t in todos if t.agent_id == filters.agent_id]
            if filters.world_id:
                todos = [t for t in todos if t.world_id == filters.world_id]
            if filters.room_id:
                todos = [t for t in todos if t.room_id == filters.room_id]
            if filters.entity_id:
                todos = [t for t in todos if t.entity_id == filters.entity_id]
            if filters.type:
                todos = [t for t in todos if t.type == filters.type]
            if filters.is_completed is not None:
                todos = [t for t in todos if t.is_completed == filters.is_completed]
            if filters.tags:
                todos = [
                    t for t in todos if any(tag in self._tags.get(t.id, []) for tag in filters.tags)
                ]
            if filters.limit:
                todos = todos[: filters.limit]

        # Attach tags to each todo
        for todo in todos:
            todo.tags = self._tags.get(todo.id, [])

        todos.sort(key=lambda t: t.created_at, reverse=True)

        return todos

    async def update_todo(self, todo_id: UUID, updates: UpdateTodoParams) -> bool:
        todo = self._todos.get(todo_id)
        if not todo:
            raise NotFoundError(f"Todo {todo_id} not found")

        if updates.name is not None:
            todo.name = updates.name
        if updates.description is not None:
            todo.description = updates.description
        if updates.priority is not None:
            todo.priority = updates.priority
        if updates.is_urgent is not None:
            todo.is_urgent = updates.is_urgent
        if updates.is_completed is not None:
            todo.is_completed = updates.is_completed
        if updates.due_date is not None:
            todo.due_date = updates.due_date
        if updates.completed_at is not None:
            todo.completed_at = updates.completed_at
        if updates.metadata is not None:
            todo.metadata = updates.metadata

        todo.updated_at = datetime.utcnow()
        self._todos[todo_id] = todo

        return True

    async def delete_todo(self, todo_id: UUID) -> bool:
        if todo_id not in self._todos:
            raise NotFoundError(f"Todo {todo_id} not found")

        del self._todos[todo_id]
        self._tags.pop(todo_id, None)

        return True

    async def add_tags(self, todo_id: UUID, tags: list[str]) -> bool:
        if todo_id not in self._todos:
            raise NotFoundError(f"Todo {todo_id} not found")

        existing = set(self._tags.get(todo_id, []))
        existing.update(tags)
        self._tags[todo_id] = list(existing)

        return True

    async def remove_tags(self, todo_id: UUID, tags: list[str]) -> bool:
        if todo_id not in self._todos:
            raise NotFoundError(f"Todo {todo_id} not found")

        existing = self._tags.get(todo_id, [])
        self._tags[todo_id] = [t for t in existing if t not in tags]

        return True

    async def get_overdue_todos(self, filters: TodoFilters | None = None) -> list[Todo]:
        now = datetime.utcnow()
        todos = await self.get_todos(filters)

        overdue = [
            t for t in todos if not t.is_completed and t.due_date is not None and t.due_date < now
        ]

        return overdue

    async def reset_daily_todos(self, filters: TodoFilters | None = None) -> int:
        base_filters = TodoFilters(
            type=TaskType.DAILY,
            is_completed=True,
        )
        if filters:
            if filters.agent_id:
                base_filters.agent_id = filters.agent_id
            if filters.world_id:
                base_filters.world_id = filters.world_id
            if filters.room_id:
                base_filters.room_id = filters.room_id
            if filters.entity_id:
                base_filters.entity_id = filters.entity_id

        todos = await self.get_todos(base_filters)
        count = 0

        for todo in todos:
            todo.is_completed = False
            todo.completed_at = None
            todo.metadata.completed_today = False
            todo.updated_at = datetime.utcnow()
            self._todos[todo.id] = todo
            count += 1

        return count


class RuntimeTodoDataService(TodoDataService):
    """
    Task-backed TodoDataService.

    If `plugin-sql` is installed (or any adapter that implements tasks), this uses the runtime's
    task CRUD APIs to persist todos.
    """

    def __init__(self, runtime: TaskRuntime) -> None:
        super().__init__(db_connection=None)
        self._runtime = runtime

    @staticmethod
    def _task_to_todo(task: object) -> Todo | None:
        if not isinstance(task, dict):
            return None

        raw_id = task.get("id")
        if not isinstance(raw_id, str):
            return None

        try:
            todo_id = UUID(raw_id)
        except ValueError:
            return None

        name = task.get("name")
        if not isinstance(name, str):
            return None

        metadata_obj = task.get("metadata")
        metadata_dict: dict[str, object] = metadata_obj if isinstance(metadata_obj, dict) else {}

        agent_id = metadata_dict.get("agentId")
        if not isinstance(agent_id, str):
            return None

        entity_id = task.get("entityId")
        room_id = task.get("roomId")
        world_id = task.get("worldId")

        if not isinstance(entity_id, str):
            return None

        todo_type_raw = metadata_dict.get("todoType")
        todo_type = TaskType(todo_type_raw) if isinstance(todo_type_raw, str) else TaskType.ONE_OFF

        priority_raw = metadata_dict.get("priority")
        priority: Priority | None = None
        if isinstance(priority_raw, str):
            try:
                priority = Priority(priority_raw)
            except ValueError:
                priority = None

        is_completed = bool(task.get("status") == "completed")

        created_at_ms = task.get("createdAt")
        updated_at_ms = task.get("updatedAt")
        created_at = (
            datetime.utcfromtimestamp(created_at_ms / 1000)
            if isinstance(created_at_ms, int)
            else datetime.utcnow()
        )
        updated_at = (
            datetime.utcfromtimestamp(updated_at_ms / 1000)
            if isinstance(updated_at_ms, int)
            else datetime.utcnow()
        )

        todo_metadata = TodoMetadata()
        # Persist extra metadata in the existing TodoMetadata container when possible.
        todo_metadata.streak = (
            int(metadata_dict.get("streak", 0))
            if isinstance(metadata_dict.get("streak"), int)
            else 0
        )
        todo_metadata.points_awarded = (
            int(metadata_dict.get("pointsAwarded", 0))
            if isinstance(metadata_dict.get("pointsAwarded"), int)
            else 0
        )

        tags_obj = task.get("tags")
        tags = [t for t in tags_obj if isinstance(t, str)] if isinstance(tags_obj, list) else []

        return Todo(
            id=todo_id,
            agent_id=agent_id,
            world_id=world_id if isinstance(world_id, str) else None,
            room_id=room_id if isinstance(room_id, str) else None,
            entity_id=entity_id,
            name=name,
            description=task.get("description")
            if isinstance(task.get("description"), str)
            else None,
            type=todo_type,
            priority=priority,
            is_urgent=bool(metadata_dict.get("isUrgent", False)),
            is_completed=is_completed,
            due_date=None,
            completed_at=None,
            created_at=created_at,
            updated_at=updated_at,
            metadata=todo_metadata,
            tags=tags,
        )

    async def create_todo(self, params: CreateTodoParams) -> UUID:
        if not params.name or not params.name.strip():
            raise ValidationError("Todo name is required")

        now = datetime.utcnow()
        metadata = params.metadata or TodoMetadata()
        metadata.created_at = now.isoformat()

        task: dict[str, object] = {
            "name": params.name.strip(),
            "description": params.description,
            "roomId": params.room_id,
            "entityId": params.entity_id,
            "worldId": params.world_id,
            "status": "pending",
            "tags": list({"TODO", *(params.tags or [])}),
            "metadata": {
                "agentId": params.agent_id,
                "todoType": params.type.value,
                "priority": params.priority.value if params.priority else None,
                "isUrgent": params.is_urgent,
                "streak": metadata.streak,
                "pointsAwarded": metadata.points_awarded,
            },
        }
        return await self._runtime.create_task(task)

    async def get_todo(self, todo_id: UUID) -> Todo | None:
        task = await self._runtime.get_task(todo_id)
        return self._task_to_todo(task)

    async def get_todos(self, filters: TodoFilters | dict | None = None) -> list[Todo]:
        if isinstance(filters, dict):
            filters = TodoFilters(**filters)

        params: dict[str, object] = {"tags": ["TODO"]}
        if filters:
            if filters.room_id:
                params["roomId"] = filters.room_id
            if filters.entity_id:
                params["entityId"] = filters.entity_id
            # Note: plugin-sql adapter doesn't filter by worldId today; we keep it in metadata.
            if filters.tags:
                params["tags"] = list({"TODO", *filters.tags})

        tasks = await self._runtime.get_tasks(params)
        todos: list[Todo] = []
        for t in tasks:
            todo = self._task_to_todo(t)
            if not todo:
                continue
            if (
                filters
                and filters.is_completed is not None
                and todo.is_completed != filters.is_completed
            ):
                continue
            if filters and filters.type and todo.type != filters.type:
                continue
            todos.append(todo)

        todos.sort(key=lambda t: t.created_at, reverse=True)
        if filters and filters.limit:
            return todos[: filters.limit]
        return todos

    async def update_todo(self, todo_id: UUID, updates: UpdateTodoParams) -> bool:
        existing = await self.get_todo(todo_id)
        if not existing:
            raise NotFoundError(f"Todo {todo_id} not found")

        new_tags = (
            list(set(existing.tags) | set(updates.tags or []))
            if updates.tags is not None
            else existing.tags
        )

        new_status: str | None
        if updates.is_completed is None:
            new_status = None
        else:
            new_status = "completed" if updates.is_completed is True else "pending"

        new_metadata: dict[str, object] = {
            "agentId": existing.agent_id,
            "todoType": existing.type.value,
            "priority": updates.priority.value
            if updates.priority
            else (existing.priority.value if existing.priority else None),
            "isUrgent": updates.is_urgent if updates.is_urgent is not None else existing.is_urgent,
            "streak": existing.metadata.streak,
            "pointsAwarded": existing.metadata.points_awarded,
        }
        if updates.metadata is not None:
            # Best-effort merge for extra metadata fields.
            for k, v in updates.metadata.model_dump().items():
                if v is not None:
                    new_metadata[k] = v

        patch: dict[str, object] = {
            "name": updates.name if updates.name is not None else existing.name,
            "description": updates.description
            if updates.description is not None
            else existing.description,
            "tags": new_tags,
            "metadata": new_metadata,
        }
        if new_status is not None:
            patch["status"] = new_status
        await self._runtime.update_task(todo_id, patch)
        return True

    async def delete_todo(self, todo_id: UUID) -> bool:
        existing = await self.get_todo(todo_id)
        if not existing:
            raise NotFoundError(f"Todo {todo_id} not found")
        await self._runtime.delete_task(todo_id)
        return True


def create_todo_data_service(db_connection: object | None = None) -> TodoDataService:
    """
    Backwards-compatible factory.

    - If passed a runtime (preferred), and it supports task APIs, returns a task-backed service.
    - Otherwise returns the legacy in-memory service.
    """
    if isinstance(db_connection, TodoDataService):
        return db_connection

    runtime_like = db_connection
    if (
        runtime_like is not None
        and hasattr(runtime_like, "create_task")
        and hasattr(runtime_like, "get_tasks")
    ):
        return RuntimeTodoDataService(cast(TaskRuntime, runtime_like))

    return TodoDataService(db_connection)
