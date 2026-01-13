from __future__ import annotations

import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar, Literal

from elizaos.types.service import Service

from elizaos_plugin_trajectory_logger.export import (
    ExportOptions,
    ExportResult,
    export_for_openpipe_art,
    export_grouped_for_grpo,
)
from elizaos_plugin_trajectory_logger.service import (
    TrajectoryLoggerService as InMemoryTrajectoryLogger,
)
from elizaos_plugin_trajectory_logger.types import (
    ActionAttempt,
    EnvironmentState,
    LLMCall,
    ProviderAccess,
    RewardComponents,
    Trajectory,
)

JsonScalar = str | int | float | bool | None
FinalStatus = Literal["completed", "terminated", "error", "timeout"]
ExportFormat = Literal["art", "grpo"]

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime


@dataclass(frozen=True)
class TrajectoryExportConfig:
    dataset_name: str = "trajectories"
    export_format: ExportFormat = "art"
    output_dir: str | None = None
    max_trajectories: int | None = None


def _as_json_scalar(value: object) -> JsonScalar:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value if not isinstance(value, str) else value[:2000]
    return str(value)[:2000]


def _as_json_dict(data: Mapping[str, object] | None) -> dict[str, object]:
    if not data:
        return {}
    out: dict[str, object] = {}
    for k, v in data.items():
        out[k] = _as_json_scalar(v)
    return out


class TrajectoryLoggerRuntimeService(Service):
    """ElizaOS runtime service wrapper for plugin-trajectory-logger.

    The Eliza runtime and message service optionally look for a service named
    `"trajectory_logger"` and call methods like `log_llm_call(...)` and
    `log_provider_access(...)` (keyword-args form). This adapter:

    - Implements those methods in the runtime-expected shape
    - Converts calls into strongly-typed plugin-trajectory-logger models
    - Stores trajectories in-memory for later export to ART/GRPO
    """

    service_type: ClassVar[str] = "trajectory_logger"

    def __init__(self) -> None:
        super().__init__(runtime=None)
        self._logger = InMemoryTrajectoryLogger()

    @property
    def capability_description(self) -> str:
        return "Captures end-to-end agent trajectories for training and benchmarking."

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> TrajectoryLoggerRuntimeService:
        svc = cls()
        svc.runtime = runtime
        return svc

    async def stop(self) -> None:
        # Nothing to stop; in-memory only.
        return

    # ---------------------------------------------------------------------
    # Trajectory lifecycle
    # ---------------------------------------------------------------------

    def start_trajectory(
        self,
        *,
        agent_id: str,
        scenario_id: str | None = None,
        episode_id: str | None = None,
        batch_id: str | None = None,
        group_index: int | None = None,
        metadata: dict[str, object] | None = None,
    ) -> str:
        return self._logger.start_trajectory(
            agent_id=agent_id,
            scenario_id=scenario_id,
            episode_id=episode_id,
            batch_id=batch_id,
            group_index=group_index,
            metadata=metadata,
        )

    def start_step(
        self,
        trajectory_id: str,
        *,
        # Canonical runtime integration shape (used by AgentBench harness)
        timestamp_ms: int | None = None,
        agent_balance: float = 0.0,
        agent_points: float = 0.0,
        agent_pnl: float = 0.0,
        open_positions: int = 0,
        custom: dict[str, JsonScalar] | None = None,
        # Back-compat: allow passing a raw env_state dict (used by context-bench helpers)
        env_state: dict[str, object] | None = None,
    ) -> str:
        now_ms = int(time.time() * 1000)

        if env_state is not None:
            # Treat env_state as an arbitrary custom payload; extract timestamp if present.
            ts = env_state.get("timestamp")
            timestamp = int(ts) if isinstance(ts, int) else now_ms
            state = EnvironmentState(
                timestamp=timestamp,
                agent_balance=0.0,
                agent_points=0.0,
                agent_pnl=0.0,
                open_positions=0,
                custom=env_state,
            )
            return self._logger.start_step(trajectory_id, state)

        state = EnvironmentState(
            timestamp=timestamp_ms or now_ms,
            agent_balance=agent_balance,
            agent_points=agent_points,
            agent_pnl=agent_pnl,
            open_positions=open_positions,
            custom=dict(custom) if custom else None,
        )
        return self._logger.start_step(trajectory_id, state)

    async def end_trajectory(
        self,
        trajectory_id: str,
        status: FinalStatus,
        final_metrics: Mapping[str, object] | None = None,
    ) -> None:
        await self._logger.end_trajectory(
            trajectory_id,
            status=status,
            final_metrics=_as_json_dict(final_metrics),
        )

    def get_active_trajectory(self, trajectory_id: str) -> Trajectory | None:
        return self._logger.get_active_trajectory(trajectory_id)

    def get_all_trajectories(self) -> list[Trajectory]:
        return self._logger.get_all_trajectories()

    def export(self, config: TrajectoryExportConfig) -> ExportResult:
        options = ExportOptions(
            dataset_name=config.dataset_name,
            trajectories=self.get_all_trajectories(),
            max_trajectories=config.max_trajectories,
            output_dir=config.output_dir,
        )
        if config.export_format == "grpo":
            return export_grouped_for_grpo(options)
        return export_for_openpipe_art(options)

    # ---------------------------------------------------------------------
    # Runtime hook methods (keyword-only) used by runtime/message service
    # ---------------------------------------------------------------------

    def log_llm_call(
        self,
        *,
        step_id: str,
        model: str,
        system_prompt: str,
        user_prompt: str,
        response: str,
        temperature: float,
        max_tokens: int,
        purpose: str,
        action_type: str | None = None,
        latency_ms: int | None = None,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        reasoning: str | None = None,
        messages: list[dict[str, object]] | None = None,
    ) -> None:
        now_ms = int(time.time() * 1000)
        call = LLMCall(
            call_id=str(uuid.uuid4()),
            timestamp=now_ms,
            model=model,
            model_version=None,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            messages=None,
            response=response,
            reasoning=reasoning,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=None,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            latency_ms=latency_ms,
            purpose="action",
            action_type=action_type,
        )
        self._logger.log_llm_call(step_id, call)

    def log_provider_access(
        self,
        *,
        step_id: str,
        provider_name: str,
        data: dict[str, str | int | float | bool | None],
        purpose: str,
        query: dict[str, str | int | float | bool | None] | None = None,
    ) -> None:
        access = ProviderAccess(
            provider_id=str(uuid.uuid4()),
            provider_name=provider_name,
            timestamp=int(time.time() * 1000),
            query=None if query is None else _as_json_dict(query),
            data=_as_json_dict(data),
            purpose=purpose,
        )
        self._logger.log_provider_access(step_id, access)

    def complete_step(
        self,
        *,
        trajectory_id: str,
        step_id: str,
        action_type: str,
        action_name: str,
        parameters: dict[str, object],
        success: bool,
        reward: float | None = None,
        done: bool = False,
        error: str | None = None,
        result: dict[str, object] | None = None,
        reasoning: str | None = None,
    ) -> None:
        attempt = ActionAttempt(
            attempt_id=str(uuid.uuid4()),
            timestamp=int(time.time() * 1000),
            action_type=action_type,
            action_name=action_name,
            parameters=parameters,
            reasoning=reasoning,
            llm_call_id=None,
            success=success,
            result=result,
            error=error,
            immediate_reward=None,
        )
        self._logger.complete_step(
            trajectory_id,
            step_id,
            action=attempt,
            reward=reward,
            components=RewardComponents(environment_reward=0.0),
        )
        _ = done
