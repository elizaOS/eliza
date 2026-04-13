"""
Trajectory logging integration for Tau-bench.

This module integrates `elizaos-plugin-trajectory-logger` (Python) with the
Tau-bench harness to capture full end-to-end ElizaOS interactions suitable for
training and benchmarking:
- Canonical `runtime.message_service.handle_message()` flow
- Provider accesses (e.g., TAU_BENCH_CONTEXT)
- Tool/action attempts (EXECUTE_TOOL)
- LLM calls (via wrapping `runtime.use_model`)
- Export to OpenPipe ART JSONL and GRPO grouped JSON
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from elizaos_tau_bench.types import TauBenchResult, TauBenchTask

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.model import ModelType


# Optional dependency: trajectory logger plugin (Python)
try:
    from elizaos_plugin_trajectory_logger import (
        ActionAttempt,
        EnvironmentState,
        ExportOptions,
        ExportResult,
        LLMCall,
        ProviderAccess,
        Trajectory,
        TrajectoryLoggerService,
        export_for_openpipe_art,
        export_grouped_for_grpo,
    )

    TRAJECTORY_LOGGER_AVAILABLE = True
except Exception:
    TRAJECTORY_LOGGER_AVAILABLE = False


ExportFormat = Literal["art", "grpo"]


@dataclass(frozen=True)
class TauBenchTrajectoryConfig:
    enabled: bool = True
    export_format: ExportFormat = "art"
    scenario_prefix: str = "tau-bench"


class TauBenchTrajectoryIntegration:
    """
    Small helper that owns a TrajectoryLoggerService instance and exports trajectories.

    This is intentionally "manual instrumentation" (like AgentBench) so it works
    for Python runtimes today without requiring a core Service hook.
    """

    def __init__(self, config: TauBenchTrajectoryConfig | None = None) -> None:
        self.config = config or TauBenchTrajectoryConfig()
        self._logger: TrajectoryLoggerService | None = None
        self._trajectories: list[Trajectory] = []
        self._current_trajectory_id: str | None = None
        self._wrapped_runtime: AgentRuntime | None = None
        self._original_use_model: object | None = None
        self._llm_call_buffer: list[dict[str, object]] = []

        if TRAJECTORY_LOGGER_AVAILABLE and self.config.enabled:
            self._logger = TrajectoryLoggerService()

    @property
    def enabled(self) -> bool:
        return self._logger is not None

    def start_task(
        self,
        task: TauBenchTask,
        *,
        agent_id: str,
        trial_number: int,
    ) -> str | None:
        if not self._logger:
            return None

        # IMPORTANT: For GRPO, grouping happens by scenario_id.
        # We want multiple trials for the SAME task to group together.
        scenario_id = task.task_id
        trajectory_id = self._logger.start_trajectory(
            agent_id=agent_id,
            scenario_id=scenario_id,
            episode_id=f"{task.task_id}-trial-{trial_number}",
            group_index=max(0, trial_number - 1),
            metadata={
                "task_id": task.task_id,
                "domain": task.domain.value,
                "trial": trial_number,
                "goal": task.user_goal or task.user_instruction,
                "success_criteria": list(task.success_criteria),
                "policy_count": len(task.policy_constraints),
                "tool_count": len(task.available_tools),
            },
        )
        self._current_trajectory_id = trajectory_id
        return trajectory_id

    def start_turn(
        self,
        *,
        turn_index: int,
        message_text: str,
        last_tool_result: object | None,
        tool_calls_made: int,
    ) -> str | None:
        if not self._logger or not self._current_trajectory_id:
            return None

        custom: dict[str, object] = {
            "turn": turn_index,
            "message_text": message_text[:1000],
            "tool_calls_made": tool_calls_made,
        }
        if last_tool_result is not None:
            custom["last_tool_result"] = _safe_jsonable(last_tool_result)

        env_state = EnvironmentState(
            timestamp=int(time.time() * 1000),
            agent_balance=0.0,
            agent_points=0.0,
            agent_pnl=0.0,
            open_positions=tool_calls_made,
            custom=custom,
        )
        return self._logger.start_step(self._current_trajectory_id, env_state)

    def log_provider_access(
        self,
        *,
        step_id: str,
        provider_name: str,
        purpose: str,
        data: dict[str, object],
        query: dict[str, object] | None = None,
    ) -> None:
        if not self._logger:
            return
        access = ProviderAccess(
            provider_id=str(uuid.uuid4()),
            provider_name=provider_name,
            timestamp=int(time.time() * 1000),
            query=query,
            data=data,
            purpose=purpose,
        )
        self._logger.log_provider_access(step_id, access)

    def log_action_attempt(
        self,
        *,
        trajectory_id: str,
        step_id: str,
        action_type: str,
        action_name: str,
        parameters: dict[str, object],
        success: bool,
        reward: float | None,
        result: dict[str, object] | None,
        error: str | None = None,
        reasoning: str | None = None,
        llm_call_id: str | None = None,
    ) -> None:
        if not self._logger:
            return

        attempt = ActionAttempt(
            attempt_id=str(uuid.uuid4()),
            timestamp=int(time.time() * 1000),
            action_type=action_type,
            action_name=action_name,
            parameters=parameters,
            reasoning=reasoning,
            llm_call_id=llm_call_id,
            success=success,
            result=result,
            error=error,
            immediate_reward=reward,
        )
        self._logger.complete_step(
            trajectory_id,
            step_id,
            action=attempt,
            reward=reward,
        )

    async def end_task(self, *, result: TauBenchResult) -> Trajectory | None:
        if not self._logger or not self._current_trajectory_id:
            return None

        trajectory_id = self._current_trajectory_id
        status: Literal["completed", "terminated", "error", "timeout"]
        if result.error:
            status = "error"
        elif result.success:
            status = "completed"
        else:
            status = "terminated"

        await self._logger.end_trajectory(
            trajectory_id,
            status,
            final_metrics={
                "success": result.success,
                "goal_achieved": result.goal_achieved,
                "tool_accuracy": result.tool_call_accuracy,
                "policy_compliance": result.policy_compliance,
                "duration_ms": result.duration_ms,
                "turns_used": result.turns_used,
            },
        )

        traj = self._logger.get_active_trajectory(trajectory_id)
        if traj:
            # Ensure ART export has a usable reward signal.
            # Tau-bench is episodic: reward = 1 for success else 0.
            traj.total_reward = 1.0 if result.success else 0.0
            traj.reward_components.environment_reward = traj.total_reward
            self._trajectories.append(traj)

        self._current_trajectory_id = None
        return traj

    def export_trajectories(
        self,
        *,
        output_dir: str,
        dataset_name: str,
        max_trajectories: int | None = None,
    ) -> ExportResult | None:
        if not TRAJECTORY_LOGGER_AVAILABLE or not self._trajectories:
            return None

        options = ExportOptions(
            dataset_name=dataset_name,
            trajectories=self._trajectories,
            output_dir=output_dir,
            max_trajectories=max_trajectories,
        )
        if self.config.export_format == "grpo":
            return export_grouped_for_grpo(options)
        return export_for_openpipe_art(options)

    # ----------------------------
    # Runtime wrapping (LLM calls)
    # ----------------------------

    def wrap_runtime(self, runtime: "AgentRuntime") -> None:
        """
        Wrap `runtime.use_model` to buffer model calls made by `handle_message()`.

        We keep this lightweight (a buffer of dicts) and convert to LLMCall when
        flushing into a specific step id.
        """
        if not self.enabled:
            return
        if self._wrapped_runtime is runtime:
            return

        self._wrapped_runtime = runtime
        self._original_use_model = runtime.use_model  # type: ignore[assignment]

        original_use_model = runtime.use_model

        async def wrapped_use_model(
            model_type: str | "ModelType",
            params: dict[str, object] | None = None,
            provider: str | None = None,
            **kwargs: object,
        ) -> object:
            start = time.time()
            result = await original_use_model(model_type, params, provider=provider, **kwargs)
            latency_ms = int((time.time() - start) * 1000)

            merged: dict[str, object] = {}
            if params:
                merged.update(params)
            if kwargs:
                merged.update(kwargs)

            self._llm_call_buffer.append(
                {
                    "model_type": str(model_type),
                    "provider": provider or "",
                    "params": merged,
                    "result": str(result),
                    "latency_ms": latency_ms,
                }
            )
            return result

        runtime.use_model = wrapped_use_model  # type: ignore[assignment]

    def flush_llm_calls_to_step(
        self,
        *,
        step_id: str,
        system_prompt: str,
    ) -> None:
        if not self._logger:
            return
        if not self._llm_call_buffer:
            return

        now_ms = int(time.time() * 1000)
        for entry in self._llm_call_buffer:
            params = entry.get("params")
            prompt = ""
            if isinstance(params, dict):
                p = params.get("prompt")
                if isinstance(p, str):
                    prompt = p

            call = LLMCall(
                call_id=str(uuid.uuid4()),
                timestamp=now_ms,
                model=str(entry.get("model_type") or ""),
                model_version=None,
                system_prompt=system_prompt,
                user_prompt=prompt,
                messages=None,
                response=str(entry.get("result") or ""),
                reasoning=None,
                temperature=float(_maybe_number(params, "temperature", 0.0)),
                max_tokens=int(_maybe_number(params, "max_tokens", 0)),
                top_p=None,
                prompt_tokens=None,
                completion_tokens=None,
                latency_ms=int(_maybe_number(entry, "latency_ms", 0)),
                purpose="action",
                action_type=None,
            )
            self._logger.log_llm_call(step_id, call)

        self._llm_call_buffer.clear()

    def restore_runtime(self) -> None:
        if not self._wrapped_runtime:
            return
        if self._original_use_model is not None:
            # Best-effort restore
            self._wrapped_runtime.use_model = self._original_use_model  # type: ignore[assignment]
        self._wrapped_runtime = None
        self._original_use_model = None
        self._llm_call_buffer.clear()


def _safe_jsonable(value: object) -> object:
    try:
        json.dumps(value)
        return value
    except Exception:
        return str(value)


def _maybe_number(container: object, key: str, default: float) -> float:
    if not isinstance(container, dict):
        return default
    val = container.get(key)
    if isinstance(val, (int, float)):
        return float(val)
    return default

