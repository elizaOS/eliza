"""
Type definitions for the Agent Orchestrator plugin.

These types mirror the TypeScript definitions for cross-platform parity.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol, TypeAlias

# JSON-safe value types
JsonValue: TypeAlias = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]


class TaskStatus(str, Enum):
    """Execution status of a task."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    PAUSED = "paused"
    CANCELLED = "cancelled"


class TaskUserStatus(str, Enum):
    """User-controlled lifecycle status (separate from execution status)."""

    OPEN = "open"
    DONE = "done"


@dataclass
class TaskStep:
    """A single step within a task plan."""

    id: str
    description: str
    status: TaskStatus = TaskStatus.PENDING
    output: str | None = None
    extra: dict[str, JsonValue] = field(default_factory=dict)

    @staticmethod
    def create(description: str) -> TaskStep:
        return TaskStep(id=str(uuid.uuid4()), description=description)

    def to_dict(self) -> dict[str, JsonValue]:
        result: dict[str, JsonValue] = {
            "id": self.id,
            "description": self.description,
            "status": self.status.value,
        }
        if self.output is not None:
            result["output"] = self.output
        result.update(self.extra)
        return result

    @staticmethod
    def from_dict(data: dict[str, Any]) -> TaskStep:
        extra = {
            k: v for k, v in data.items() if k not in ("id", "description", "status", "output")
        }
        return TaskStep(
            id=str(data.get("id", "")),
            description=str(data.get("description", "")),
            status=TaskStatus(data.get("status", "pending")),
            output=data.get("output"),
            extra=extra,
        )


@dataclass
class TaskResult:
    """Result of task execution."""

    success: bool
    summary: str
    files_modified: list[str] = field(default_factory=list)
    files_created: list[str] = field(default_factory=list)
    error: str | None = None
    extra: dict[str, JsonValue] = field(default_factory=dict)

    def to_dict(self) -> dict[str, JsonValue]:
        result: dict[str, JsonValue] = {
            "success": self.success,
            "summary": self.summary,
            "filesModified": self.files_modified,
            "filesCreated": self.files_created,
        }
        if self.error is not None:
            result["error"] = self.error
        result.update(self.extra)
        return result

    @staticmethod
    def from_dict(data: dict[str, Any]) -> TaskResult:
        extra = {
            k: v
            for k, v in data.items()
            if k not in ("success", "summary", "filesModified", "filesCreated", "error")
        }
        return TaskResult(
            success=bool(data.get("success", False)),
            summary=str(data.get("summary", "")),
            files_modified=list(data.get("filesModified", [])),
            files_created=list(data.get("filesCreated", [])),
            error=data.get("error"),
            extra=extra,
        )


AgentProviderId: TypeAlias = str


@dataclass
class OrchestratedTaskMetadata:
    """Metadata for an orchestrated task."""

    status: TaskStatus
    progress: int
    output: list[str]
    steps: list[TaskStep]
    working_directory: str
    provider_id: AgentProviderId
    created_at: int

    result: TaskResult | None = None
    error: str | None = None
    started_at: int | None = None
    completed_at: int | None = None

    provider_label: str | None = None
    sub_agent_type: str | None = None
    user_status: TaskUserStatus = TaskUserStatus.OPEN
    user_status_updated_at: int | None = None
    files_created: list[str] = field(default_factory=list)
    files_modified: list[str] = field(default_factory=list)
    extra: dict[str, JsonValue] = field(default_factory=dict)

    def to_dict(self) -> dict[str, JsonValue]:
        result: dict[str, JsonValue] = {
            "status": self.status.value,
            "progress": self.progress,
            "output": self.output,
            "steps": [s.to_dict() for s in self.steps],
            "workingDirectory": self.working_directory,
            "providerId": self.provider_id,
            "createdAt": self.created_at,
            "userStatus": self.user_status.value,
            "filesCreated": self.files_created,
            "filesModified": self.files_modified,
        }
        if self.result is not None:
            result["result"] = self.result.to_dict()
        if self.error is not None:
            result["error"] = self.error
        if self.started_at is not None:
            result["startedAt"] = self.started_at
        if self.completed_at is not None:
            result["completedAt"] = self.completed_at
        if self.provider_label is not None:
            result["providerLabel"] = self.provider_label
        if self.sub_agent_type is not None:
            result["subAgentType"] = self.sub_agent_type
        if self.user_status_updated_at is not None:
            result["userStatusUpdatedAt"] = self.user_status_updated_at
        result.update(self.extra)
        return result

    @staticmethod
    def from_dict(data: dict[str, Any]) -> OrchestratedTaskMetadata:
        steps = [TaskStep.from_dict(s) for s in data.get("steps", [])]
        result_data = data.get("result")
        result = TaskResult.from_dict(result_data) if result_data else None

        known_keys = {
            "status",
            "progress",
            "output",
            "steps",
            "workingDirectory",
            "providerId",
            "createdAt",
            "result",
            "error",
            "startedAt",
            "completedAt",
            "providerLabel",
            "subAgentType",
            "userStatus",
            "userStatusUpdatedAt",
            "filesCreated",
            "filesModified",
        }
        extra = {k: v for k, v in data.items() if k not in known_keys}

        return OrchestratedTaskMetadata(
            status=TaskStatus(data.get("status", "pending")),
            progress=int(data.get("progress", 0)),
            output=list(data.get("output", [])),
            steps=steps,
            working_directory=str(data.get("workingDirectory", "")),
            provider_id=str(data.get("providerId", "")),
            created_at=int(data.get("createdAt", 0)),
            result=result,
            error=data.get("error"),
            started_at=data.get("startedAt"),
            completed_at=data.get("completedAt"),
            provider_label=data.get("providerLabel"),
            sub_agent_type=data.get("subAgentType"),
            user_status=TaskUserStatus(data.get("userStatus", "open")),
            user_status_updated_at=data.get("userStatusUpdatedAt"),
            files_created=list(data.get("filesCreated", [])),
            files_modified=list(data.get("filesModified", [])),
            extra=extra,
        )


@dataclass
class OrchestratedTask:
    """A task managed by the orchestrator."""

    id: str
    name: str
    description: str
    metadata: OrchestratedTaskMetadata
    tags: list[str] = field(default_factory=list)
    room_id: str | None = None
    world_id: str | None = None


@dataclass
class ProviderTaskExecutionContext:
    """Context provided to agent providers during task execution."""

    runtime_agent_id: str
    working_directory: str
    append_output: Callable[[str], Awaitable[None]]
    update_progress: Callable[[int], Awaitable[None]]
    update_step: Callable[[str, TaskStatus, str | None], Awaitable[None]]
    is_cancelled: Callable[[], bool]
    is_paused: Callable[[], bool]
    room_id: str | None = None
    world_id: str | None = None


class AgentProvider(Protocol):
    """Protocol for agent providers that can execute tasks."""

    @property
    def id(self) -> AgentProviderId:
        """Unique identifier for this provider."""
        ...

    @property
    def label(self) -> str:
        """Human-readable label for this provider."""
        ...

    @property
    def description(self) -> str | None:
        """Optional description of this provider."""
        ...

    async def execute_task(
        self,
        task: OrchestratedTask,
        ctx: ProviderTaskExecutionContext,
    ) -> TaskResult:
        """Execute the given task and return the result."""
        ...


@dataclass
class AgentOrchestratorPluginOptions:
    """Configuration options for the orchestrator plugin."""

    providers: list[AgentProvider]
    default_provider_id: AgentProviderId
    get_working_directory: Callable[[], str]
    active_provider_env_var: str = "ELIZA_CODE_ACTIVE_SUB_AGENT"


class TaskEventType(str, Enum):
    """Types of task events."""

    CREATED = "task:created"
    STARTED = "task:started"
    PROGRESS = "task:progress"
    OUTPUT = "task:output"
    COMPLETED = "task:completed"
    FAILED = "task:failed"
    CANCELLED = "task:cancelled"
    PAUSED = "task:paused"
    RESUMED = "task:resumed"
    MESSAGE = "task:message"


@dataclass
class TaskEvent:
    """Event emitted by the orchestrator service."""

    type: TaskEventType
    task_id: str
    data: dict[str, JsonValue] | None = None
