"""Clipboard types -- file-based memory and task clipboard."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

TASK_CLIPBOARD_MAX_ITEMS = 5

TaskClipboardSourceType = Literal[
    "manual",
    "command",
    "file",
    "attachment",
    "image_attachment",
    "channel",
    "conversation_search",
    "entity",
    "entity_search",
]


@dataclass
class ClipboardEntry:
    """A single clipboard file entry."""

    id: str
    path: str
    title: str
    content: str
    created_at: datetime
    modified_at: datetime
    tags: list[str] | None = None


@dataclass
class ClipboardSearchResult:
    """A search match within clipboard entries."""

    path: str
    start_line: int
    end_line: int
    score: float
    snippet: str
    entry_id: str


@dataclass
class ClipboardReadOptions:
    """Options for reading a clipboard entry."""

    from_line: int | None = None
    lines: int | None = None


@dataclass
class ClipboardWriteOptions:
    """Options for writing a clipboard entry."""

    tags: list[str] | None = None
    append: bool = False


@dataclass
class ClipboardSearchOptions:
    """Options for searching clipboard entries."""

    max_results: int = 10
    min_score: float = 0.1


@dataclass
class ClipboardConfig:
    """Configuration for the clipboard service."""

    base_path: str = ""
    max_file_size: int = 1024 * 1024  # 1MB
    allowed_extensions: list[str] = field(default_factory=lambda: [".md", ".txt"])


@dataclass
class TaskClipboardItem:
    """A bounded working-memory clipboard item."""

    id: str
    title: str
    content: str
    source_type: TaskClipboardSourceType
    source_id: str | None = None
    source_label: str | None = None
    mime_type: str | None = None
    created_at: str = ""
    updated_at: str = ""


@dataclass
class TaskClipboardSnapshot:
    """Current state of the task clipboard."""

    max_items: int = TASK_CLIPBOARD_MAX_ITEMS
    items: list[TaskClipboardItem] = field(default_factory=list)


@dataclass
class AddTaskClipboardItemInput:
    """Input for adding an item to the task clipboard."""

    content: str
    title: str | None = None
    source_type: TaskClipboardSourceType | None = None
    source_id: str | None = None
    source_label: str | None = None
    mime_type: str | None = None
