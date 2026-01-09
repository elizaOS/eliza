"""
Task types for elizaOS.

This module defines types for tasks and task workers.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from enum import Enum
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from elizaos.types.primitives import UUID

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime


class TaskStatus(str, Enum):
    """Task status enumeration."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TaskMetadata(BaseModel):
    """Metadata for a task."""

    priority: int | None = Field(default=None, description="Task priority")
    retry_count: int | None = Field(
        default=None, alias="retryCount", description="Number of retries"
    )
    max_retries: int | None = Field(
        default=None, alias="maxRetries", description="Maximum retries allowed"
    )
    scheduled_at: int | None = Field(
        default=None, alias="scheduledAt", description="Scheduled execution time"
    )
    interval: int | None = Field(default=None, description="Repeat interval in milliseconds")

    model_config = {"populate_by_name": True, "extra": "allow"}


class Task(BaseModel):
    """Represents a task to be executed."""

    id: UUID | None = Field(default=None, description="Unique identifier")
    name: str = Field(..., description="Task name")
    description: str | None = Field(default=None, description="Task description")
    room_id: UUID | None = Field(default=None, alias="roomId", description="Associated room")
    entity_id: UUID | None = Field(default=None, alias="entityId", description="Associated entity")
    world_id: UUID | None = Field(default=None, alias="worldId", description="Associated world")
    status: TaskStatus = Field(default=TaskStatus.PENDING, description="Task status")
    tags: list[str] | None = Field(default=None, description="Tags for filtering")
    metadata: TaskMetadata | None = Field(default=None, description="Task metadata")
    created_at: int | None = Field(
        default=None, alias="createdAt", description="Creation timestamp"
    )
    updated_at: int | None = Field(
        default=None, alias="updatedAt", description="Last update timestamp"
    )

    model_config = {"populate_by_name": True}


class TaskWorker(BaseModel):
    """Task worker definition for handling tasks."""

    name: str = Field(..., description="Worker name matching task name")
    validate_fn: Callable[[IAgentRuntime, Task], Awaitable[bool]] | None = Field(
        default=None, alias="validate", description="Validation function"
    )
    execute: Callable[[IAgentRuntime, Task, dict[str, Any]], Awaitable[Any]] = Field(
        ..., description="Execution function"
    )

    model_config = {"arbitrary_types_allowed": True, "populate_by_name": True}
