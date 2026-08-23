/**
 * Unit tests for trajectory reward service: validates heuristic reward
 * calculation from PnL, successRate, completion status, and group normalization.
 */
import { describe, expect, it } from "vitest";
import {
	createRewardService,
	RewardService,
	scoreTrajectory,
	scoreTrajectoryGroup,
} from "./reward-service.ts";
import type { Trajectory } from "./types.ts";

describe("reward-service", () => {
	function createMockTrajectory(
		overrides: Partial<Trajectory> = {},
	): Trajectory {
		return {
			trajectoryId: "traj-1",
			agentId: "agent-1",
			steps: [],
			metrics: {
				finalStatus: "completed",
				finalPnL: 100,
				successRate: 0.8,
			},
			rewardComponents: {
				environmentReward: 0.5,
			},
			...overrides,
		} as unknown as Trajectory;
	}

	it("computes heuristic reward for completed trajectory", async () => {
		const service = createRewardService();
		const traj = createMockTrajectory();
		const score = await service.scoreTrajectory(traj);

		expect(typeof score).toBe("number");
		expect(score).toBeGreaterThan(-1);
		expect(score).toBeLessThanOrEqual(1);
	});

	it("normalizes trajectory group scores", async () => {
		const service = new RewardService();
		expect(await service.scoreTrajectoryGroup([])).toEqual([]);

		const traj1 = createMockTrajectory({
			metrics: { finalStatus: "completed", finalPnL: 500, successRate: 1.0 },
			rewardComponents: { environmentReward: 1 },
		});
		const traj2 = createMockTrajectory({
			metrics: { finalStatus: "failed", finalPnL: -500, successRate: 0.0 },
			rewardComponents: { environmentReward: -1 },
		});

		const groupScores = await service.scoreTrajectoryGroup([traj1, traj2]);
		expect(groupScores.length).toBe(2);
		expect(groupScores[0]).toBeGreaterThan(groupScores[1]);
	});

	it("scores single trajectory with helper functions", async () => {
		const traj = createMockTrajectory();
		const score = await scoreTrajectory(traj);
		expect(score).toBeDefined();

		const group = await scoreTrajectoryGroup([traj]);
		expect(group.length).toBe(1);
	});
});
