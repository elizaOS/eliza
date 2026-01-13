from datetime import datetime
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


def create_todo_data_service(db_connection: object | None = None) -> TodoDataService:
    # If db_connection is already a TodoDataService, return it directly
    if isinstance(db_connection, TodoDataService):
        return db_connection
    return TodoDataService(db_connection)
