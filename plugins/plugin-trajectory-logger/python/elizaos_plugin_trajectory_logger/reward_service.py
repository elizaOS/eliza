from __future__ import annotations

import math

from elizaos_plugin_trajectory_logger.types import Trajectory


class RewardService:
    def __init__(self, *, use_heuristics: bool = True) -> None:
        self.use_heuristics = use_heuristics

    async def score_trajectory(self, trajectory: Trajectory) -> float:
        return self._compute_heuristic_reward(trajectory)

    async def score_trajectory_group(self, trajectories: list[Trajectory]) -> list[float]:
        if not trajectories:
            return []
        if len(trajectories) == 1:
            score = await self.score_trajectory(trajectories[0])
            return [self._normalize_score(score)]

        raw_scores = [await self.score_trajectory(t) for t in trajectories]
        return self._normalize_scores_for_group(raw_scores)

    def _compute_heuristic_reward(self, trajectory: Trajectory) -> float:
        metrics = trajectory.metrics
        components = trajectory.reward_components

        reward = 0.0
        weight_sum = 0.0

        # 1) P&L (0.4)
        if metrics.final_pnl is not None:
            reward += self._normalize_pnl(metrics.final_pnl) * 0.4
            weight_sum += 0.4

        # 2) Success rate (0.3)
        if metrics.success_rate is not None:
            reward += (metrics.success_rate * 2.0 - 1.0) * 0.3
            weight_sum += 0.3

        # 3) Completion (0.2)
        reward += (1.0 if metrics.final_status == "completed" else -0.5) * 0.2
        weight_sum += 0.2

        # 4) Environment reward (0.1)
        reward += max(-1.0, min(1.0, components.environment_reward)) * 0.1
        weight_sum += 0.1

        if weight_sum > 0:
            reward = reward / weight_sum

        return max(-1.0, min(1.0, reward))

    def _normalize_pnl(self, pnl: float) -> float:
        return math.tanh(pnl / 500.0)

    def _normalize_score(self, score: float) -> float:
        return (score + 1.0) / 2.0

    def _normalize_scores_for_group(self, scores: list[float]) -> list[float]:
        min_score = min(scores)
        max_score = max(scores)
        rng = max_score - min_score
        if rng == 0:
            return [0.5 for _ in scores]
        return [(s - min_score) / rng for s in scores]


def create_reward_service(*, use_heuristics: bool = True) -> RewardService:
    return RewardService(use_heuristics=use_heuristics)
