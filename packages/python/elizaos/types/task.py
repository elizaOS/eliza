from __future__ import annotations

from collections.abc import Awaitable
from typing import TYPE_CHECKING, Protocol

from elizaos.types.generated.eliza.v1 import task_pb2

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

Task = task_pb2.Task
TaskMetadata = task_pb2.TaskMetadata
TaskStatus = task_pb2.TaskStatus


# Runtime worker interface (not in proto)
class TaskWorker(Protocol):
    name: str

    def __call__(
        self,
        runtime: IAgentRuntime,
        params: dict[str, object],
        task: Task,
    ) -> Awaitable[None]: ...


__all__ = ["Task", "TaskMetadata", "TaskStatus", "TaskWorker"]
