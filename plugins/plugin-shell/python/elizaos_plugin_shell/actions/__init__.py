"""Shell plugin actions."""

from elizaos_plugin_shell.actions.execute_command import ExecuteCommandAction
from elizaos_plugin_shell.actions.clear_history import ClearHistoryAction

__all__ = [
    "ExecuteCommandAction",
    "ClearHistoryAction",
    "get_shell_actions",
    "get_shell_action_names",
]


def get_shell_actions() -> list:
    """Get all shell actions as instances."""
    return [
        ExecuteCommandAction(),
        ClearHistoryAction(),
    ]


def get_shell_action_names() -> list[str]:
    """Get all shell action names."""
    return [
        "EXECUTE_COMMAND",
        "CLEAR_SHELL_HISTORY",
    ]
