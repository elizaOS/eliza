"""
Task Service - Manages task creation, tracking, and execution.

This service provides task management capabilities for the agent,
including creating, updating, and completing tasks.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from elizaos.types import Service, ServiceType

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


class TaskStatus(str, Enum):
    """Task status values."""

    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class TaskPriority(str, Enum):
    """Task priority levels."""

    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    URGENT = "URGENT"


@dataclass
class Task:
    """Represents a task in the system."""

    id: UUID
    name: str
    description: str
    status: TaskStatus
    priority: TaskPriority
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None
    metadata: dict[str, str | int | float | bool | None] = field(default_factory=dict)
    assignee_id: UUID | None = None
    parent_id: UUID | None = None


class TaskService(Service):
    """
    Service for managing tasks.

    Provides capabilities for:
    - Creating new tasks
    - Updating task status
    - Tracking task progress
    - Managing task hierarchy
    """

    name = "task"
    service_type = ServiceType.CORE

    def __init__(self) -> None:
        """Initialize the task service."""
        self._tasks: dict[UUID, Task] = {}
        self._runtime: IAgentRuntime | None = None

    async def start(self, runtime: IAgentRuntime) -> None:
        """Start the task service."""
        self._runtime = runtime
        runtime.logger.info(
            {"src": "service:task", "agentId": runtime.agent_id},
            "Task service started",
        )

    async def stop(self) -> None:
        """Stop the task service."""
        if self._runtime:
            self._runtime.logger.info(
                {"src": "service:task", "agentId": self._runtime.agent_id},
                "Task service stopped",
            )
        self._tasks.clear()
        self._runtime = None

    async def create_task(
        self,
        name: str,
        description: str,
        priority: TaskPriority = TaskPriority.MEDIUM,
        assignee_id: UUID | None = None,
        parent_id: UUID | None = None,
        metadata: dict[str, str | int | float | bool | None] | None = None,
    ) -> Task:
        """
        Create a new task.

        Args:
            name: Task name
            description: Task description
            priority: Task priority level
            assignee_id: Optional assignee entity ID
            parent_id: Optional parent task ID
            metadata: Optional task metadata

        Returns:
            The created task
        """
        now = datetime.now(timezone.utc)
        task = Task(
            id=uuid4(),
            name=name,
            description=description,
            status=TaskStatus.PENDING,
            priority=priority,
            created_at=now,
            updated_at=now,
            assignee_id=assignee_id,
            parent_id=parent_id,
            metadata=metadata or {},
        )
        self._tasks[task.id] = task

        if self._runtime:
            self._runtime.logger.debug(
                {
                    "src": "service:task",
                    "taskId": str(task.id),
                    "taskName": name,
                },
                "Task created",
            )

        return task

    async def get_task(self, task_id: UUID) -> Task | None:
        """
        Get a task by ID.

        Args:
            task_id: The task ID

        Returns:
            The task or None if not found
        """
        return self._tasks.get(task_id)

    async def update_task_status(
        self,
        task_id: UUID,
        status: TaskStatus,
    ) -> Task | None:
        """
        Update a task's status.

        Args:
            task_id: The task ID
            status: The new status

        Returns:
            The updated task or None if not found
        """
        task = self._tasks.get(task_id)
        if task is None:
            return None

        task.status = status
        task.updated_at = datetime.now(timezone.utc)

        if status == TaskStatus.COMPLETED:
            task.completed_at = task.updated_at

        if self._runtime:
            self._runtime.logger.debug(
                {
                    "src": "service:task",
                    "taskId": str(task_id),
                    "newStatus": status.value,
                },
                "Task status updated",
            )

        return task

    async def get_tasks_by_status(
        self,
        status: TaskStatus,
    ) -> list[Task]:
        """
        Get all tasks with a specific status.

        Args:
            status: The status to filter by

        Returns:
            List of tasks with the given status
        """
        return [t for t in self._tasks.values() if t.status == status]

    async def get_tasks_by_priority(
        self,
        priority: TaskPriority,
    ) -> list[Task]:
        """
        Get all tasks with a specific priority.

        Args:
            priority: The priority to filter by

        Returns:
            List of tasks with the given priority
        """
        return [t for t in self._tasks.values() if t.priority == priority]

    async def get_pending_tasks(self) -> list[Task]:
        """
        Get all pending tasks, sorted by priority.

        Returns:
            List of pending tasks
        """
        pending = [t for t in self._tasks.values() if t.status == TaskStatus.PENDING]
        # Sort by priority (URGENT > HIGH > MEDIUM > LOW)
        priority_order = {
            TaskPriority.URGENT: 0,
            TaskPriority.HIGH: 1,
            TaskPriority.MEDIUM: 2,
            TaskPriority.LOW: 3,
        }
        return sorted(pending, key=lambda t: priority_order[t.priority])

    async def complete_task(self, task_id: UUID) -> Task | None:
        """
        Mark a task as completed.

        Args:
            task_id: The task ID

        Returns:
            The completed task or None if not found
        """
        return await self.update_task_status(task_id, TaskStatus.COMPLETED)

    async def cancel_task(self, task_id: UUID) -> Task | None:
        """
        Cancel a task.

        Args:
            task_id: The task ID

        Returns:
            The cancelled task or None if not found
        """
        return await self.update_task_status(task_id, TaskStatus.CANCELLED)

    async def delete_task(self, task_id: UUID) -> bool:
        """
        Delete a task.

        Args:
            task_id: The task ID

        Returns:
            True if deleted, False if not found
        """
        if task_id in self._tasks:
            del self._tasks[task_id]
            if self._runtime:
                self._runtime.logger.debug(
                    {"src": "service:task", "taskId": str(task_id)},
                    "Task deleted",
                )
            return True
        return False

