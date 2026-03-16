"""
Agent Orchestrator Service - manages task lifecycle and delegates to providers.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Callable
from typing import Any

from .config import get_configured_options
from .types import (
    AgentProvider,
    AgentProviderId,
    JsonValue,
    OrchestratedTask,
    OrchestratedTaskMetadata,
    ProviderTaskExecutionContext,
    TaskEvent,
    TaskEventType,
    TaskResult,
    TaskStatus,
    TaskStep,
    TaskUserStatus,
)


def _now() -> int:
    """Current time in milliseconds."""
    return int(time.time() * 1000)


def _clamp_progress(n: int | float) -> int:
    """Clamp progress to 0-100."""
    if not isinstance(n, (int, float)):
        return 0
    return min(100, max(0, round(n)))


class ControlState:
    """Per-task cancellation/pause state."""

    def __init__(self) -> None:
        self.cancelled = False
        self.paused = False


class AgentOrchestratorService:
    """
    Orchestrates tasks across registered agent providers.

    This service manages task lifecycle (create, pause, resume, cancel)
    and delegates actual execution to registered AgentProviders.
    """

    service_type = "CODE_TASK"
    capability_description = "Orchestrates tasks across registered agent providers"

    def __init__(self, runtime: Any) -> None:
        self.runtime = runtime
        self._current_task_id: str | None = None
        self._control_states: dict[str, ControlState] = {}
        self._executions: dict[str, asyncio.Task[None]] = {}
        self._event_handlers: dict[str, list[Callable[[TaskEvent], None]]] = {}

    @classmethod
    async def start(cls, runtime: Any) -> AgentOrchestratorService:
        """Start the service."""
        return cls(runtime)

    async def stop(self) -> None:
        """Stop the service."""
        self._event_handlers.clear()
        self._control_states.clear()
        for task in self._executions.values():
            task.cancel()
        self._executions.clear()

    # ========================================================================
    # Provider resolution
    # ========================================================================

    def _get_options(self) -> Any:
        opts = get_configured_options()
        if opts is None:
            raise RuntimeError(
                "AgentOrchestratorService not configured. "
                "Call configure_agent_orchestrator_plugin(...) before runtime.initialize()."
            )
        return opts

    def _get_active_provider_id(self) -> AgentProviderId:
        opts = self._get_options()
        env_var = opts.active_provider_env_var
        raw = os.environ.get(env_var, "").strip()
        return raw if raw else opts.default_provider_id

    def _get_provider_by_id(self, provider_id: AgentProviderId) -> AgentProvider | None:
        opts = self._get_options()
        for p in opts.providers:
            if p.id == provider_id:
                return p
        return None

    # ========================================================================
    # Current task
    # ========================================================================

    def get_current_task_id(self) -> str | None:
        """Get the current task ID."""
        return self._current_task_id

    def set_current_task(self, task_id: str | None) -> None:
        """Set the current task."""
        self._current_task_id = task_id
        if task_id:
            self._emit(TaskEventType.PROGRESS, task_id, {"selected": True})

    async def get_current_task(self) -> OrchestratedTask | None:
        """Get the current task."""
        if not self._current_task_id:
            return None
        return await self.get_task(self._current_task_id)

    # ========================================================================
    # CRUD
    # ========================================================================

    async def create_task(
        self,
        name: str,
        description: str,
        room_id: str | None = None,
        provider_id: AgentProviderId | None = None,
    ) -> OrchestratedTask:
        """Create a new orchestrated task."""
        opts = self._get_options()
        chosen_provider_id = provider_id or self._get_active_provider_id()
        provider = self._get_provider_by_id(chosen_provider_id)

        if provider is None:
            available = ", ".join(p.id for p in opts.providers)
            raise ValueError(f'Unknown provider "{chosen_provider_id}". Available: {available}')

        world_id = await self._resolve_world_id(room_id)
        working_directory = opts.get_working_directory()

        metadata = OrchestratedTaskMetadata(
            status=TaskStatus.PENDING,
            progress=0,
            output=[],
            steps=[],
            working_directory=working_directory,
            provider_id=provider.id,
            provider_label=provider.label,
            sub_agent_type=provider.id,
            user_status=TaskUserStatus.OPEN,
            user_status_updated_at=_now(),
            files_created=[],
            files_modified=[],
            created_at=_now(),
        )

        task_input = {
            "name": name,
            "description": description,
            "worldId": world_id,
            "tags": ["code", "queue", "orchestrator", "task"],
            "metadata": metadata.to_dict(),
        }
        if room_id:
            task_input["roomId"] = room_id

        task_id = await self.runtime.create_task(task_input)
        task = await self.get_task(task_id)
        if task is None:
            raise RuntimeError("Failed to create task")

        if not self._current_task_id:
            self._current_task_id = task_id

        self._emit(TaskEventType.CREATED, task_id, {"name": task.name, "providerId": provider.id})
        return task

    async def _resolve_world_id(self, room_id: str | None) -> str:
        if room_id:
            room = await self.runtime.get_room(room_id)
            if room and hasattr(room, "world_id") and room.world_id:
                return room.world_id
        return self.runtime.agent_id

    async def get_task(self, task_id: str) -> OrchestratedTask | None:
        """Get a task by ID."""
        t = await self.runtime.get_task(task_id)
        if t is None:
            return None
        return self._to_orchestrated_task(t)

    def _to_orchestrated_task(self, raw: Any) -> OrchestratedTask:
        """Convert runtime task to OrchestratedTask."""
        metadata_raw = getattr(raw, "metadata", {}) or {}
        if isinstance(metadata_raw, dict):
            metadata = OrchestratedTaskMetadata.from_dict(metadata_raw)
        else:
            metadata = metadata_raw

        return OrchestratedTask(
            id=getattr(raw, "id", ""),
            name=getattr(raw, "name", ""),
            description=getattr(raw, "description", ""),
            metadata=metadata,
            tags=getattr(raw, "tags", []),
            room_id=getattr(raw, "room_id", None) or getattr(raw, "roomId", None),
            world_id=getattr(raw, "world_id", None) or getattr(raw, "worldId", None),
        )

    async def get_tasks(self) -> list[OrchestratedTask]:
        """Get all orchestrated tasks."""
        tasks = await self.runtime.get_tasks({"tags": ["orchestrator"]})
        return [self._to_orchestrated_task(t) for t in tasks]

    async def get_recent_tasks(self, limit: int = 20) -> list[OrchestratedTask]:
        """Get recent tasks sorted by creation time."""
        tasks = await self.get_tasks()
        tasks.sort(key=lambda t: t.metadata.created_at or 0, reverse=True)
        return tasks[:limit]

    async def get_tasks_by_status(self, status: TaskStatus) -> list[OrchestratedTask]:
        """Get tasks by status."""
        tasks = await self.get_tasks()
        return [t for t in tasks if t.metadata.status == status]

    async def search_tasks(self, query: str) -> list[OrchestratedTask]:
        """Search tasks by query."""
        q = query.strip().lower()
        if not q:
            return []
        tasks = await self.get_tasks()
        results = []
        for t in tasks:
            task_id = (t.id or "").lower()
            if (
                task_id.startswith(q)
                or q in t.name.lower()
                or q in (t.description or "").lower()
                or any(q in tag.lower() for tag in t.tags)
            ):
                results.append(t)
        return results

    # ========================================================================
    # Updates
    # ========================================================================

    async def update_task_status(self, task_id: str, status: TaskStatus) -> None:
        """Update task status."""
        task = await self.get_task(task_id)
        if task is None:
            return

        metadata = task.metadata
        metadata.status = status

        if status == TaskStatus.RUNNING and metadata.started_at is None:
            metadata.started_at = _now()
        if status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED):
            metadata.completed_at = _now()

        await self.runtime.update_task(task_id, {"metadata": metadata.to_dict()})

        # Map status to event type
        event_map = {
            TaskStatus.RUNNING: TaskEventType.STARTED,
            TaskStatus.COMPLETED: TaskEventType.COMPLETED,
            TaskStatus.FAILED: TaskEventType.FAILED,
            TaskStatus.PAUSED: TaskEventType.PAUSED,
            TaskStatus.CANCELLED: TaskEventType.CANCELLED,
        }
        event_type = event_map.get(status, TaskEventType.PROGRESS)
        self._emit(event_type, task_id, {"status": status.value})

    async def update_task_progress(self, task_id: str, progress: int) -> None:
        """Update task progress."""
        task = await self.get_task(task_id)
        if task is None:
            return

        metadata = task.metadata
        metadata.progress = _clamp_progress(progress)
        await self.runtime.update_task(task_id, {"metadata": metadata.to_dict()})
        self._emit(TaskEventType.PROGRESS, task_id, {"progress": metadata.progress})

    async def append_output(self, task_id: str, output: str) -> None:
        """Append output to task."""
        task = await self.get_task(task_id)
        if task is None:
            return

        lines = [line for line in output.split("\n") if line.strip()]
        metadata = task.metadata
        metadata.output = (metadata.output + lines)[-500:]
        await self.runtime.update_task(task_id, {"metadata": metadata.to_dict()})
        self._emit(TaskEventType.OUTPUT, task_id, {"output": lines})

    async def add_step(self, task_id: str, description: str) -> TaskStep:
        """Add a step to a task."""
        task = await self.get_task(task_id)
        if task is None:
            raise ValueError(f"Task {task_id} not found")

        step = TaskStep.create(description)
        metadata = task.metadata
        metadata.steps.append(step)
        await self.runtime.update_task(task_id, {"metadata": metadata.to_dict()})
        return step

    async def update_step(
        self,
        task_id: str,
        step_id: str,
        status: TaskStatus,
        output: str | None = None,
    ) -> None:
        """Update a step's status."""
        task = await self.get_task(task_id)
        if task is None:
            return

        metadata = task.metadata
        step = next((s for s in metadata.steps if s.id == step_id), None)
        if step is None:
            return

        step.status = status
        if output:
            step.output = output

        total = len(metadata.steps)
        if total > 0:
            completed = sum(1 for s in metadata.steps if s.status == TaskStatus.COMPLETED)
            metadata.progress = _clamp_progress((completed / total) * 100)

        await self.runtime.update_task(task_id, {"metadata": metadata.to_dict()})
        self._emit(TaskEventType.PROGRESS, task_id, {"progress": metadata.progress})

    async def set_task_result(self, task_id: str, result: TaskResult) -> None:
        """Set the task result."""
        task = await self.get_task(task_id)
        if task is None:
            return

        metadata = task.metadata
        metadata.result = result
        metadata.files_created = result.files_created
        metadata.files_modified = result.files_modified

        if metadata.status != TaskStatus.CANCELLED:
            metadata.status = TaskStatus.COMPLETED if result.success else TaskStatus.FAILED
            metadata.completed_at = _now()

        if not result.success and result.error:
            metadata.error = result.error

        await self.runtime.update_task(task_id, {"metadata": metadata.to_dict()})
        event_type = TaskEventType.COMPLETED if result.success else TaskEventType.FAILED
        self._emit(
            event_type,
            task_id,
            {
                "success": result.success,
                "summary": result.summary,
                "error": result.error,
            },
        )

    async def set_task_error(self, task_id: str, error: str) -> None:
        """Set task error."""
        task = await self.get_task(task_id)
        if task is None:
            return

        metadata = task.metadata
        metadata.error = error
        if metadata.status != TaskStatus.CANCELLED:
            metadata.status = TaskStatus.FAILED
            metadata.completed_at = _now()

        await self.runtime.update_task(task_id, {"metadata": metadata.to_dict()})
        event_type = (
            TaskEventType.CANCELLED
            if metadata.status == TaskStatus.CANCELLED
            else TaskEventType.FAILED
        )
        self._emit(event_type, task_id, {"error": error})

    async def set_user_status(self, task_id: str, user_status: TaskUserStatus) -> None:
        """Set user-controlled status."""
        task = await self.get_task(task_id)
        if task is None:
            return

        metadata = task.metadata
        metadata.user_status = user_status
        metadata.user_status_updated_at = _now()
        await self.runtime.update_task(task_id, {"metadata": metadata.to_dict()})
        self._emit(TaskEventType.PROGRESS, task_id, {"userStatus": user_status.value})

    async def set_task_sub_agent_type(self, task_id: str, next_provider_id: str) -> None:
        """Change the provider for a task."""
        task = await self.get_task(task_id)
        if task is None:
            return

        provider = self._get_provider_by_id(next_provider_id)
        metadata = task.metadata
        metadata.provider_id = next_provider_id
        metadata.sub_agent_type = next_provider_id
        metadata.provider_label = (
            provider.label if provider else metadata.provider_label or next_provider_id
        )

        await self.runtime.update_task(task_id, {"metadata": metadata.to_dict()})
        self._emit(TaskEventType.MESSAGE, task_id, {"providerId": next_provider_id})
        await self.append_output(
            task_id, f"Provider: {metadata.provider_label} ({metadata.provider_id})"
        )

    # ========================================================================
    # Control
    # ========================================================================

    async def pause_task(self, task_id: str) -> None:
        """Pause a task."""
        self._set_control(task_id, paused=True)
        await self.update_task_status(task_id, TaskStatus.PAUSED)
        self._emit(TaskEventType.PAUSED, task_id)

    async def resume_task(self, task_id: str) -> None:
        """Resume a paused task."""
        self._set_control(task_id, paused=False)
        await self.update_task_status(task_id, TaskStatus.RUNNING)
        self._emit(TaskEventType.RESUMED, task_id)

    async def cancel_task(self, task_id: str) -> None:
        """Cancel a task."""
        self._set_control(task_id, cancelled=True, paused=False)
        task = await self.get_task(task_id)
        if task is None:
            return

        metadata = task.metadata
        metadata.status = TaskStatus.CANCELLED
        metadata.completed_at = _now()
        metadata.error = metadata.error or "Cancelled by user"
        await self.runtime.update_task(task_id, {"metadata": metadata.to_dict()})
        self._emit(TaskEventType.CANCELLED, task_id, {"status": "cancelled"})

    async def delete_task(self, task_id: str) -> None:
        """Delete a task."""
        self._set_control(task_id, cancelled=True, paused=False)
        await self.runtime.delete_task(task_id)
        if self._current_task_id == task_id:
            self._current_task_id = None
        self._emit(TaskEventType.MESSAGE, task_id, {"deleted": True})

    def is_task_cancelled(self, task_id: str) -> bool:
        """Check if task is cancelled."""
        state = self._control_states.get(task_id)
        return state.cancelled if state else False

    def is_task_paused(self, task_id: str) -> bool:
        """Check if task is paused."""
        state = self._control_states.get(task_id)
        return state.paused if state else False

    def _set_control(
        self,
        task_id: str,
        cancelled: bool | None = None,
        paused: bool | None = None,
    ) -> None:
        state = self._control_states.get(task_id)
        if state is None:
            state = ControlState()
            self._control_states[task_id] = state
        if cancelled is not None:
            state.cancelled = cancelled
        if paused is not None:
            state.paused = paused

    def _clear_control(self, task_id: str) -> None:
        self._control_states.pop(task_id, None)

    # ========================================================================
    # Execution
    # ========================================================================

    def start_task_execution(self, task_id: str) -> asyncio.Task[None]:
        """Start task execution in background."""
        existing = self._executions.get(task_id)
        if existing and not existing.done():
            return existing

        async def run_and_cleanup() -> None:
            try:
                await self._run_task_execution(task_id)
            finally:
                self._executions.pop(task_id, None)

        task = asyncio.create_task(run_and_cleanup())
        self._executions[task_id] = task
        return task

    async def detect_and_pause_interrupted_tasks(self) -> list[OrchestratedTask]:
        """Pause tasks that were left running after a restart."""
        running = await self.get_tasks_by_status(TaskStatus.RUNNING)
        candidates = [t for t in running if t.metadata.user_status != TaskUserStatus.DONE]

        paused: list[OrchestratedTask] = []
        for t in candidates:
            if not t.id:
                continue
            await self.pause_task(t.id)
            await self.append_output(t.id, "Paused due to restart.")
            updated = await self.get_task(t.id)
            if updated:
                paused.append(updated)
        return paused

    async def create_code_task(
        self,
        name: str,
        description: str,
        room_id: str | None = None,
        sub_agent_type: str = "eliza",
    ) -> OrchestratedTask:
        """Compatibility alias for create_task."""
        return await self.create_task(name, description, room_id, sub_agent_type)

    async def _run_task_execution(self, task_id: str) -> None:
        """Run task execution."""
        try:
            task = await self.get_task(task_id)
            if task is None:
                return

            self._clear_control(task_id)
            self._set_control(task_id, cancelled=False, paused=False)

            provider = self._get_provider_by_id(task.metadata.provider_id)
            if provider is None:
                raise ValueError(f"Provider not found: {task.metadata.provider_id}")

            await self.update_task_status(task_id, TaskStatus.RUNNING)
            await self.append_output(
                task_id, f"Starting: {task.name}\nProvider: {provider.label} ({provider.id})"
            )

            ctx = ProviderTaskExecutionContext(
                runtime_agent_id=self.runtime.agent_id,
                working_directory=task.metadata.working_directory,
                append_output=lambda line: self.append_output(task_id, line),
                update_progress=lambda p: self.update_task_progress(task_id, p),
                update_step=lambda sid, status, out: self.update_step(task_id, sid, status, out),
                is_cancelled=lambda: self.is_task_cancelled(task_id),
                is_paused=lambda: self.is_task_paused(task_id),
                room_id=task.room_id,
                world_id=task.world_id,
            )

            result = await provider.execute_task(task, ctx)
            await self.set_task_result(task_id, result)

        except Exception as e:
            await self.set_task_error(task_id, str(e))
        finally:
            self._clear_control(task_id)

    # ========================================================================
    # Events
    # ========================================================================

    def on(self, event: str, handler: Callable[[TaskEvent], None]) -> None:
        """Register an event handler."""
        if event not in self._event_handlers:
            self._event_handlers[event] = []
        self._event_handlers[event].append(handler)

    def off(self, event: str, handler: Callable[[TaskEvent], None]) -> None:
        """Remove an event handler."""
        if event in self._event_handlers:
            self._event_handlers[event] = [h for h in self._event_handlers[event] if h != handler]

    def _emit(
        self,
        event_type: TaskEventType,
        task_id: str,
        data: dict[str, JsonValue] | None = None,
    ) -> None:
        event = TaskEvent(type=event_type, task_id=task_id, data=data)
        for handler in self._event_handlers.get(event_type.value, []):
            handler(event)
        for handler in self._event_handlers.get("task", []):
            handler(event)

    # ========================================================================
    # Context
    # ========================================================================

    async def get_task_context(self) -> str:
        """Get task context for prompting."""
        current = await self.get_current_task()
        tasks = await self.get_recent_tasks(10)

        if not tasks:
            return "No tasks have been created yet."

        lines: list[str] = []
        active = current or (tasks[0] if tasks else None)

        if active:
            m = active.metadata
            lines.append(f"## Current Task (selected): {active.name}")
            lines.append(f"- **Execution status**: {m.status.value}")
            lines.append(f"- **Progress**: {m.progress}%")
            lines.append(f"- **Provider**: {m.provider_label or m.provider_id}")
            lines.append("")

            if active.description:
                lines.append("### Description")
                lines.append(active.description)
                lines.append("")

            if m.steps:
                lines.append("### Plan / Steps")
                for s in m.steps:
                    lines.append(f"- [{s.status.value}] {s.description}")
                lines.append("")

            if m.output:
                lines.append("### Task Output (history)")
                lines.append("```")
                lines.extend(m.output[-200:])
                lines.append("```")
                lines.append("")

        return "\n".join(lines).strip()
