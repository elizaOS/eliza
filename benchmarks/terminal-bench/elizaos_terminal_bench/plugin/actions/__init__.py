"""Terminal-Bench Actions for ElizaOS."""

from .execute import execute_action
from .list_dir import list_dir_action
from .read_file import read_file_action
from .task_complete import task_complete_action
from .touch import touch_action
from .write_file import write_file_action

__all__ = [
    "execute_action",
    "read_file_action",
    "write_file_action",
    "touch_action",
    "list_dir_action",
    "task_complete_action",
    "TERMINAL_ACTIONS",
]

TERMINAL_ACTIONS = [
    execute_action,
    read_file_action,
    write_file_action,
    touch_action,
    list_dir_action,
    task_complete_action,
]
