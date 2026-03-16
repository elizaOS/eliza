from __future__ import annotations

import time
import uuid

from elizaos_plugin_trajectory_logger.types import (
    ActionAttempt,
    EnvironmentState,
    FinalStatus,
    JsonValue,
    LLMCall,
    ProviderAccess,
    RewardComponents,
    Trajectory,
    TrajectoryMetrics,
    TrajectoryStep,
)


class TrajectoryLoggerService:
    """
    In-memory trajectory collector for RL training data.
    """

    def __init__(self) -> None:
        self._active_trajectories: dict[str, Trajectory] = {}
        self._active_step_ids: dict[str, str] = {}

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
        trajectory_id = str(uuid.uuid4())
        now_ms = int(time.time() * 1000)

        traj = Trajectory(
            trajectory_id=trajectory_id,
            agent_id=agent_id,
            start_time=now_ms,
            end_time=now_ms,
            duration_ms=0,
            episode_id=episode_id,
            scenario_id=scenario_id,
            batch_id=batch_id,
            group_index=group_index,
            steps=[],
            total_reward=0.0,
            reward_components=RewardComponents(environment_reward=0.0),
            metrics=TrajectoryMetrics(episode_length=0, final_status="completed"),
            metadata=metadata or {},
        )

        self._active_trajectories[trajectory_id] = traj
        return trajectory_id

    def start_step(self, trajectory_id: str, env_state: EnvironmentState) -> str:
        if trajectory_id not in self._active_trajectories:
            raise KeyError(f"Trajectory {trajectory_id} not found")

        step_id = str(uuid.uuid4())
        traj = self._active_trajectories[trajectory_id]

        now_ms = int(time.time() * 1000)

        step = TrajectoryStep(
            step_id=step_id,
            step_number=len(traj.steps),
            timestamp=env_state.timestamp or now_ms,
            environment_state=env_state,
            observation={},
            llm_calls=[],
            provider_accesses=[],
            action=ActionAttempt(
                attempt_id="",
                timestamp=0,
                action_type="pending",
                action_name="pending",
                parameters={},
                success=False,
            ),
            reward=0.0,
            done=False,
        )

        traj.steps.append(step)
        self._active_step_ids[trajectory_id] = step_id
        return step_id

    def get_current_step_id(self, trajectory_id: str) -> str | None:
        return self._active_step_ids.get(trajectory_id)

    def log_llm_call(self, step_id: str, llm_call: LLMCall) -> None:
        traj = self._find_trajectory_by_step_id(step_id)
        if not traj:
            return

        step = next((s for s in traj.steps if s.step_id == step_id), None)
        if not step:
            return

        step.llm_calls.append(llm_call)

    def log_provider_access(self, step_id: str, access: ProviderAccess) -> None:
        traj = self._find_trajectory_by_step_id(step_id)
        if not traj:
            return

        step = next((s for s in traj.steps if s.step_id == step_id), None)
        if not step:
            return

        step.provider_accesses.append(access)

    def log_llm_call_by_trajectory_id(self, trajectory_id: str, llm_call: LLMCall) -> None:
        step_id = self._active_step_ids.get(trajectory_id)
        if not step_id:
            return
        self.log_llm_call(step_id, llm_call)

    def log_provider_access_by_trajectory_id(
        self, trajectory_id: str, access: ProviderAccess
    ) -> None:
        step_id = self._active_step_ids.get(trajectory_id)
        if not step_id:
            return
        self.log_provider_access(step_id, access)

    def complete_step(
        self,
        trajectory_id: str,
        step_id: str,
        *,
        action: ActionAttempt,
        reward: float | None = None,
        components: RewardComponents | None = None,
    ) -> None:
        traj = self._active_trajectories.get(trajectory_id)
        if not traj:
            return

        step = next((s for s in traj.steps if s.step_id == step_id), None)
        if not step:
            return

        step.action = action

        if reward is not None:
            step.reward = reward
            traj.total_reward += reward

        if components is not None:
            traj.reward_components = components

        self._active_step_ids.pop(trajectory_id, None)

    def complete_current_step(
        self,
        trajectory_id: str,
        *,
        action: ActionAttempt,
        reward: float | None = None,
        components: RewardComponents | None = None,
    ) -> None:
        step_id = self._active_step_ids.get(trajectory_id)
        if not step_id:
            return
        self.complete_step(
            trajectory_id,
            step_id,
            action=action,
            reward=reward,
            components=components,
        )

    async def end_trajectory(
        self,
        trajectory_id: str,
        status: FinalStatus,
        final_metrics: dict[str, JsonValue] | None = None,
    ) -> None:
        traj = self._active_trajectories.get(trajectory_id)
        if not traj:
            return

        now_ms = int(time.time() * 1000)
        traj.end_time = now_ms
        traj.duration_ms = traj.end_time - traj.start_time

        traj.metrics.final_status = status
        traj.metrics.episode_length = len(traj.steps)

        if final_metrics:
            # Store extra metrics in pydantic model (extra=allow)
            for k, v in final_metrics.items():
                setattr(traj.metrics, k, v)

        self._active_step_ids.pop(trajectory_id, None)

    def get_active_trajectory(self, trajectory_id: str) -> Trajectory | None:
        return self._active_trajectories.get(trajectory_id)

    def get_all_trajectories(self) -> list[Trajectory]:
        """
        Return a snapshot of all trajectories collected so far.

        Note: trajectories are retained in-memory after end_trajectory() so callers
        can export datasets after a run completes.
        """
        return list(self._active_trajectories.values())

    def _find_trajectory_by_step_id(self, step_id: str) -> Trajectory | None:
        for traj in self._active_trajectories.values():
            if any(s.step_id == step_id for s in traj.steps):
                return traj
        return None
