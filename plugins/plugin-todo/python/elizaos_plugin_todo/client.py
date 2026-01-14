from datetime import datetime
from types import TracebackType
from uuid import UUID

from elizaos_plugin_todo.cache_manager import CacheManager
from elizaos_plugin_todo.config import TodoConfig
from elizaos_plugin_todo.data_service import TodoDataService, create_todo_data_service
from elizaos_plugin_todo.errors import ValidationError
from elizaos_plugin_todo.notification_manager import NotificationManager
from elizaos_plugin_todo.reminder_service import ReminderService
from elizaos_plugin_todo.types import (
    CreateTodoParams,
    Priority,
    TaskType,
    Todo,
    TodoFilters,
    TodoMetadata,
    UpdateTodoParams,
)


class TodoClient:
    def __init__(self, config: TodoConfig | None = None) -> None:
        self._config = config or TodoConfig.from_env()
        self._data_service: TodoDataService | None = None
        self._reminder_service: ReminderService | None = None
        self._notification_manager: NotificationManager | None = None
        self._cache_manager: CacheManager | None = None
        self._started = False

    async def __aenter__(self) -> "TodoClient":
        await self.start()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.stop()

    async def start(self) -> None:
        if self._started:
            return

        self._config.validate()

        self._data_service = create_todo_data_service()

        self._cache_manager = CacheManager(
            max_size=self._config.cache_max_size,
            default_ttl_ms=self._config.cache_default_ttl_ms,
        )
        await self._cache_manager.start()

        self._notification_manager = NotificationManager()
        await self._notification_manager.start()

        if self._config.enable_reminders:
            self._reminder_service = ReminderService(self._config)
            await self._reminder_service.start()

        self._started = True

    async def stop(self) -> None:
        if not self._started:
            return

        if self._reminder_service:
            await self._reminder_service.stop()

        if self._notification_manager:
            await self._notification_manager.stop()

        if self._cache_manager:
            await self._cache_manager.stop()

        self._started = False

    def _ensure_started(self) -> None:
        if not self._started or not self._data_service:
            raise RuntimeError("TodoClient not started. Use 'async with' or call start()")

    async def create_todo(
        self,
        name: str,
        task_type: TaskType,
        agent_id: UUID,
        world_id: UUID,
        room_id: UUID,
        entity_id: UUID,
        description: str | None = None,
        priority: Priority | None = None,
        is_urgent: bool = False,
        due_date: datetime | None = None,
        tags: list[str] | None = None,
    ) -> Todo:
        self._ensure_started()

        if not name or not name.strip():
            raise ValidationError("Todo name is required")

        # Build tags
        final_tags = tags or []
        final_tags.append("TODO")

        if task_type == TaskType.DAILY:
            final_tags.append("daily")
            final_tags.append("recurring-daily")
        elif task_type == TaskType.ONE_OFF:
            final_tags.append("one-off")
            if priority:
                final_tags.append(f"priority-{priority.value}")
            if is_urgent:
                final_tags.append("urgent")
        elif task_type == TaskType.ASPIRATIONAL:
            final_tags.append("aspirational")

        params = CreateTodoParams(
            agent_id=agent_id,
            world_id=world_id,
            room_id=room_id,
            entity_id=entity_id,
            name=name.strip(),
            description=description,
            type=task_type,
            priority=priority or (Priority.MEDIUM if task_type == TaskType.ONE_OFF else None),
            is_urgent=is_urgent,
            due_date=due_date,
            tags=final_tags,
        )

        assert self._data_service is not None
        todo_id = await self._data_service.create_todo(params)
        todo = await self._data_service.get_todo(todo_id)

        if not todo:
            raise RuntimeError("Failed to retrieve created todo")

        return todo

    async def get_todo(self, todo_id: UUID) -> Todo | None:
        self._ensure_started()
        assert self._data_service is not None
        return await self._data_service.get_todo(todo_id)

    async def get_todos(
        self,
        agent_id: UUID | None = None,
        room_id: UUID | None = None,
        entity_id: UUID | None = None,
        task_type: TaskType | None = None,
        is_completed: bool | None = None,
        tags: list[str] | None = None,
        limit: int | None = None,
    ) -> list[Todo]:
        self._ensure_started()
        assert self._data_service is not None

        filters = TodoFilters(
            agent_id=agent_id,
            room_id=room_id,
            entity_id=entity_id,
            type=task_type,
            is_completed=is_completed,
            tags=tags,
            limit=limit,
        )

        return await self._data_service.get_todos(filters)

    async def complete_todo(self, todo_id: UUID) -> Todo:
        self._ensure_started()
        assert self._data_service is not None

        now = datetime.utcnow()
        updates = UpdateTodoParams(
            is_completed=True,
            completed_at=now,
            metadata=TodoMetadata(completed_at=now.isoformat()),
        )

        await self._data_service.update_todo(todo_id, updates)
        todo = await self._data_service.get_todo(todo_id)

        if not todo:
            raise RuntimeError("Failed to retrieve updated todo")

        return todo

    async def uncomplete_todo(self, todo_id: UUID) -> Todo:
        self._ensure_started()
        assert self._data_service is not None

        updates = UpdateTodoParams(
            is_completed=False,
            completed_at=None,
        )

        await self._data_service.update_todo(todo_id, updates)
        todo = await self._data_service.get_todo(todo_id)

        if not todo:
            raise RuntimeError("Failed to retrieve updated todo")

        return todo

    async def update_todo(
        self,
        todo_id: UUID,
        name: str | None = None,
        description: str | None = None,
        priority: Priority | None = None,
        is_urgent: bool | None = None,
        due_date: datetime | None = None,
    ) -> Todo:
        self._ensure_started()
        assert self._data_service is not None

        updates = UpdateTodoParams(
            name=name,
            description=description,
            priority=priority,
            is_urgent=is_urgent,
            due_date=due_date,
        )

        await self._data_service.update_todo(todo_id, updates)
        todo = await self._data_service.get_todo(todo_id)

        if not todo:
            raise RuntimeError("Failed to retrieve updated todo")

        return todo

    async def delete_todo(self, todo_id: UUID) -> bool:
        self._ensure_started()
        assert self._data_service is not None
        return await self._data_service.delete_todo(todo_id)

    async def get_overdue_todos(
        self,
        agent_id: UUID | None = None,
        room_id: UUID | None = None,
    ) -> list[Todo]:
        self._ensure_started()
        assert self._data_service is not None

        filters = TodoFilters(agent_id=agent_id, room_id=room_id)
        return await self._data_service.get_overdue_todos(filters)

    async def reset_daily_todos(
        self,
        agent_id: UUID | None = None,
        room_id: UUID | None = None,
    ) -> int:
        self._ensure_started()
        assert self._data_service is not None

        filters = TodoFilters(agent_id=agent_id, room_id=room_id)
        return await self._data_service.reset_daily_todos(filters)

    async def add_tags(self, todo_id: UUID, tags: list[str]) -> bool:
        self._ensure_started()
        assert self._data_service is not None
        return await self._data_service.add_tags(todo_id, tags)

    async def remove_tags(self, todo_id: UUID, tags: list[str]) -> bool:
        self._ensure_started()
        assert self._data_service is not None
        return await self._data_service.remove_tags(todo_id, tags)
