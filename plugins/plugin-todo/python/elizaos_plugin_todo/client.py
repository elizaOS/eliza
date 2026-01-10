"""
High-level client for the Todo Plugin.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from elizaos_plugin_todo.types import (
    CreateTodoParams,
    Priority,
    TaskType,
    Todo,
    TodoFilters,
    TodoMetadata,
    UpdateTodoParams,
)
from elizaos_plugin_todo.config import TodoConfig
from elizaos_plugin_todo.data_service import TodoDataService, create_todo_data_service
from elizaos_plugin_todo.reminder_service import ReminderService
from elizaos_plugin_todo.notification_manager import NotificationManager
from elizaos_plugin_todo.cache_manager import CacheManager
from elizaos_plugin_todo.errors import ValidationError


class TodoClient:
    """
    High-level client for todo operations.

    This client provides a simple interface for managing todos,
    including creation, updates, completion, and querying.

    Example:
        >>> config = TodoConfig.from_env()
        >>> async with TodoClient(config) as client:
        ...     todo = await client.create_todo(
        ...         name="Finish report",
        ...         task_type=TaskType.ONE_OFF,
        ...         priority=Priority.HIGH,
        ...     )
        ...     print(f"Created: {todo.name}")
    """

    def __init__(self, config: Optional[TodoConfig] = None) -> None:
        """
        Initialize the todo client.

        Args:
            config: Optional configuration
        """
        self._config = config or TodoConfig.from_env()
        self._data_service: Optional[TodoDataService] = None
        self._reminder_service: Optional[ReminderService] = None
        self._notification_manager: Optional[NotificationManager] = None
        self._cache_manager: Optional[CacheManager] = None
        self._started = False

    async def __aenter__(self) -> "TodoClient":
        """Async context manager entry."""
        await self.start()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """Async context manager exit."""
        await self.stop()

    async def start(self) -> None:
        """Start the client and all services."""
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
        """Stop the client and all services."""
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
        """Ensure the client is started."""
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
        description: Optional[str] = None,
        priority: Optional[Priority] = None,
        is_urgent: bool = False,
        due_date: Optional[datetime] = None,
        tags: Optional[list[str]] = None,
    ) -> Todo:
        """
        Create a new todo.

        Args:
            name: Todo name
            task_type: Type of task
            agent_id: Agent UUID
            world_id: World UUID
            room_id: Room UUID
            entity_id: Entity UUID
            description: Optional description
            priority: Optional priority (default: MEDIUM for one-off)
            is_urgent: Whether the task is urgent
            due_date: Optional due date
            tags: Optional tags

        Returns:
            Created Todo object

        Raises:
            ValidationError: If parameters are invalid
        """
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

    async def get_todo(self, todo_id: UUID) -> Optional[Todo]:
        """
        Get a todo by ID.

        Args:
            todo_id: The todo's UUID

        Returns:
            The todo if found, None otherwise
        """
        self._ensure_started()
        assert self._data_service is not None
        return await self._data_service.get_todo(todo_id)

    async def get_todos(
        self,
        agent_id: Optional[UUID] = None,
        room_id: Optional[UUID] = None,
        entity_id: Optional[UUID] = None,
        task_type: Optional[TaskType] = None,
        is_completed: Optional[bool] = None,
        tags: Optional[list[str]] = None,
        limit: Optional[int] = None,
    ) -> list[Todo]:
        """
        Get todos with optional filters.

        Args:
            agent_id: Filter by agent
            room_id: Filter by room
            entity_id: Filter by entity
            task_type: Filter by task type
            is_completed: Filter by completion status
            tags: Filter by tags
            limit: Maximum number to return

        Returns:
            List of matching todos
        """
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
        """
        Mark a todo as completed.

        Args:
            todo_id: The todo's UUID

        Returns:
            Updated Todo object
        """
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
        """
        Mark a todo as not completed.

        Args:
            todo_id: The todo's UUID

        Returns:
            Updated Todo object
        """
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
        name: Optional[str] = None,
        description: Optional[str] = None,
        priority: Optional[Priority] = None,
        is_urgent: Optional[bool] = None,
        due_date: Optional[datetime] = None,
    ) -> Todo:
        """
        Update a todo.

        Args:
            todo_id: The todo's UUID
            name: New name
            description: New description
            priority: New priority
            is_urgent: New urgency
            due_date: New due date

        Returns:
            Updated Todo object
        """
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
        """
        Delete a todo.

        Args:
            todo_id: The todo's UUID

        Returns:
            True if deletion succeeded
        """
        self._ensure_started()
        assert self._data_service is not None
        return await self._data_service.delete_todo(todo_id)

    async def get_overdue_todos(
        self,
        agent_id: Optional[UUID] = None,
        room_id: Optional[UUID] = None,
    ) -> list[Todo]:
        """
        Get overdue todos.

        Args:
            agent_id: Filter by agent
            room_id: Filter by room

        Returns:
            List of overdue todos
        """
        self._ensure_started()
        assert self._data_service is not None

        filters = TodoFilters(agent_id=agent_id, room_id=room_id)
        return await self._data_service.get_overdue_todos(filters)

    async def reset_daily_todos(
        self,
        agent_id: Optional[UUID] = None,
        room_id: Optional[UUID] = None,
    ) -> int:
        """
        Reset daily todos for a new day.

        Args:
            agent_id: Filter by agent
            room_id: Filter by room

        Returns:
            Number of todos reset
        """
        self._ensure_started()
        assert self._data_service is not None

        filters = TodoFilters(agent_id=agent_id, room_id=room_id)
        return await self._data_service.reset_daily_todos(filters)

    async def add_tags(self, todo_id: UUID, tags: list[str]) -> bool:
        """
        Add tags to a todo.

        Args:
            todo_id: The todo's UUID
            tags: Tags to add

        Returns:
            True if operation succeeded
        """
        self._ensure_started()
        assert self._data_service is not None
        return await self._data_service.add_tags(todo_id, tags)

    async def remove_tags(self, todo_id: UUID, tags: list[str]) -> bool:
        """
        Remove tags from a todo.

        Args:
            todo_id: The todo's UUID
            tags: Tags to remove

        Returns:
            True if operation succeeded
        """
        self._ensure_started()
        assert self._data_service is not None
        return await self._data_service.remove_tags(todo_id, tags)

