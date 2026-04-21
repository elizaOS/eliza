"""Trajectory logger service adapter for SWE-bench.

This bridges the standalone `elizaos_plugin_trajectory_logger.TrajectoryLoggerService`
into the ElizaOS runtime service registry under the canonical service key:
`trajectory_logger`.

That lets core runtime code log:
- provider accesses (via `AgentRuntime.compose_state`)
- model calls (via `AgentRuntime.use_model`)

…as long as `Memory.metadata.trajectoryStepId` is set on the message being processed.
"""

from __future__ import annotations

import time
import uuid
from typing import ClassVar, TypeAlias

from elizaos.types.service import Service

# Keep JsonValue simple/non-recursive for typing + Pydantic schema stability.
JsonValue: TypeAlias = object

try:
    from elizaos_plugin_trajectory_logger import TrajectoryLoggerService as _RawTrajectoryLogger
    from elizaos_plugin_trajectory_logger.types import (
        ActionAttempt,
        EnvironmentState,
        FinalStatus,
        LLMCall,
        ProviderAccess,
        RewardComponents,
        Trajectory,
    )

    TRAJECTORY_LOGGER_AVAILABLE = True
except ImportError:  # pragma: no cover
    TRAJECTORY_LOGGER_AVAILABLE = False
    _RawTrajectoryLogger = None  # type: ignore[misc, assignment]
    ActionAttempt = None  # type: ignore[misc, assignment]
    EnvironmentState = None  # type: ignore[misc, assignment]
    FinalStatus = None  # type: ignore[misc, assignment]
    LLMCall = None  # type: ignore[misc, assignment]
    ProviderAccess = None  # type: ignore[misc, assignment]
    RewardComponents = None  # type: ignore[misc, assignment]
    Trajectory = None  # type: ignore[misc, assignment]


class TrajectoryLoggerAdapterService(Service):
    """Runtime Service adapter around TrajectoryLoggerService."""

    service_type: ClassVar[str] = "trajectory_logger"
    _shared_logger: ClassVar[_RawTrajectoryLogger | None] = None

    def __init__(self, logger: _RawTrajectoryLogger) -> None:
        super().__init__()
        self._logger = logger

    @property
    def capability_description(self) -> str:
        return "Trajectory logger (provider/model/action trace capture)"

    @classmethod
    def set_shared_logger(cls, logger: _RawTrajectoryLogger) -> None:
        cls._shared_logger = logger

    @classmethod
    async def start(cls, runtime):  # type: ignore[override]
        _ = runtime
        if not TRAJECTORY_LOGGER_AVAILABLE:
            raise RuntimeError("Trajectory logger plugin not installed")
        if cls._shared_logger is None:
            cls._shared_logger = _RawTrajectoryLogger()
        return cls(cls._shared_logger)

    async def stop(self) -> None:
        # No-op: in-memory logger.
        return None

    # ---------------------------------------------------------------------
    # High-level episode/step API (used by SWE-bench harness)
    # ---------------------------------------------------------------------

    def start_trajectory(
        self,
        agent_id: str,
        *,
        scenario_id: str | None = None,
        episode_id: str | None = None,
        batch_id: str | None = None,
        group_index: int | None = None,
        metadata: dict[str, JsonValue] | None = None,
    ) -> str:
        return self._logger.start_trajectory(
            agent_id=agent_id,
            scenario_id=scenario_id,
            episode_id=episode_id,
            batch_id=batch_id,
            group_index=group_index,
            metadata=metadata,
        )

    def start_step(self, trajectory_id: str, env_state: EnvironmentState) -> str:
        return self._logger.start_step(trajectory_id, env_state)

    def complete_step(
        self,
        trajectory_id: str,
        step_id: str,
        *,
        action: ActionAttempt,
        reward: float | None = None,
        components: RewardComponents | None = None,
        done: bool = False,
    ) -> None:
        self._logger.complete_step(
            trajectory_id,
            step_id,
            action=action,
            reward=reward,
            components=components,
        )
        traj = self._logger.get_active_trajectory(trajectory_id)
        if traj:
            step = next((s for s in traj.steps if s.step_id == step_id), None)
            if step:
                step.done = bool(done)

    async def end_trajectory(
        self,
        trajectory_id: str,
        status: FinalStatus,
        final_metrics: dict[str, JsonValue] | None = None,
    ) -> None:
        await self._logger.end_trajectory(trajectory_id, status, final_metrics=final_metrics)
        # Ensure the final step is marked done for training exports.
        traj = self._logger.get_active_trajectory(trajectory_id)
        if traj and traj.steps:
            traj.steps[-1].done = True

    def get_active_trajectory(self, trajectory_id: str) -> Trajectory | None:
        return self._logger.get_active_trajectory(trajectory_id)

    # ---------------------------------------------------------------------
    # Canonical runtime hook API (used by runtime/message service)
    # ---------------------------------------------------------------------

    def log_llm_call(
        self,
        *,
        step_id: str,
        model: str,
        system_prompt: str,
        user_prompt: str,
        response: str,
        purpose: str,
        action_type: str | None = None,
        model_version: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        top_p: float | None = None,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        latency_ms: int | None = None,
        reasoning: str | None = None,
    ) -> str:
        now_ms = int(time.time() * 1000)
        call_id = str(uuid.uuid4())
        llm_call = LLMCall(
            call_id=call_id,
            timestamp=now_ms,
            model=model,
            model_version=model_version,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            response=response,
            reasoning=reasoning,
            temperature=float(temperature),
            max_tokens=int(max_tokens),
            top_p=float(top_p) if isinstance(top_p, (int, float)) else None,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            latency_ms=latency_ms,
            purpose=purpose,  # type: ignore[arg-type]
            action_type=action_type,
        )
        self._logger.log_llm_call(step_id, llm_call)
        return call_id

    def log_provider_access(
        self,
        *,
        step_id: str,
        provider_name: str,
        data: dict[str, str | int | float | bool | None],
        purpose: str,
        query: dict[str, str | int | float | bool | None] | None = None,
    ) -> None:
        now_ms = int(time.time() * 1000)
        query_obj: dict[str, object] | None = None
        if query is not None:
            query_obj = {k: v for k, v in query.items()}
        data_obj: dict[str, object] = {k: v for k, v in data.items()}
        access = ProviderAccess(
            provider_id=str(provider_name).lower(),
            provider_name=provider_name,
            timestamp=now_ms,
            query=query_obj,
            data=data_obj,
            purpose=purpose,
        )
        self._logger.log_provider_access(step_id, access)

