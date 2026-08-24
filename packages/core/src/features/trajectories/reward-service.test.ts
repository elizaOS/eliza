/**
 * Pins heuristic trajectory scoring. The reward is a weighted average whose
 * divisor is built from only the components actually present, so a missing
 * metric must reweight the rest rather than drag the score toward zero; the
 * result must stay inside [-1, 1]; and group scoring must not divide by a zero
 * range when every trajectory scores alike. Pure module, no runtime.
 */
import { describe, expect, it } from "vitest";
import {
	createRewardService,
	RewardService,
	scoreTrajectory,
	scoreTrajectoryGroup,
} from "./reward-service.ts";
import type { Trajectory } from "./types.ts";

type Metrics = Trajectory["metrics"];

function trajectory(
	metrics: Partial<Metrics> = {},
	environmentReward?: number,
): Trajectory {
	return {
		trajectoryId: "00000000-0000-0000-0000-000000000001",
		agentId: "00000000-0000-0000-0000-000000000002",
		startTime: 0,
		steps: [],
		totalReward: 0,
		rewardComponents: { environmentReward } as Trajectory["rewardComponents"],
		metrics: {
			episodeLength: 1,
			finalStatus: "completed",
			...metrics,
		} as Metrics,
		metadata: {},
	} as Trajectory;
}

describe("scoreTrajectory — bounds", () => {
	it("never leaves the [-1, 1] range", async () => {
		const extremes = [
			trajectory({ finalPnL: 1e9, successRate: 1 }, 1),
			trajectory({ finalPnL: -1e9, successRate: 0, finalStatus: "error" }, -1),
			trajectory({ finalPnL: 0, successRate: 0.5 }, 0),
			trajectory({}, undefined),
		];
		for (const t of extremes) {
			const score = await scoreTrajectory(t);
			expect(score).toBeGreaterThanOrEqual(-1);
			expect(score).toBeLessThanOrEqual(1);
			expect(Number.isFinite(score)).toBe(true);
		}
	});

	it("clamps an out-of-range environment reward instead of propagating it", async () => {
		const high = await scoreTrajectory(trajectory({}, 1000));
		const atOne = await scoreTrajectory(trajectory({}, 1));
		expect(high).toBeCloseTo(atOne, 10);

		const low = await scoreTrajectory(trajectory({}, -1000));
		const atMinusOne = await scoreTrajectory(trajectory({}, -1));
		expect(low).toBeCloseTo(atMinusOne, 10);
	});
});

describe("scoreTrajectory — component weighting", () => {
	it("scores a completed run with no other signal at the completion value", async () => {
		// Only the completion component contributes, so the weighted average is
		// that component's own value rather than a fraction of it.
		expect(await scoreTrajectory(trajectory())).toBeCloseTo(1, 10);
	});

	it("scores a non-completed run with no other signal at the penalty value", async () => {
		for (const finalStatus of [
			"active",
			"terminated",
			"error",
			"timeout",
		] as const) {
			expect(await scoreTrajectory(trajectory({ finalStatus }))).toBeCloseTo(
				-0.5,
				10,
			);
		}
	});

	it("reweights rather than penalising when a metric is absent", async () => {
		// A perfect run scores 1 whether or not the optional metrics are present.
		const bare = await scoreTrajectory(trajectory());
		const full = await scoreTrajectory(
			trajectory({ finalPnL: 1e6, successRate: 1 }, 1),
		);
		expect(bare).toBeCloseTo(1, 6);
		expect(full).toBeCloseTo(1, 6);
	});

	it("maps a 0..1 success rate onto -1..1 before weighting", async () => {
		// Holding status at "completed", only the success and completion
		// components contribute (weights 0.3 and 0.2, divisor 0.5):
		//   successRate 0 -> (-1 * 0.3 + 1 * 0.2) / 0.5 = -0.2
		//   successRate 1 -> ( 1 * 0.3 + 1 * 0.2) / 0.5 =  1.0
		expect(await scoreTrajectory(trajectory({ successRate: 0 }))).toBeCloseTo(
			-0.2,
			10,
		);
		expect(await scoreTrajectory(trajectory({ successRate: 1 }))).toBeCloseTo(
			1,
			10,
		);
	});

	it("is monotonic in success rate", async () => {
		const scores = await Promise.all(
			[0, 0.25, 0.5, 0.75, 1].map((successRate) =>
				scoreTrajectory(trajectory({ successRate })),
			),
		);
		for (let i = 1; i < scores.length; i += 1) {
			expect(scores[i]).toBeGreaterThan(scores[i - 1]);
		}
	});

	it("treats a mid success rate as neutral for its component", async () => {
		// successRate 0.5 -> component 0, so only completion contributes.
		const mid = await scoreTrajectory(trajectory({ successRate: 0.5 }));
		expect(mid).toBeCloseTo((1 * 0.2) / 0.5, 10);
	});

	it("is monotonic in P&L", async () => {
		const scores = await Promise.all(
			[-5000, -500, 0, 500, 5000].map((finalPnL) =>
				scoreTrajectory(trajectory({ finalPnL })),
			),
		);
		for (let i = 1; i < scores.length; i += 1) {
			expect(scores[i]).toBeGreaterThan(scores[i - 1]);
		}
	});

	it("treats zero P&L as neutral for its component", async () => {
		const zero = await scoreTrajectory(trajectory({ finalPnL: 0 }));
		expect(zero).toBeCloseTo((1 * 0.2) / 0.6, 10);
	});

	it("saturates rather than overflowing on extreme P&L", async () => {
		const big = await scoreTrajectory(trajectory({ finalPnL: 1e12 }));
		const bigger = await scoreTrajectory(trajectory({ finalPnL: 1e15 }));
		expect(big).toBeCloseTo(bigger, 10);
		expect(big).toBeLessThanOrEqual(1);
	});
});

describe("scoreTrajectoryGroup", () => {
	it("returns an empty array for an empty group", async () => {
		expect(await scoreTrajectoryGroup([])).toEqual([]);
	});

	it("returns one absolute score for a single trajectory", async () => {
		const [score] = await scoreTrajectoryGroup([trajectory()]);
		expect(score).toBeCloseTo(1, 10);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	it("gives every member 0.5 when the group has no spread", async () => {
		const scores = await scoreTrajectoryGroup([
			trajectory(),
			trajectory(),
			trajectory(),
		]);
		expect(scores).toEqual([0.5, 0.5, 0.5]);
	});

	it("min-max normalises a group with spread", async () => {
		const scores = await scoreTrajectoryGroup([
			trajectory({ finalStatus: "error" }),
			trajectory({ successRate: 0.5 }),
			trajectory(),
		]);
		expect(Math.min(...scores)).toBe(0);
		expect(Math.max(...scores)).toBe(1);
		expect(scores.length).toBe(3);
	});

	it("preserves input order and length", async () => {
		const scores = await scoreTrajectoryGroup([
			trajectory(),
			trajectory({ finalStatus: "error" }),
		]);
		expect(scores.length).toBe(2);
		expect(scores[0]).toBeGreaterThan(scores[1]);
	});

	it("keeps every score inside [0, 1] and finite", async () => {
		const scores = await scoreTrajectoryGroup([
			trajectory({ finalPnL: -1e9, finalStatus: "error" }),
			trajectory({ finalPnL: 1e9, successRate: 1 }, 1),
			trajectory({ successRate: 0.25 }),
		]);
		for (const score of scores) {
			expect(Number.isFinite(score)).toBe(true);
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(1);
		}
	});
});

describe("service construction", () => {
	it("createRewardService returns a usable service", async () => {
		const service = createRewardService();
		expect(service).toBeInstanceOf(RewardService);
		expect(await service.scoreTrajectory(trajectory())).toBeCloseTo(1, 10);
	});

	it("accepts an archetype without changing the heuristic score", async () => {
		const plain = createRewardService();
		const themed = createRewardService({ archetype: "trader" });
		const t = trajectory({ finalPnL: 250, successRate: 0.75 }, 0.5);
		expect(await themed.scoreTrajectory(t)).toBe(
			await plain.scoreTrajectory(t),
		);
	});

	it("scores identically through the class and the free functions", async () => {
		const t = trajectory({ finalPnL: 120, successRate: 0.6 }, 0.2);
		expect(await scoreTrajectory(t)).toBe(
			await new RewardService().scoreTrajectory(t),
		);
	});

	it("is deterministic across repeated calls", async () => {
		const t = trajectory({ finalPnL: 42, successRate: 0.4 }, -0.3);
		const first = await scoreTrajectory(t);
		expect(await scoreTrajectory(t)).toBe(first);
		expect(await scoreTrajectory(t)).toBe(first);
	});
});
