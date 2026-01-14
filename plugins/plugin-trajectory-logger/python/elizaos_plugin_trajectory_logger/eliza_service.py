from __future__ import annotations

import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from elizaos.types.service import Service

from elizaos_plugin_trajectory_logger.export import (
    ExportOptions,
    ExportResult,
    export_for_openpipe_art,
    export_grouped_for_grpo,
)
from elizaos_plugin_trajectory_logger.service import TrajectoryLoggerService as _InMemoryLogger
from elizaos_plugin_trajectory_logger.types import (
    ActionAttempt,
    EnvironmentState,
    FinalStatus,
    LLMCall,
    LLMPurpose,
    ProviderAccess,
    RewardComponents,
    Trajectory,
)

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime


JsonScalar = str | int | float | bool | None
JsonDict = dict[str, JsonScalar]

TRAJECTORY_LOGGER_SERVICE_TYPE: str = "trajectory_logger"
TrajectoryExportFormat = Literal["art", "grpo"]

_PURPOSE_MAP: dict[str, LLMPurpose] = {
    "action": "action",
    "reasoning": "reasoning",
    "evaluation": "evaluation",
    "response": "response",
    "other": "other",
}


def _normalize_purpose(value: str) -> LLMPurpose:
    return _PURPOSE_MAP.get(value, "other")


def _as_object_dict(data: Mapping[str, JsonScalar] | None) -> dict[str, object] | None:
    if data is None:
        return None
    out: dict[str, object] = {}
    for k, v in data.items():
        out[k] = v
    return out


def _as_object_dict_required(data: Mapping[str, JsonScalar]) -> dict[str, object]:
    out: dict[str, object] = {}
    for k, v in data.items():
        out[k] = v
    return out


@dataclass(frozen=True)
class TrajectoryExportConfig:
    dataset_name: str = "trajectories"
    export_format: TrajectoryExportFormat = "art"
    output_dir: str | None = None
    max_trajectories: int | None = None


class TrajectoryLoggerElizaService(Service):
    """
    ElizaOS Service wrapper around the python TrajectoryLoggerService.

    This allows core runtime components (message_service, compose_state, actions)
    to log trajectories end-to-end without importing plugin-specific model types.
    """

    service_type = TRAJECTORY_LOGGER_SERVICE_TYPE

    def __init__(self, runtime: IAgentRuntime | None = None) -> None:
        super().__init__(runtime)
        self._logger = _InMemoryLogger()

    @property
    def capability_description(self) -> str:
        return (
            "Trajectory logger: captures provider context, LLM prompts/responses, "
            "action selection/execution, rewards, and exports ART/GRPO datasets."
        )

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> TrajectoryLoggerElizaService:
        return cls(runtime)

    async def stop(self) -> None:
        # In-memory service; nothing to stop.
        return None

    # ---- lifecycle helpers (episode / step) ----

    def start_trajectory(
        self,
        agent_id: str,
        *,
        scenario_id: str | None = None,
        episode_id: str | None = None,
        batch_id: str | None = None,
        group_index: int | None = None,
        metadata: dict[str, JsonScalar] | None = None,
    ) -> str:
        return self._logger.start_trajectory(
            agent_id=agent_id,
            scenario_id=scenario_id,
            episode_id=episode_id,
            batch_id=batch_id,
            group_index=group_index,
            metadata=_as_object_dict(metadata),
        )

    def start_step(
        self,
        trajectory_id: str,
        *,
        timestamp_ms: int | None = None,
        agent_balance: float = 0.0,
        agent_points: float = 0.0,
        agent_pnl: float = 0.0,
        open_positions: int = 0,
        custom: dict[str, JsonScalar] | None = None,
    ) -> str:
        now_ms = int(time.time() * 1000)
        env_state = EnvironmentState(
            timestamp=timestamp_ms or now_ms,
            agent_balance=agent_balance,
            agent_points=agent_points,
            agent_pnl=agent_pnl,
            open_positions=open_positions,
            custom=_as_object_dict(custom),
        )
        return self._logger.start_step(trajectory_id, env_state)

    # ---- logging helpers ----

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
        call_id = str(uuid.uuid4())
        llm_call = LLMCall(
            call_id=call_id,
            timestamp=int(time.time() * 1000),
            model=model,
            model_version=model_version,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            response=response,
            reasoning=reasoning,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            latency_ms=latency_ms,
            purpose=_normalize_purpose(purpose),
            action_type=action_type,
        )
        self._logger.log_llm_call(step_id, llm_call)
        return call_id

    def log_provider_access(
        self,
        *,
        step_id: str,
        provider_name: str,
        data: dict[str, JsonScalar],
        purpose: str,
        query: dict[str, JsonScalar] | None = None,
    ) -> None:
        access = ProviderAccess(
            provider_id=str(uuid.uuid4()),
            provider_name=provider_name,
            timestamp=int(time.time() * 1000),
            query=_as_object_dict(query),
            data=_as_object_dict_required(data),
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
        parameters: dict[str, JsonScalar],
        success: bool,
        reward: float | None = None,
        done: bool = False,
        error: str | None = None,
        result: dict[str, JsonScalar] | None = None,
        reasoning: str | None = None,
        llm_call_id: str | None = None,
        components: RewardComponents | None = None,
    ) -> None:
        attempt = ActionAttempt(
            attempt_id=str(uuid.uuid4()),
            timestamp=int(time.time() * 1000),
            action_type=action_type,
            action_name=action_name,
            parameters=_as_object_dict_required(parameters),
            reasoning=reasoning,
            llm_call_id=llm_call_id,
            success=success,
            result=_as_object_dict(result),
            error=error,
            immediate_reward=reward,
        )
        self._logger.complete_step(
            trajectory_id=trajectory_id,
            step_id=step_id,
            action=attempt,
            reward=reward,
            components=components,
        )
        # The underlying model stores `done` on the step; we mirror it as a metric
        # in `final_metrics` at end_trajectory.
        _ = done

    async def end_trajectory(
        self,
        trajectory_id: str,
        status: FinalStatus,
        final_metrics: dict[str, JsonScalar] | None = None,
    ) -> None:
        await self._logger.end_trajectory(
            trajectory_id=trajectory_id,
            status=status,
            final_metrics=_as_object_dict(final_metrics),
        )

    # ---- retrieval / export ----

    def get_active_trajectory(self, trajectory_id: str) -> Trajectory | None:
        return self._logger.get_active_trajectory(trajectory_id)

    def get_all_trajectories(self) -> list[Trajectory]:
        # For AgentBench we treat trajectories as "active but ended" (end_time set),
        # and export at the end of the run.
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
