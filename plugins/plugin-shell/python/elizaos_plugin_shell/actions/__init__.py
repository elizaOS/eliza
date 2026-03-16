from elizaos_plugin_shell.actions.clear_history import ClearHistoryAction
from elizaos_plugin_shell.actions.execute_command import ExecuteCommandAction

__all__ = [
    "ExecuteCommandAction",
    "ClearHistoryAction",
    "get_shell_actions",
    "get_shell_action_names",
]


def get_shell_actions() -> list:
    return [
        ExecuteCommandAction(),
        ClearHistoryAction(),
    ]


def get_shell_action_names() -> list[str]:
    return [
        "EXECUTE_COMMAND",
        "CLEAR_SHELL_HISTORY",
    ]
