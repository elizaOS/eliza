"""Actions for the Todo plugin."""

from elizaos_plugin_todo.actions.cancel_todo import (
    CANCEL_TODO_ACTION,
    CancelTodoResult,
    handle_cancel_todo,
    validate_cancel_todo,
)
from elizaos_plugin_todo.actions.complete_todo import (
    COMPLETE_TODO_ACTION,
    CompleteTodoResult,
    handle_complete_todo,
    validate_complete_todo,
)
from elizaos_plugin_todo.actions.confirm_todo import (
    CONFIRM_TODO_ACTION,
    ConfirmTodoResult,
    handle_confirm_todo,
    validate_confirm_todo,
)
from elizaos_plugin_todo.actions.create_todo import (
    CREATE_TODO_ACTION,
    CreateTodoResult,
    handle_create_todo,
    validate_create_todo,
)
from elizaos_plugin_todo.actions.update_todo import (
    UPDATE_TODO_ACTION,
    UpdateTodoResult,
    handle_update_todo,
    validate_update_todo,
)

__all__ = [
    # CREATE_TODO
    "CREATE_TODO_ACTION",
    "CreateTodoResult",
    "handle_create_todo",
    "validate_create_todo",
    # COMPLETE_TODO
    "COMPLETE_TODO_ACTION",
    "CompleteTodoResult",
    "handle_complete_todo",
    "validate_complete_todo",
    # UPDATE_TODO
    "UPDATE_TODO_ACTION",
    "UpdateTodoResult",
    "handle_update_todo",
    "validate_update_todo",
    # CANCEL_TODO
    "CANCEL_TODO_ACTION",
    "CancelTodoResult",
    "handle_cancel_todo",
    "validate_cancel_todo",
    # CONFIRM_TODO
    "CONFIRM_TODO_ACTION",
    "ConfirmTodoResult",
    "handle_confirm_todo",
    "validate_confirm_todo",
]
