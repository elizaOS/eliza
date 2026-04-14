"""Clipboard capability -- file-based memory and task clipboard."""

from .actions import (
    clipboard_append_action,
    clipboard_delete_action,
    clipboard_list_action,
    clipboard_read_action,
    clipboard_search_action,
    clipboard_write_action,
    read_attachment_action,
    read_file_action,
    remove_from_clipboard_action,
)
from .providers import clipboard_provider
from .services import (
    ClipboardService,
    TaskClipboardService,
    create_clipboard_service,
    create_task_clipboard_service,
)
from .types import (
    TASK_CLIPBOARD_MAX_ITEMS,
    AddTaskClipboardItemInput,
    ClipboardConfig,
    ClipboardEntry,
    ClipboardReadOptions,
    ClipboardSearchOptions,
    ClipboardSearchResult,
    ClipboardWriteOptions,
    TaskClipboardItem,
    TaskClipboardSnapshot,
)

__all__ = [
    # Actions
    "clipboard_append_action",
    "clipboard_delete_action",
    "clipboard_list_action",
    "clipboard_read_action",
    "clipboard_search_action",
    "clipboard_write_action",
    "read_file_action",
    "read_attachment_action",
    "remove_from_clipboard_action",
    # Provider
    "clipboard_provider",
    # Services
    "ClipboardService",
    "TaskClipboardService",
    "create_clipboard_service",
    "create_task_clipboard_service",
    # Types
    "TASK_CLIPBOARD_MAX_ITEMS",
    "AddTaskClipboardItemInput",
    "ClipboardConfig",
    "ClipboardEntry",
    "ClipboardReadOptions",
    "ClipboardSearchOptions",
    "ClipboardSearchResult",
    "ClipboardWriteOptions",
    "TaskClipboardItem",
    "TaskClipboardSnapshot",
]
