"""
elizaOS Todo Plugin - Task management with daily recurring and one-off tasks.

This package provides comprehensive task management functionality including:
- Daily recurring tasks with streak tracking
- One-off tasks with due dates and priorities
- Aspirational goals
- Reminder notifications
- Multi-platform integration

Example:
    >>> from elizaos_plugin_todo import TodoClient, TodoConfig
    >>> config = TodoConfig.from_env()
    >>> client = TodoClient(config)
    >>> todo = await client.create_todo(
    ...     name="Finish report",
    ...     task_type=TaskType.ONE_OFF,
    ...     priority=Priority.HIGH,
    ...     due_date=datetime.now() + timedelta(days=1)
    ... )
    >>> print(todo.name)
"""

from elizaos_plugin_todo.cache_manager import CacheManager
from elizaos_plugin_todo.client import TodoClient
from elizaos_plugin_todo.config import TodoConfig
from elizaos_plugin_todo.data_service import TodoDataService
from elizaos_plugin_todo.errors import (
    ConfigError,
    DatabaseError,
    NotFoundError,
    TodoError,
    ValidationError,
)
from elizaos_plugin_todo.notification_manager import NotificationManager
from elizaos_plugin_todo.reminder_service import ReminderService
from elizaos_plugin_todo.types import (
    ConfirmationResponse,
    CreateTodoParams,
    NotificationType,
    Priority,
    RecurringPattern,
    ReminderMessage,
    TaskSelection,
    TaskType,
    TaskUpdate,
    Todo,
    TodoFilters,
    TodoMetadata,
    TodoPluginConfig,
    UpdateTodoParams,
)

__version__ = "1.0.0"

__all__ = [
    # Client
    "TodoClient",
    # Config
    "TodoConfig",
    # Services
    "TodoDataService",
    "ReminderService",
    "NotificationManager",
    "CacheManager",
    # Errors
    "TodoError",
    "ValidationError",
    "NotFoundError",
    "DatabaseError",
    "ConfigError",
    # Types - Enums
    "Priority",
    "RecurringPattern",
    "TaskType",
    "NotificationType",
    # Types - Data classes
    "Todo",
    "TodoMetadata",
    "CreateTodoParams",
    "UpdateTodoParams",
    "TodoFilters",
    "ReminderMessage",
    "TodoPluginConfig",
    "TaskSelection",
    "TaskUpdate",
    "ConfirmationResponse",
]





