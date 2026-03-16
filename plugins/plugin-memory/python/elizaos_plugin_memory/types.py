"""Domain types for the memory plugin."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import IntEnum
from typing import TypedDict

MEMORY_METADATA_SEPARATOR = "\n---\n"
MEMORY_SOURCE = "plugin-memory"
PLUGIN_MEMORY_TABLE = "plugin_memory"

IMPORTANCE_LABELS: dict[int, str] = {1: "low", 2: "normal", 3: "high", 4: "critical"}


class MemoryImportance(IntEnum):
    LOW = 1
    NORMAL = 2
    HIGH = 3
    CRITICAL = 4


@dataclass
class ParsedMemory:
    content: str
    tags: list[str]
    importance: MemoryImportance


@dataclass
class RememberParameters:
    content: str | None = None
    tags: list[str] = field(default_factory=list)
    importance: MemoryImportance = MemoryImportance.NORMAL
    metadata: dict[str, str | int | bool] = field(default_factory=dict)


@dataclass
class RecallParameters:
    query: str | None = None
    tags: list[str] = field(default_factory=list)
    limit: int = 10
    min_importance: MemoryImportance = MemoryImportance.LOW


@dataclass
class ForgetParameters:
    memory_id: str | None = None
    content: str | None = None


class MemorySearchResult(TypedDict):
    id: str
    content: str
    tags: list[str]
    importance: int
    created_at: int


def encode_memory_text(
    content: str, tags: list[str], importance: MemoryImportance
) -> str:
    """Encode memory content with metadata into a storable text format."""
    metadata = json.dumps({"t": tags, "i": int(importance)})
    return f"{metadata}{MEMORY_METADATA_SEPARATOR}{content}"


def decode_memory_text(text: str) -> ParsedMemory:
    """Decode a stored memory text into its content and metadata."""
    sep_index = text.find(MEMORY_METADATA_SEPARATOR)
    if sep_index == -1:
        return ParsedMemory(content=text, tags=[], importance=MemoryImportance.NORMAL)

    metadata_str = text[:sep_index]
    content = text[sep_index + len(MEMORY_METADATA_SEPARATOR) :]

    try:
        metadata = json.loads(metadata_str)
        raw_tags = metadata.get("t", [])
        tags = [str(t) for t in raw_tags] if isinstance(raw_tags, list) else []
        importance_val = metadata.get("i", 2)
        importance = (
            MemoryImportance(importance_val)
            if isinstance(importance_val, int) and 1 <= importance_val <= 4
            else MemoryImportance.NORMAL
        )
        return ParsedMemory(content=content, tags=tags, importance=importance)
    except (json.JSONDecodeError, ValueError):
        return ParsedMemory(content=text, tags=[], importance=MemoryImportance.NORMAL)
