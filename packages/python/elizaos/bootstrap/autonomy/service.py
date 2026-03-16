"""Autonomy service using the Task system (TypeScript parity).

This service registers an `AUTONOMY_THINK` task worker and creates a recurring
task that triggers autonomous thinking at a configurable interval.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from typing import TYPE_CHECKING, Any

from elizaos.prompts import (
    AUTONOMY_CONTINUOUS_CONTINUE_TEMPLATE,
    AUTONOMY_CONTINUOUS_FIRST_TEMPLATE,
    AUTONOMY_TASK_CONTINUE_TEMPLATE,
    AUTONOMY_TASK_FIRST_TEMPLATE,
)
from elizaos.types.environment import Room, World
from elizaos.types.events import EventType
from elizaos.types.memory import Memory
from elizaos.types.primitives import UUID, Content, as_uuid
from elizaos.types.service import Service
from elizaos.bootstrap.services.task import Task, TaskMetadata

from .types import AutonomyStatus

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

_logger = logging.getLogger(__name__)

# Service type constant for autonomy (parity with TypeScript)
AUTONOMY_SERVICE_TYPE = "AUTONOMY"

# Task name for autonomy thinking (parity with TypeScript)
AUTONOMY_TASK_NAME = "AUTONOMY_THINK"

# Tags used for autonomy tasks (parity with TypeScript).
# Note: TypeScript uses ["repeat", "autonomy", "internal"] without "queue".
AUTONOMY_TASK_TAGS = ["repeat", "autonomy", "internal"]

# Default interval in milliseconds
DEFAULT_INTERVAL_MS = 30_000


class AutonomyTaskWorker:
    """Task worker for autonomous thinking."""

    def __init__(self, service: AutonomyService) -> None:
        self._service = service

    @property
    def name(self) -> str:
        return AUTONOMY_TASK_NAME

    async def execute(
        self,
        runtime: IAgentRuntime,
        options: dict[str, Any],
        task: Task,
    ) -> None:
        """Execute the autonomy task."""
        start_time = time.time()

        self._service._log(
            "debug",
            f"Executing autonomy task (task_id={task.id})",
        )

        try:
            await self._service.perform_autonomous_think()
            duration_ms = int((time.time() - start_time) * 1000)
            self._service._log(
                "debug",
                f"Autonomy task completed successfully (duration={duration_ms}ms)",
            )
        except Exception as e:
            duration_ms = int((time.time() - start_time) * 1000)
            self._service._log(
                "error",
                f"Autonomy task failed: {e} (duration={duration_ms}ms)",
            )
            raise

    async def validate(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: Any,
    ) -> bool:
        """Validate the task (always returns True)."""
        return True


class AutonomyService(Service):
    """Autonomy service using the Task system.

    Provides parity with TypeScript's AutonomyService.
    """

    service_type = AUTONOMY_SERVICE_TYPE

    def __init__(self) -> None:
        self._runtime: IAgentRuntime | None = None
        self._is_running = False
        self._is_thinking = False
        self._is_stopped = False
        self._interval_ms = DEFAULT_INTERVAL_MS
        self._task_registered = False
        self._settings_monitor_task: asyncio.Task[None] | None = None
        self._autonomous_room_id = as_uuid(str(uuid.uuid4()))
        self._autonomous_world_id = as_uuid("00000000-0000-0000-0000-000000000001")

    def _log(self, level: str, msg: str) -> None:
        if self._runtime:
            agent_id = str(self._runtime.agent_id)
            full_msg = f"[autonomy] {msg} (agent={agent_id})"
            getattr(self._runtime.logger, level)(full_msg)
        else:
            getattr(_logger, level)(f"[autonomy] {msg}")

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> AutonomyService:
        """Start the autonomy service."""
        service = cls()
        service._runtime = runtime
        await service._initialize()
        return service

    async def _initialize(self) -> None:
        if not self._runtime:
            return

        self._log("info", f"Using autonomous room ID: {self._autonomous_room_id}")

        # Ensure autonomous context exists
        await self._ensure_autonomous_context()

        # Register the task worker
        await self._register_autonomy_task_worker()

        autonomy_enabled = self._is_autonomy_enabled()

        self._log(
            "debug",
            f"Autonomy enabled (setting or runtime): {autonomy_enabled}",
        )

        # Check if autonomy should auto-start based on runtime configuration
        if autonomy_enabled:
            self._log(
                "info",
                "Autonomy enabled (enable_autonomy: True), creating autonomy task...",
            )
            await self._create_autonomy_task()
        else:
            self._log(
                "info",
                "Autonomy not enabled (enable_autonomy: False or not set). "
                "Set enable_autonomy=True in runtime options to auto-start.",
            )

        # Start settings monitoring
        self._settings_monitor_task = asyncio.create_task(self._settings_monitoring())

    async def _register_autonomy_task_worker(self) -> None:
        """Register the task worker for autonomous thinking."""
        if self._task_registered or not self._runtime:
            return

        worker = AutonomyTaskWorker(self)
        self._runtime.register_task_worker(worker)
        self._task_registered = True

        self._log("debug", "Registered autonomy task worker")

    async def _create_autonomy_task(self) -> None:
        """Create the recurring autonomy task."""
        if not self._runtime:
            return

        # Remove any existing autonomy tasks
        await self._remove_autonomy_task()

        # Create the recurring task
        task = Task.repeating(AUTONOMY_TASK_NAME, self._interval_ms)
        task.description = f"Autonomous thinking for agent {self._runtime.agent_id}"
        task.world_id = self._autonomous_world_id
        task.room_id = self._autonomous_room_id
        task.tags = AUTONOMY_TASK_TAGS.copy()

        # Ensure metadata has blocking = true
        if task.metadata:
            task.metadata.blocking = True

        await self._runtime.create_task(task)

        self._is_running = True
        self._runtime.enable_autonomy = True

        self._log(
            "info",
            f"Created autonomy task (interval={self._interval_ms}ms)",
        )

    async def _remove_autonomy_task(self) -> None:
        """Remove existing autonomy tasks.

        Uses full AUTONOMY_TASK_TAGS for filtering (parity with TypeScript).
        """
        if not self._runtime:
            return

        try:
            existing_tasks = await self._runtime.get_tasks({
                "tags": list(AUTONOMY_TASK_TAGS),
            })

            for task in existing_tasks:
                task_name = getattr(task, "name", None) or task.get("name") if isinstance(task, dict) else None
                task_id = getattr(task, "id", None) or task.get("id") if isinstance(task, dict) else None

                if task_name == AUTONOMY_TASK_NAME and task_id:
                    await self._runtime.delete_task(task_id)
                    self._log("debug", f"Removed existing autonomy task (id={task_id})")
        except Exception as e:
            self._log("debug", f"Error removing autonomy tasks: {e}")

    async def _ensure_autonomous_context(self) -> None:
        if not self._runtime:
            return

        try:
            world = World(
                id=self._autonomous_world_id,
                name="Autonomy World",
                agent_id=self._runtime.agent_id,
                message_server_id=as_uuid("00000000-0000-0000-0000-000000000000"),
            )
            await self._runtime.ensure_world_exists(world)

            room = Room(
                id=self._autonomous_room_id,
                name="Autonomous Thoughts",
                world_id=self._autonomous_world_id,
                source="autonomy-service",
                type="SELF",
            )
            await self._runtime.ensure_room_exists(room)

            await self._runtime.add_participant(self._runtime.agent_id, self._autonomous_room_id)

            self._log(
                "debug",
                f"Ensured autonomous room exists with world ID: {self._autonomous_world_id}",
            )
        except Exception as e:
            self._log("error", f"Failed to ensure autonomous context: {e}")
            raise

    def _get_autonomy_mode(self) -> str:
        if not self._runtime:
            return "continuous"
        raw = self._runtime.get_setting("AUTONOMY_MODE")
        if isinstance(raw, str) and raw.strip().lower() == "task":
            return "task"
        return "continuous"

    def _get_target_room_id(self) -> UUID | None:
        if not self._runtime:
            return None
        raw = self._runtime.get_setting("AUTONOMY_TARGET_ROOM_ID")
        if not isinstance(raw, str) or raw.strip() == "":
            return None
        try:
            return as_uuid(raw.strip())
        except Exception:
            return None

    async def _get_target_room_context_text(self) -> str:
        if not self._runtime:
            return "(no target room configured)"
        target_room_id = self._get_target_room_id()
        if not target_room_id:
            return "(no target room configured)"
        memories_table = await self._runtime.get_memories(
            {"roomId": target_room_id, "count": 15, "tableName": "memories"}
        )
        messages_table = await self._runtime.get_memories(
            {"roomId": target_room_id, "count": 15, "tableName": "messages"}
        )
        by_id: dict[str, Memory] = {}
        for m in [*memories_table, *messages_table]:
            mem_id = m.id or ""
            if not mem_id:
                continue
            created_at = m.created_at or 0
            existing = by_id.get(mem_id)
            if existing is None or created_at < (existing.created_at or 0):
                by_id[mem_id] = m
        ordered = sorted(by_id.values(), key=lambda m: m.created_at or 0)
        lines: list[str] = []
        for m in ordered:
            role = "Agent" if m.entity_id == self._runtime.agent_id else "User"
            text = m.content.text if m.content and isinstance(m.content.text, str) else ""
            if text.strip():
                lines.append(f"{role}: {text}")
        return "\n".join(lines) if lines else "(no recent messages)"

    async def _settings_monitoring(self) -> None:
        while not self._is_stopped:
            await asyncio.sleep(10)

            if not self._runtime or self._is_stopped:
                break

            try:
                should_be_running = self._is_autonomy_enabled()

                if should_be_running and not self._is_running:
                    self._log("info", "Runtime indicates autonomy should be enabled, creating task...")
                    await self._create_autonomy_task()
                elif not should_be_running and self._is_running:
                    self._log("info", "Runtime indicates autonomy should be disabled, removing task...")
                    await self._remove_autonomy_task()
                    self._is_running = False
            except Exception as e:
                self._log("error", f"Error in settings monitoring: {e}")

    async def perform_autonomous_think(self) -> None:
        """Perform one iteration of autonomous thinking.

        This is called by the task worker when the task executes.
        """
        if not self._runtime:
            return

        # Guard against overlapping think cycles
        if self._is_thinking:
            self._log(
                "debug",
                "Previous autonomous think still in progress, skipping this iteration",
            )
            return

        self._is_thinking = True
        try:
            await self._do_think()
        except Exception as e:
            self._log("error", f"Error in autonomous think: {e}")
        finally:
            self._is_thinking = False

    async def _do_think(self) -> None:
        """Execute the actual thinking logic."""
        if not self._runtime:
            return

        self._log("debug", "Performing autonomous thinking...")

        agent_entity = await self._runtime.get_entity_by_id(self._runtime.agent_id)
        if not agent_entity:
            self._log("error", "Failed to get agent entity, skipping autonomous thought")
            return

        last_thought: str | None = None
        is_first_thought = False

        recent_memories = await self._runtime.get_memories(
            {
                "roomId": self._autonomous_room_id,
                "count": 3,
                "tableName": "memories",
            }
        )

        last_agent_thought = None
        last_created_at = None
        for m in recent_memories:
            if m.entity_id == agent_entity.id and m.content and m.content.text:
                created_at = m.created_at or 0
                if last_created_at is None or created_at > last_created_at:
                    last_created_at = created_at
                    last_agent_thought = m

        if last_agent_thought and last_agent_thought.content and last_agent_thought.content.text:
            last_thought = last_agent_thought.content.text
        else:
            is_first_thought = True

        mode = self._get_autonomy_mode()
        target_context = await self._get_target_room_context_text()
        autonomy_prompt = (
            self._create_task_prompt(last_thought, is_first_thought, target_context)
            if mode == "task"
            else self._create_continuous_prompt(last_thought, is_first_thought, target_context)
        )

        entity_id = agent_entity.id if agent_entity.id else self._runtime.agent_id
        current_time_ms = int(time.time() * 1000)
        autonomous_message = Memory(
            id=as_uuid(str(uuid.uuid4())),
            entity_id=as_uuid(str(entity_id)),
            content=Content(
                text=autonomy_prompt,
                source="autonomy-service",
            ),
            room_id=self._autonomous_room_id,
            agent_id=self._runtime.agent_id,
            created_at=current_time_ms,
        )

        self._log(
            "debug",
            "Processing through Eliza agent pipeline (providers, actions, evaluators)...",
        )

        async def callback(content: Content) -> None:
            if self._runtime:
                self._log("debug", f"Response generated: {(content.text or '')[:100]}...")

        await self._runtime.emit_event(
            EventType.EVENT_TYPE_MESSAGE_RECEIVED,
            {
                "runtime": self._runtime,
                "message": autonomous_message,
                "callback": callback,
                "source": "autonomy-service",
            },
        )

        self._log("debug", "Autonomous message event emitted to agent pipeline")

    def _create_continuous_prompt(
        self, last_thought: str | None, is_first_thought: bool, target_context: str
    ) -> str:
        template = (
            AUTONOMY_CONTINUOUS_FIRST_TEMPLATE
            if is_first_thought
            else AUTONOMY_CONTINUOUS_CONTINUE_TEMPLATE
        )
        return self._fill_autonomy_template(template, target_context, last_thought)

    def _create_task_prompt(
        self, last_thought: str | None, is_first_thought: bool, target_context: str
    ) -> str:
        template = (
            AUTONOMY_TASK_FIRST_TEMPLATE if is_first_thought else AUTONOMY_TASK_CONTINUE_TEMPLATE
        )
        return self._fill_autonomy_template(template, target_context, last_thought)

    def _fill_autonomy_template(
        self, template: str, target_context: str, last_thought: str | None
    ) -> str:
        output = template.replace("{{targetRoomContext}}", target_context)
        output = output.replace("{{lastThought}}", last_thought or "")
        return output

    def is_thinking_in_progress(self) -> bool:
        return self._is_thinking

    def is_loop_running(self) -> bool:
        return self._is_running

    def get_loop_interval(self) -> int:
        return self._interval_ms

    async def set_loop_interval(self, ms: int) -> None:
        """Set loop interval (recreates the task with new interval if running).

        Parity with TypeScript's setLoopInterval.
        """
        MIN_INTERVAL = 5000
        MAX_INTERVAL = 600000

        if ms < MIN_INTERVAL:
            self._log("warning", f"Interval too short, minimum is {MIN_INTERVAL}ms")
            ms = MIN_INTERVAL
        if ms > MAX_INTERVAL:
            self._log("warning", f"Interval too long, maximum is {MAX_INTERVAL}ms")
            ms = MAX_INTERVAL

        self._interval_ms = ms
        self._log("info", f"Loop interval set to {ms}ms")

        # Recreate the task if running (parity with TypeScript)
        if self._is_running:
            await self._create_autonomy_task()

    def get_autonomous_room_id(self) -> UUID:
        return self._autonomous_room_id

    async def enable_autonomy(self) -> None:
        """Enable autonomy by creating the task."""
        if self._runtime:
            self._runtime.enable_autonomy = True
        await self._create_autonomy_task()

    async def disable_autonomy(self) -> None:
        """Disable autonomy by removing the task."""
        if self._runtime:
            self._runtime.enable_autonomy = False
        await self._remove_autonomy_task()
        self._is_running = False

    def get_status(self) -> AutonomyStatus:
        enabled = self._is_autonomy_enabled()

        return AutonomyStatus(
            enabled=enabled,
            running=self._is_running,
            thinking=self._is_thinking,
            interval=self._interval_ms,
            autonomous_room_id=str(self._autonomous_room_id),
        )

    async def stop(self) -> None:
        """Stop the autonomy service."""
        self._is_stopped = True

        # Remove the autonomy task
        await self._remove_autonomy_task()
        self._is_running = False

        if self._settings_monitor_task:
            self._settings_monitor_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._settings_monitor_task
            self._settings_monitor_task = None

        self._log("info", "Autonomy service stopped")

    @property
    def capability_description(self) -> str:
        return "Autonomous operation using the Task system for continuous agent thinking and actions"

    def _is_autonomy_enabled(self) -> bool:
        if not self._runtime:
            return False
        setting_value = self._runtime.get_setting("AUTONOMY_ENABLED")
        setting_enabled = setting_value is True or (
            isinstance(setting_value, str) and setting_value.strip().lower() == "true"
        )
        return setting_enabled or self._runtime.enable_autonomy is True
