/**
 * Deterministic unit coverage for trajectory heuristic rewards and group
 * normalization, including optional signals, clamping, ties, and empty inputs.
 */
import { describe, expect, it } from "vitest";
import {
	createRewardService,
	RewardService,
	scoreTrajectory,
	scoreTrajectoryGroup,
} from "./reward-service";
import type { Trajectory } from "./types";

function makeTrajectory(
	overrides: {
		finalPnL?: number;
		successRate?: number;
		finalStatus?: Trajectory["metrics"]["finalStatus"];
		environmentReward?: number;
	} = {},
): Trajectory {
	return {
		trajectoryId: "10000000-0000-0000-0000-000000000001",
		agentId: "20000000-0000-0000-0000-000000000002",
		startTime: 1,
		steps: [],
		totalReward: 0,
		rewardComponents: {
			environmentReward: overrides.environmentReward ?? 0,
		},
		metrics: {
			episodeLength: 0,
			finalStatus: overrides.finalStatus ?? "completed",
			...(overrides.finalPnL === undefined
				? {}
				: { finalPnL: overrides.finalPnL }),
			...(overrides.successRate === undefined
				? {}
				: { successRate: overrides.successRate }),
		},
		metadata: {},
	};
}

describe("RewardService", () => {
	it("combines every heuristic signal using the documented weights", async () => {
		const trajectory = makeTrajectory({
			finalPnL: 0,
			successRate: 0.75,
			finalStatus: "completed",
			environmentReward: 0.5,
		});

		await expect(
			new RewardService().scoreTrajectory(trajectory),
		).resolves.toBeCloseTo(0.4);
	});

	it("renormalizes over only the signals that are present", async () => {
		const trajectory = makeTrajectory();
		delete (trajectory.rewardComponents as { environmentReward?: number })
			.environmentReward;

		await expect(new RewardService().scoreTrajectory(trajectory)).resolves.toBe(
			1,
		);
	});

	it("uses the non-completed penalty and clamps environment rewards", async () => {
		await expect(
			new RewardService().scoreTrajectory(
				makeTrajectory({ finalStatus: "error", environmentReward: -20 }),
			),
		).resolves.toBeCloseTo(-2 / 3);
	});

	it("normalizes profit and loss asymptotically", async () => {
		const service = new RewardService();

		await expect(
			service.scoreTrajectory(
				makeTrajectory({ finalPnL: Number.POSITIVE_INFINITY }),
			),
		).resolves.toBeCloseTo(6 / 7);
		await expect(
			service.scoreTrajectory(
				makeTrajectory({ finalPnL: Number.NEGATIVE_INFINITY }),
			),
		).resolves.toBeCloseTo(-2 / 7);
	});

	it("clamps out-of-range aggregate scores", async () => {
		const service = new RewardService();

		await expect(
			service.scoreTrajectory(
				makeTrajectory({ successRate: 10, environmentReward: 1 }),
			),
		).resolves.toBe(1);
		await expect(
			service.scoreTrajectory(
				makeTrajectory({
					successRate: -10,
					finalStatus: "terminated",
					environmentReward: -1,
				}),
			),
		).resolves.toBe(-1);
	});

	it("uses the current heuristic implementation when heuristics are disabled", async () => {
		const trajectory = makeTrajectory({ finalPnL: 250, successRate: 0.25 });
		const enabled = new RewardService({ useHeuristics: true });
		const disabled = new RewardService({ useHeuristics: false });

		expect(await disabled.scoreTrajectory(trajectory)).toBe(
			await enabled.scoreTrajectory(trajectory),
		);
	});

	it("returns an empty result for empty and sparse single-item groups", async () => {
		const service = new RewardService();
		const sparse = new Array<Trajectory>(1);

		await expect(service.scoreTrajectoryGroup([])).resolves.toEqual([]);
		await expect(service.scoreTrajectoryGroup(sparse)).resolves.toEqual([]);
	});

	it("maps a single raw score from -1..1 into 0..1", async () => {
		const trajectory = makeTrajectory({
			finalPnL: 0,
			successRate: 0.75,
			environmentReward: 0.5,
		});

		await expect(
			new RewardService().scoreTrajectoryGroup([trajectory]),
		).resolves.toEqual([0.7]);
	});

	it("normalizes a group relative to its extrema without reordering it", async () => {
		const highest = makeTrajectory({ environmentReward: 1 });
		const lowest = makeTrajectory({
			finalStatus: "error",
			environmentReward: -1,
		});
		const middle = makeTrajectory({
			finalStatus: "error",
			environmentReward: 1,
		});

		const scores = await new RewardService().scoreTrajectoryGroup([
			highest,
			lowest,
			middle,
		]);

		expect(scores[0]).toBe(1);
		expect(scores[1]).toBe(0);
		expect(scores[2]).toBeCloseTo(0.4);
	});

	it("assigns the neutral midpoint to tied group scores", async () => {
		const first = makeTrajectory({ finalPnL: 100 });
		const second = makeTrajectory({ finalPnL: 100 });

		await expect(
			new RewardService().scoreTrajectoryGroup([first, second]),
		).resolves.toEqual([0.5, 0.5]);
	});
});

describe("reward-service convenience exports", () => {
	it("creates configured services and delegates scoring through real instances", async () => {
		const trajectory = makeTrajectory({ environmentReward: 1 });
		const service = createRewardService({ archetype: "trader" });

		expect(service).toBeInstanceOf(RewardService);
		await expect(scoreTrajectory(trajectory)).resolves.toBe(1);
		await expect(
			scoreTrajectoryGroup([trajectory, trajectory]),
		).resolves.toEqual([0.5, 0.5]);
	});
});
