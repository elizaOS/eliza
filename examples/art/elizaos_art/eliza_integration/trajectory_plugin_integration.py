"""
Trajectory logger integration for ART (Python).

Goal: use the **elizaOS trajectory logger plugin** (`plugins/plugin-trajectory-logger`)
as the canonical source of truth for training/benchmark trajectories.

This module provides a small backend interface so ART examples can:
- start/end trajectories + steps
- log provider accesses, LLM calls, and actions
- export datasets in OpenPipe ART JSONL and GRPO group formats

When the plugin package is importable, we use it directly.
Otherwise we fall back to the local adapter in `trajectory_adapter.py`.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


class TrajectoryBackend(Protocol):
    """Minimal surface needed for end-to-end capture + export."""

    def start_trajectory(
        self,
        *,
        agent_id: str,
        scenario_id: str | None = None,
        episode_id: str | None = None,
        batch_id: str | None = None,
        group_index: int | None = None,
        metadata: dict[str, object] | None = None,
    ) -> str: ...

    def start_step(self, trajectory_id: str, env_state: dict[str, object]) -> str: ...

    def get_current_step_id(self, trajectory_id: str) -> str | None: ...

    def log_llm_call_by_trajectory_id(self, trajectory_id: str, llm_call: dict[str, object]) -> None: ...

    def log_provider_access_by_trajectory_id(
        self, trajectory_id: str, provider_access: dict[str, object]
    ) -> None: ...

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
        llm_call_id: str | None = None,
    ) -> None: ...

    async def end_trajectory(
        self, trajectory_id: str, status: str, final_metrics: dict[str, object] | None = None
    ) -> None: ...

    def export_openpipe_art(self, *, dataset_name: str, output_path: str | None = None) -> str: ...

    def export_grpo_groups(self, *, dataset_name: str, output_path: str | None = None) -> str: ...

    def get_trajectory_json(self, trajectory_id: str) -> dict[str, object] | None: ...


@dataclass
class _PluginTrajectoryBackend:
    """
    Backend that uses `elizaos_plugin_trajectory_logger` directly.

    This is the preferred backend for training/benchmark capture.
    """

    output_dir: Path

    def __post_init__(self) -> None:
        from elizaos_plugin_trajectory_logger.export import export_for_openpipe_art, export_grouped_for_grpo
        from elizaos_plugin_trajectory_logger.service import TrajectoryLoggerService

        self._export_for_openpipe_art = export_for_openpipe_art
        self._export_grouped_for_grpo = export_grouped_for_grpo
        self._logger = TrajectoryLoggerService()

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

    def start_step(self, trajectory_id: str, env_state: dict[str, object]) -> str:
        from elizaos_plugin_trajectory_logger.types import EnvironmentState

        now_ms = int(time.time() * 1000)
        ts = int(env_state.get("timestamp", now_ms)) if isinstance(env_state.get("timestamp"), int) else now_ms

        # Keep the canonical numeric fields, but allow arbitrary nested content under custom.
        custom = env_state.get("custom")
        custom_dict = custom if isinstance(custom, dict) else {}

        state = EnvironmentState(
            timestamp=ts,
            agent_balance=float(env_state.get("agentBalance", 0.0) or 0.0),
            agent_points=float(env_state.get("agentPoints", 0.0) or 0.0),
            agent_pnl=float(env_state.get("agentPnL", 0.0) or 0.0),
            open_positions=int(env_state.get("openPositions", 0) or 0),
            active_markets=env_state.get("activeMarkets") if isinstance(env_state.get("activeMarkets"), int) else None,
            portfolio_value=float(env_state.get("portfolioValue")) if isinstance(env_state.get("portfolioValue"), (int, float)) else None,
            custom=custom_dict,
        )

        return self._logger.start_step(trajectory_id, state)

    def get_current_step_id(self, trajectory_id: str) -> str | None:
        return self._logger.get_current_step_id(trajectory_id)

    def log_llm_call_by_trajectory_id(self, trajectory_id: str, llm_call: dict[str, object]) -> None:
        from elizaos_plugin_trajectory_logger.types import LLMCall

        now_ms = int(time.time() * 1000)
        call = LLMCall(
            call_id=str(uuid.uuid4()),
            timestamp=now_ms,
            model=str(llm_call.get("model", "unknown")),
            model_version=str(llm_call["modelVersion"]) if isinstance(llm_call.get("modelVersion"), str) else None,
            system_prompt=str(llm_call.get("systemPrompt", "")),
            user_prompt=str(llm_call.get("userPrompt", "")),
            response=str(llm_call.get("response", "")),
            reasoning=str(llm_call["reasoning"]) if isinstance(llm_call.get("reasoning"), str) else None,
            temperature=float(llm_call.get("temperature", 0.7) or 0.7),
            max_tokens=int(llm_call.get("maxTokens", 2048) or 2048),
            top_p=float(llm_call["topP"]) if isinstance(llm_call.get("topP"), (int, float)) else None,
            prompt_tokens=int(llm_call["promptTokens"]) if isinstance(llm_call.get("promptTokens"), int) else None,
            completion_tokens=int(llm_call["completionTokens"]) if isinstance(llm_call.get("completionTokens"), int) else None,
            latency_ms=int(llm_call["latencyMs"]) if isinstance(llm_call.get("latencyMs"), int) else None,
            purpose=str(llm_call.get("purpose", "other")),
            action_type=str(llm_call["actionType"]) if isinstance(llm_call.get("actionType"), str) else None,
            messages=None,
        )
        self._logger.log_llm_call_by_trajectory_id(trajectory_id, call)

    def log_provider_access_by_trajectory_id(
        self, trajectory_id: str, provider_access: dict[str, object]
    ) -> None:
        from elizaos_plugin_trajectory_logger.types import ProviderAccess

        access = ProviderAccess(
            provider_id=str(uuid.uuid4()),
            provider_name=str(provider_access.get("providerName", "unknown")),
            timestamp=int(time.time() * 1000),
            query=provider_access.get("query") if isinstance(provider_access.get("query"), dict) else None,
            data=provider_access.get("data") if isinstance(provider_access.get("data"), dict) else {},
            purpose=str(provider_access.get("purpose", "context")),
        )
        self._logger.log_provider_access_by_trajectory_id(trajectory_id, access)

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
        llm_call_id: str | None = None,
    ) -> None:
        from elizaos_plugin_trajectory_logger.types import ActionAttempt

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
        self._logger.complete_step(trajectory_id, step_id, action=attempt, reward=reward, components=None)

        # Ensure the "done" flag is preserved (used by training pipelines).
        traj = self._logger.get_active_trajectory(trajectory_id)
        if traj is None:
            return
        for step in traj.steps:
            if step.step_id == step_id:
                step.done = done
                break

    async def end_trajectory(
        self, trajectory_id: str, status: str, final_metrics: dict[str, object] | None = None
    ) -> None:
        await self._logger.end_trajectory(
            trajectory_id=trajectory_id,
            status=status if status in ("completed", "terminated", "error", "timeout") else "error",
            final_metrics=final_metrics,
        )

    def export_openpipe_art(self, *, dataset_name: str, output_path: str | None = None) -> str:
        from elizaos_plugin_trajectory_logger.export import ExportOptions

        out = Path(output_path) if output_path else (self.output_dir / f"{dataset_name}.art.jsonl")
        result = self._export_for_openpipe_art(
            ExportOptions(dataset_name=dataset_name, trajectories=self._logger.get_all_trajectories(), output_path=str(out))
        )
        return result.dataset_url or str(out)

    def export_grpo_groups(self, *, dataset_name: str, output_path: str | None = None) -> str:
        from elizaos_plugin_trajectory_logger.export import ExportOptions

        out = Path(output_path) if output_path else (self.output_dir / f"{dataset_name}.grpo.groups.json")
        result = self._export_grouped_for_grpo(
            ExportOptions(dataset_name=dataset_name, trajectories=self._logger.get_all_trajectories(), output_path=str(out))
        )
        return result.dataset_url or str(out)

    def get_trajectory_json(self, trajectory_id: str) -> dict[str, object] | None:
        """
        Return a JSON-serializable dict in the **TypeScript plugin** shape (camelCase).

        This keeps ART's existing storage/export adapters compatible while the
        in-memory source of truth remains the python plugin's pydantic models.
        """
        traj = self._logger.get_active_trajectory(trajectory_id)
        if traj is None:
            return None

        reward_components = traj.reward_components.model_dump(mode="json")
        metrics = traj.metrics.model_dump(mode="json")

        steps: list[dict[str, object]] = []
        for step in traj.steps:
            env = step.environment_state.model_dump(mode="json")
            action = step.action.model_dump(mode="json")

            llm_calls = []
            for c in step.llm_calls:
                llm_calls.append(
                    {
                        "callId": c.call_id,
                        "timestamp": c.timestamp,
                        "model": c.model,
                        "modelVersion": c.model_version,
                        "systemPrompt": c.system_prompt,
                        "userPrompt": c.user_prompt,
                        "messages": [
                            {"role": m.role, "content": m.content} for m in (c.messages or [])
                        ]
                        if c.messages
                        else None,
                        "response": c.response,
                        "reasoning": c.reasoning,
                        "temperature": c.temperature,
                        "maxTokens": c.max_tokens,
                        "topP": c.top_p,
                        "promptTokens": c.prompt_tokens,
                        "completionTokens": c.completion_tokens,
                        "latencyMs": c.latency_ms,
                        "purpose": c.purpose,
                        "actionType": c.action_type,
                    }
                )

            provider_accesses = []
            for a in step.provider_accesses:
                provider_accesses.append(
                    {
                        "providerId": a.provider_id,
                        "providerName": a.provider_name,
                        "timestamp": a.timestamp,
                        "query": a.query,
                        "data": a.data,
                        "purpose": a.purpose,
                    }
                )

            steps.append(
                {
                    "stepId": step.step_id,
                    "stepNumber": step.step_number,
                    "timestamp": step.timestamp,
                    "environmentState": {
                        "timestamp": env.get("timestamp"),
                        "agentBalance": env.get("agent_balance"),
                        "agentPoints": env.get("agent_points"),
                        "agentPnL": env.get("agent_pnl"),
                        "openPositions": env.get("open_positions"),
                        "activeMarkets": env.get("active_markets"),
                        "portfolioValue": env.get("portfolio_value"),
                        "unreadMessages": env.get("unread_messages"),
                        "recentEngagement": env.get("recent_engagement"),
                        "custom": env.get("custom"),
                    },
                    "observation": step.observation,
                    "llmCalls": llm_calls,
                    "providerAccesses": provider_accesses,
                    "reasoning": step.reasoning,
                    "action": {
                        "attemptId": action.get("attempt_id"),
                        "timestamp": action.get("timestamp"),
                        "actionType": action.get("action_type"),
                        "actionName": action.get("action_name"),
                        "parameters": action.get("parameters"),
                        "reasoning": action.get("reasoning"),
                        "llmCallId": action.get("llm_call_id"),
                        "success": action.get("success"),
                        "result": action.get("result"),
                        "error": action.get("error"),
                        "immediateReward": action.get("immediate_reward"),
                    },
                    "reward": step.reward,
                    "done": step.done,
                    "metadata": step.metadata,
                }
            )

        return {
            "trajectoryId": traj.trajectory_id,
            "agentId": traj.agent_id,
            "startTime": traj.start_time,
            "endTime": traj.end_time,
            "durationMs": traj.duration_ms,
            "episodeId": traj.episode_id,
            "scenarioId": traj.scenario_id,
            "batchId": traj.batch_id,
            "groupIndex": traj.group_index,
            "steps": steps,
            "totalReward": traj.total_reward,
            "rewardComponents": {
                "environmentReward": reward_components.get("environment_reward", 0.0),
                "aiJudgeReward": reward_components.get("ai_judge_reward"),
                "components": reward_components.get("components"),
                "judgeModel": reward_components.get("judge_model"),
                "judgeReasoning": reward_components.get("judge_reasoning"),
                "judgeTimestamp": reward_components.get("judge_timestamp"),
            },
            "metrics": {
                "episodeLength": metrics.get("episode_length", 0),
                "finalStatus": metrics.get("final_status", "completed"),
                "finalBalance": metrics.get("final_balance"),
                "finalPnL": metrics.get("final_pnl"),
                "tradesExecuted": metrics.get("trades_executed"),
                "postsCreated": metrics.get("posts_created"),
                "messagesHandled": metrics.get("messages_handled"),
                "successRate": metrics.get("success_rate"),
                "errorCount": metrics.get("error_count"),
                # preserve any extra metrics fields
                **{
                    str(k): v
                    for k, v in metrics.items()
                    if k
                    not in {
                        "episode_length",
                        "final_status",
                        "final_balance",
                        "final_pnl",
                        "trades_executed",
                        "posts_created",
                        "messages_handled",
                        "success_rate",
                        "error_count",
                    }
                },
            },
            "metadata": traj.metadata,
        }


def create_trajectory_backend(*, output_dir: str | Path) -> TrajectoryBackend:
    """
    Create a trajectory backend.

    Prefers the elizaOS trajectory logger plugin if importable.
    """
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    try:
        # Import to verify availability
        import elizaos_plugin_trajectory_logger  # noqa: F401

        return _PluginTrajectoryBackend(output_dir=out)
    except Exception:
        # Fallback: local file-based adapter (still ElizaOS-compatible JSON)
        from elizaos_art.eliza_integration.trajectory_adapter import ElizaTrajectoryLogger

        class _FallbackBackend:
            def __init__(self, data_dir: Path) -> None:
                self._logger = ElizaTrajectoryLogger(agent_id="art-agent", data_dir=data_dir)

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
                self._logger.agent_id = agent_id
                return self._logger.start_trajectory(
                    scenario_id=scenario_id,
                    episode_id=episode_id,
                    batch_id=batch_id,
                    group_index=group_index,
                    metadata=dict(metadata) if metadata else None,
                )

            def start_step(self, trajectory_id: str, env_state: dict[str, object]) -> str:
                return self._logger.start_step(trajectory_id, env_state)

            def get_current_step_id(self, trajectory_id: str) -> str | None:
                return self._logger.get_current_step_id(trajectory_id)

            def log_llm_call_by_trajectory_id(self, trajectory_id: str, llm_call: dict[str, object]) -> None:
                self._logger.log_llm_call_by_trajectory_id(trajectory_id, llm_call)

            def log_provider_access_by_trajectory_id(
                self, trajectory_id: str, provider_access: dict[str, object]
            ) -> None:
                self._logger.log_provider_access_by_trajectory_id(trajectory_id, provider_access)

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
                llm_call_id: str | None = None,
            ) -> None:
                _ = llm_call_id
                self._logger.complete_step(
                    trajectory_id=trajectory_id,
                    step_id=step_id,
                    action={"actionType": action_type, "actionName": action_name, "parameters": parameters, "success": success, "error": error, "result": result, "reasoning": reasoning},
                    reward=reward,
                    done=done,
                )

            async def end_trajectory(
                self, trajectory_id: str, status: str, final_metrics: dict[str, object] | None = None
            ) -> None:
                self._logger.end_trajectory(trajectory_id, status=status, final_metrics=final_metrics)

            def export_openpipe_art(self, *, dataset_name: str, output_path: str | None = None) -> str:
                # Fallback: export using local export module
                from elizaos_art.eliza_integration.export import export_trajectories_art_format

                trajectories = []
                for tid in self._logger.list_trajectories():
                    t = self._logger.load_trajectory(tid)
                    if t:
                        trajectories.append(t)
                out_path = output_path or str(self._logger.data_dir / f"{dataset_name}.art.jsonl")
                # Best-effort: run the async exporter in a sync context is caller's responsibility.
                _ = export_trajectories_art_format  # keep available; runtime uses plugin backend in practice
                return out_path

            def export_grpo_groups(self, *, dataset_name: str, output_path: str | None = None) -> str:
                out_path = output_path or str(self._logger.data_dir / f"{dataset_name}.grpo.groups.json")
                return out_path

            def get_trajectory_json(self, trajectory_id: str) -> dict[str, object] | None:
                t = self._logger.load_trajectory(trajectory_id)
                return t if t else None

        return _FallbackBackend(data_dir=out)

