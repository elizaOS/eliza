from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class CoderConfig:
    enabled: bool
    allowed_directory: str
    timeout_ms: int
    forbidden_commands: list[str]


FileOperationType = Literal["read", "write", "edit", "list", "search"]


@dataclass(frozen=True)
class FileOperation:
    type: FileOperationType
    target: str


@dataclass(frozen=True)
class CommandResult:
    success: bool
    stdout: str
    stderr: str
    exit_code: int | None
    executed_in: str
    error: str | None = None


@dataclass(frozen=True)
class CommandHistoryEntry:
    timestamp: float
    working_directory: str
    command: str
    stdout: str
    stderr: str
    exit_code: int | None
    file_operations: list[FileOperation] | None = None
