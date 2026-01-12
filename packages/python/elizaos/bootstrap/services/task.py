from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from elizaos.types import Service, ServiceType

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


class TaskStatus(str, Enum):
    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class TaskPriority(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    URGENT = "URGENT"


@dataclass
class Task:
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
    name = "task"
    service_type = ServiceType.TASK

    @property
    def capability_description(self) -> str:
        return "Task management service for creating, tracking, and completing tasks."

    def __init__(self) -> None:
        self._tasks: dict[UUID, Task] = {}
        self._runtime: IAgentRuntime | None = None

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> TaskService:
        service = cls()
        service._runtime = runtime
        runtime.logger.info(
            "Task service started",
            src="service:task",
            agentId=str(runtime.agent_id),
        )
        return service

    async def stop(self) -> None:
        if self._runtime:
            self._runtime.logger.info(
                "Task service stopped",
                src="service:task",
                agentId=str(self._runtime.agent_id),
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
        now = datetime.now(UTC)
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
                "Task created",
                src="service:task",
                taskId=str(task.id),
                taskName=name,
            )

        return task

    async def get_task(self, task_id: UUID) -> Task | None:
        return self._tasks.get(task_id)

    async def update_task_status(
        self,
        task_id: UUID,
        status: TaskStatus,
    ) -> Task | None:
        task = self._tasks.get(task_id)
        if task is None:
            return None

        task.status = status
        task.updated_at = datetime.now(UTC)

        if status == TaskStatus.COMPLETED:
            task.completed_at = task.updated_at

        if self._runtime:
            self._runtime.logger.debug(
                "Task status updated",
                src="service:task",
                taskId=str(task_id),
                newStatus=status.value,
            )

        return task

    async def get_tasks_by_status(
        self,
        status: TaskStatus,
    ) -> list[Task]:
        return [t for t in self._tasks.values() if t.status == status]

    async def get_tasks_by_priority(
        self,
        priority: TaskPriority,
    ) -> list[Task]:
        return [t for t in self._tasks.values() if t.priority == priority]

    async def get_pending_tasks(self) -> list[Task]:
        pending = [t for t in self._tasks.values() if t.status == TaskStatus.PENDING]
        priority_order = {
            TaskPriority.URGENT: 0,
            TaskPriority.HIGH: 1,
            TaskPriority.MEDIUM: 2,
            TaskPriority.LOW: 3,
        }
        return sorted(pending, key=lambda t: priority_order[t.priority])

    async def complete_task(self, task_id: UUID) -> Task | None:
        return await self.update_task_status(task_id, TaskStatus.COMPLETED)

    async def cancel_task(self, task_id: UUID) -> Task | None:
        return await self.update_task_status(task_id, TaskStatus.CANCELLED)

    async def delete_task(self, task_id: UUID) -> bool:
        if task_id in self._tasks:
            del self._tasks[task_id]
            if self._runtime:
                self._runtime.logger.debug(
                    "Task deleted",
                    src="service:task",
                    taskId=str(task_id),
                )
            return True
        return False
