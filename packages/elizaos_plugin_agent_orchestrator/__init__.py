"""Small compatibility surface for SWE-bench provider tests."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class TaskUserStatus(str, Enum):
    OPEN = "open"
    CLOSED = "closed"


@dataclass
class OrchestratedTaskMetadata:
    status: TaskStatus
    progress: int
    output: list[str]
    steps: list[Any]
    working_directory: str
    provider_id: str
    provider_label: str
    sub_agent_type: str
    user_status: TaskUserStatus
    user_status_updated_at: int
    files_created: list[str]
    files_modified: list[str]
    created_at: int


@dataclass
class OrchestratedTask:
    id: str
    name: str
    description: str
    tags: list[str]
    metadata: OrchestratedTaskMetadata


@dataclass
class ProviderTaskExecutionContext:
    runtime_agent_id: str
    working_directory: str
    append_output: Callable[[str], Awaitable[None]]
    update_progress: Callable[[int], Awaitable[None]]
    update_step: Callable[[str, TaskStatus, str | None], Awaitable[None]]
    is_cancelled: Callable[[], bool]
    is_paused: Callable[[], bool]


@dataclass
class ProviderExecutionResult:
    success: bool
    output: str = ""
    extra: dict[str, Any] = field(default_factory=dict)
