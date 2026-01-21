from elizaos_plugin_todo.actions import (
    CANCEL_TODO_ACTION,
    COMPLETE_TODO_ACTION,
    CONFIRM_TODO_ACTION,
    CREATE_TODO_ACTION,
    UPDATE_TODO_ACTION,
    CancelTodoResult,
    CompleteTodoResult,
    ConfirmTodoResult,
    CreateTodoResult,
    UpdateTodoResult,
    handle_cancel_todo,
    handle_complete_todo,
    handle_confirm_todo,
    handle_create_todo,
    handle_update_todo,
)
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
from elizaos_plugin_todo.plugin import todo_plugin
from elizaos_plugin_todo.providers import TODOS_PROVIDER, get_todos
from elizaos_plugin_todo.reminder_service import ReminderService, TodoReminderService
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
    "TodoReminderService",
    "NotificationManager",
    "CacheManager",
    # Actions
    "CREATE_TODO_ACTION",
    "COMPLETE_TODO_ACTION",
    "UPDATE_TODO_ACTION",
    "CANCEL_TODO_ACTION",
    "CONFIRM_TODO_ACTION",
    "handle_create_todo",
    "handle_complete_todo",
    "handle_update_todo",
    "handle_cancel_todo",
    "handle_confirm_todo",
    "CreateTodoResult",
    "CompleteTodoResult",
    "UpdateTodoResult",
    "CancelTodoResult",
    "ConfirmTodoResult",
    # Providers
    "TODOS_PROVIDER",
    "get_todos",
    # Plugin (python runtime)
    "todo_plugin",
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
