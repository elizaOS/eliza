"""Task service implementation with scheduling capabilities.

This module provides parity with the TypeScript TaskService, including:
- Timer-based task checking (tick loop)
- Task workers with execute/validate callbacks
- Tag-based filtering ("queue", "repeat")
- Blocking mechanism to prevent overlapping executions
- Automatic deletion of non-repeating tasks after execution
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable
from uuid import UUID, uuid4

from elizaos.types import Service, ServiceType

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Interval in milliseconds to check for tasks (parity with TypeScript TICK_INTERVAL)
TICK_INTERVAL_MS = 1000


class TaskStatus(StrEnum):
    """Task status enum."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TaskPriority(StrEnum):
    """Task priority enum."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"


@dataclass
class TaskMetadata:
    """Task metadata containing scheduling and configuration information.

    Provides parity with TypeScript's TaskMetadata interface.
    """

    target_entity_id: str | None = None
    reason: str | None = None
    priority: str | None = None
    message: str | None = None
    status: str | None = None
    scheduled_at: str | None = None
    snoozed_at: str | None = None
    original_scheduled_at: Any | None = None
    created_at: str | None = None
    completed_at: str | None = None
    completion_notes: str | None = None
    last_executed: str | None = None
    updated_at: int | None = None
    update_interval: int | None = None
    """Interval in milliseconds between updates or executions for recurring tasks."""
    blocking: bool | None = None
    """If true (default), the task will block the next scheduled execution while running.
    Set to false to allow overlapping executions."""
    options: list[dict[str, str]] | None = None
    values: dict[str, Any] | None = None


@dataclass
class Task:
    """Represents a task to be performed, often in the background or at a later time.

    Tasks are managed by the TaskService and processed by registered TaskWorkers.
    """

    name: str
    id: UUID | None = None
    description: str | None = None
    status: TaskStatus | None = TaskStatus.PENDING
    room_id: UUID | None = None
    world_id: UUID | None = None
    entity_id: UUID | None = None
    tags: list[str] | None = None
    metadata: TaskMetadata | None = None
    created_at: int | None = None
    updated_at: int | None = None
    scheduled_at: int | None = None
    repeat_interval: int | None = None
    data: Any | None = None

    @classmethod
    def create(cls, name: str) -> Task:
        """Create a new task with defaults."""
        now = _current_timestamp()
        return cls(
            id=uuid4(),
            name=name,
            status=TaskStatus.PENDING,
            created_at=now,
            updated_at=now,
            metadata=TaskMetadata(
                updated_at=now,
                created_at=str(now),
            ),
        )

    @classmethod
    def scheduled(cls, name: str, scheduled_at: int) -> Task:
        """Create a scheduled task."""
        task = cls.create(name)
        task.scheduled_at = scheduled_at
        return task

    @classmethod
    def repeating(cls, name: str, interval_ms: int) -> Task:
        """Create a repeating task with the given interval."""
        task = cls.create(name)
        task.tags = ["queue", "repeat"]
        if task.metadata:
            task.metadata.update_interval = interval_ms
            task.metadata.blocking = True  # Default to blocking
        else:
            task.metadata = TaskMetadata(
                update_interval=interval_ms,
                blocking=True,
            )
        return task

    @classmethod
    def repeating_with_blocking(cls, name: str, interval_ms: int, blocking: bool) -> Task:
        """Create a repeating task with blocking configuration."""
        task = cls.repeating(name, interval_ms)
        if task.metadata:
            task.metadata.blocking = blocking
        return task

    def is_repeating(self) -> bool:
        """Check if this task is a repeating task."""
        return self.tags is not None and "repeat" in self.tags

    def is_blocking(self) -> bool:
        """Check if this task should block overlapping executions."""
        if self.metadata and self.metadata.blocking is not None:
            return self.metadata.blocking
        return True  # Default to blocking

    def get_update_interval(self) -> int | None:
        """Get the update interval in milliseconds."""
        if self.metadata:
            return self.metadata.update_interval
        return None


@runtime_checkable
class TaskWorker(Protocol):
    """Task worker protocol - defines the contract for executing tasks.

    Parity with TypeScript's TaskWorker interface.
    """

    @property
    def name(self) -> str:
        """The unique name of the task type this worker handles."""
        ...

    async def execute(
        self,
        runtime: IAgentRuntime,
        options: dict[str, Any],
        task: Task,
    ) -> None:
        """Execute the task."""
        ...

    async def validate(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
    ) -> bool:
        """Optional validation function."""
        ...


class TaskService(Service):
    """Service for managing and scheduling tasks.

    Provides parity with TypeScript's TaskService.
    """

    name = "task"
    service_type = ServiceType.TASK

    @property
    def capability_description(self) -> str:
        """Capability description for the service."""
        return "Task management service with scheduling and worker execution."

    def __init__(self) -> None:
        """Initialize the task service."""
        self._workers: dict[str, TaskWorker] = {}
        self._tasks: dict[str, Task] = {}
        self._executing_tasks: set[str] = set()
        self._runtime: IAgentRuntime | None = None
        self._stop_flag = False
        self._loop_task: asyncio.Task[None] | None = None

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> TaskService:
        """Start the task service."""
        service = cls()
        service._runtime = runtime
        service._stop_flag = False
        runtime.logger.info(
            "Task service started",
            src="service:task",
            agentId=str(runtime.agent_id),
        )

        # Start the timer loop
        service._loop_task = asyncio.create_task(service._run_timer())

        return service

    async def stop(self) -> None:
        """Stop the task service."""
        self._stop_flag = True

        if self._loop_task:
            self._loop_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._loop_task
            self._loop_task = None

        if self._runtime:
            self._runtime.logger.info(
                "Task service stopped",
                src="service:task",
                agentId=str(self._runtime.agent_id),
            )

        self._tasks.clear()
        self._executing_tasks.clear()
        self._runtime = None

    async def register_worker(self, worker: TaskWorker) -> None:
        """Register a task worker."""
        self._workers[worker.name] = worker
        if self._runtime:
            self._runtime.logger.debug(
                f"Registered task worker: {worker.name}",
                src="service:task",
            )

    def has_worker(self, name: str) -> bool:
        """Check if a worker exists for the given task name."""
        return name in self._workers

    async def create_task(self, task: Task) -> Task:
        """Create a new task."""
        now = _current_timestamp()

        # Ensure task has an ID
        if task.id is None:
            task.id = uuid4()

        # Set timestamps
        task.created_at = now
        task.updated_at = now

        # Ensure metadata exists with timestamps
        if task.metadata is None:
            task.metadata = TaskMetadata()
        if task.metadata.updated_at is None:
            task.metadata.updated_at = now
        if task.metadata.created_at is None:
            task.metadata.created_at = str(now)

        task_id = str(task.id)

        if self._runtime:
            self._runtime.logger.debug(
                f"Task created: {task_id}",
                src="service:task",
                taskId=task_id,
                taskName=task.name,
            )

        self._tasks[task_id] = task
        return task

    async def get_task(self, task_id: str) -> Task | None:
        """Get a task by ID."""
        return self._tasks.get(task_id)

    async def get_tasks_by_name(self, name: str) -> list[Task]:
        """Get tasks by name."""
        return [t for t in self._tasks.values() if t.name == name]

    async def get_tasks_by_tags(self, tags: list[str]) -> list[Task]:
        """Get tasks with specific tags."""
        return [t for t in self._tasks.values() if t.tags and all(tag in t.tags for tag in tags)]

    async def update_task(
        self, task_id: str, metadata: TaskMetadata | None = None, tags: list[str] | None = None
    ) -> Task | None:
        """Update a task."""
        task = self._tasks.get(task_id)
        if task is None:
            return None

        task.updated_at = _current_timestamp()

        if metadata:
            if task.metadata is None:
                task.metadata = metadata
            else:
                if metadata.updated_at is not None:
                    task.metadata.updated_at = metadata.updated_at
                if metadata.update_interval is not None:
                    task.metadata.update_interval = metadata.update_interval
                if metadata.blocking is not None:
                    task.metadata.blocking = metadata.blocking
                if metadata.values is not None:
                    if task.metadata.values is None:
                        task.metadata.values = metadata.values
                    else:
                        task.metadata.values.update(metadata.values)

        if tags is not None:
            task.tags = tags

        if self._runtime:
            self._runtime.logger.debug(
                f"Task updated: {task_id}",
                src="service:task",
                taskId=task_id,
            )

        return task

    async def delete_task(self, task_id: str) -> bool:
        """Delete a task."""
        if task_id in self._tasks:
            del self._tasks[task_id]
            self._executing_tasks.discard(task_id)

            if self._runtime:
                self._runtime.logger.debug(
                    f"Task deleted: {task_id}",
                    src="service:task",
                    taskId=task_id,
                )
            return True
        return False

    async def _validate_tasks(self, tasks: list[Task]) -> list[Task]:
        """Validate an array of Task objects.

        Skips tasks without IDs or if no worker is found for the task.
        If a worker has a `validate` function, it will run validation.
        Parity with TypeScript's validateTasks.

        Args:
            tasks: An array of Task objects to validate.

        Returns:
            An array of validated Task objects.
        """
        if not self._runtime:
            return []

        validated_tasks: list[Task] = []

        for task in tasks:
            # Skip tasks without IDs
            if task.id is None:
                continue

            worker = self._workers.get(task.name)

            # Skip if no worker found for task
            if worker is None:
                continue

            # If worker has validate function, run validation
            # Pass empty dict/object for message and state since validation is time-based
            if hasattr(worker, "validate"):
                is_valid = await worker.validate(
                    self._runtime,
                    {},  # Empty message (dict representation)
                    {},  # Empty state (dict representation)
                )
                if not is_valid:
                    continue

            validated_tasks.append(task)

        return validated_tasks

    async def _run_timer(self) -> None:
        """Run the timer loop for checking tasks."""
        interval_seconds = TICK_INTERVAL_MS / 1000

        while not self._stop_flag:
            try:
                await asyncio.sleep(interval_seconds)

                if self._stop_flag:
                    break

                await self._check_tasks()
            except asyncio.CancelledError:
                break
            except Exception as e:
                if self._runtime:
                    self._runtime.logger.warning(
                        f"Error checking tasks: {e}",
                        src="service:task",
                    )

        if self._runtime:
            self._runtime.logger.info(
                "Task service timer loop stopped",
                src="service:task",
            )

    async def _check_tasks(self) -> None:
        """Check tasks and execute those that are due."""
        now = _current_timestamp()

        # Get all tasks with "queue" tag
        queue_tasks = [t for t in self._tasks.values() if t.tags and "queue" in t.tags]

        # Validate the tasks (parity with TypeScript)
        tasks = await self._validate_tasks(queue_tasks)

        for task in tasks:
            if task.id is None:
                continue

            task_id = str(task.id)

            # Check if worker exists for this task
            worker = self._workers.get(task.name)
            if worker is None:
                continue

            # For non-repeating tasks, execute immediately
            if not task.is_repeating():
                await self._execute_task(task, task_id, worker)
                continue

            # For repeating tasks, check if interval has elapsed
            task_start_time = (
                task.updated_at or (task.metadata.updated_at if task.metadata else None) or 0
            )

            update_interval = task.get_update_interval() or 0

            # Check for immediate execution on first run
            metadata_updated_at = task.metadata.updated_at if task.metadata else None
            metadata_created_at = None
            if task.metadata and task.metadata.created_at:
                with contextlib.suppress(ValueError):
                    metadata_created_at = int(task.metadata.created_at)

            if metadata_updated_at == metadata_created_at:
                if task.tags and "immediate" in task.tags:
                    if self._runtime:
                        self._runtime.logger.debug(
                            f"Immediately running task: {task.name}",
                            src="service:task",
                        )
                    await self._execute_task(task, task_id, worker)
                    continue

            # Check if enough time has passed
            if now - task_start_time >= update_interval:
                # Check blocking
                is_blocking = task.is_blocking()
                if is_blocking and task_id in self._executing_tasks:
                    if self._runtime:
                        self._runtime.logger.debug(
                            f"Skipping task {task.name} - already executing (blocking enabled)",
                            src="service:task",
                            taskId=task_id,
                        )
                    continue

                if self._runtime:
                    self._runtime.logger.debug(
                        f"Executing task {task.name} - interval elapsed",
                        src="service:task",
                        intervalMs=update_interval,
                    )

                await self._execute_task(task, task_id, worker)

    async def _execute_task(self, task: Task, task_id: str, worker: TaskWorker) -> None:
        """Execute a single task."""
        if self._runtime is None:
            return

        # Mark task as executing
        self._executing_tasks.add(task_id)
        start_time = _current_timestamp()

        # For repeating tasks, update the timestamp before execution
        if task.is_repeating():
            task.updated_at = _current_timestamp()
            if task.metadata:
                task.metadata.updated_at = _current_timestamp()
            if self._runtime:
                self._runtime.logger.debug(
                    f"Updated repeating task timestamp: {task.name}",
                    src="service:task",
                    taskId=task_id,
                )

        # Execute the task
        options = task.metadata.values if task.metadata and task.metadata.values else {}

        if self._runtime:
            self._runtime.logger.debug(
                f"Executing task: {task.name}",
                src="service:task",
                taskId=task_id,
            )

        try:
            await worker.execute(self._runtime, options, task)
        except Exception as e:
            if self._runtime:
                self._runtime.logger.warning(
                    f"Task execution failed: {task.name} - {e}",
                    src="service:task",
                    taskId=task_id,
                )

        # For non-repeating tasks, delete after execution
        if not task.is_repeating():
            self._tasks.pop(task_id, None)
            if self._runtime:
                self._runtime.logger.debug(
                    f"Deleted non-repeating task after execution: {task.name}",
                    src="service:task",
                    taskId=task_id,
                )

        # Always remove from executing set
        self._executing_tasks.discard(task_id)

        duration_ms = _current_timestamp() - start_time
        if self._runtime:
            self._runtime.logger.debug(
                f"Task execution completed: {task.name}",
                src="service:task",
                taskId=task_id,
                durationMs=duration_ms,
            )


def _current_timestamp() -> int:
    """Get the current timestamp in milliseconds."""
    return int(time.time() * 1000)


__all__ = [
    "Task",
    "TaskMetadata",
    "TaskPriority",
    "TaskService",
    "TaskStatus",
    "TaskWorker",
]
