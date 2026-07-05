/**
 * Per-trace trajectory usage roll-up (#13775 item 5). Pure summing over parsed
 * RecordedTrajectory objects — no I/O — asserting grouping by traceId, the
 * grand total, NaN/undefined guarding, and the deterministic bucket order.
 */

import { describe, expect, it } from "vitest";
import type {
	RecordedTrajectory,
	RecordedTrajectoryMetrics,
} from "./trajectory-recorder";
import { rollUpTrajectoryUsage } from "./trajectory-usage-rollup";

function metrics(
	partial: Partial<RecordedTrajectoryMetrics>,
): RecordedTrajectoryMetrics {
	return {
		totalLatencyMs: 0,
		totalPromptTokens: 0,
		totalCompletionTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheCreationTokens: 0,
		totalCostUsd: 0,
		plannerIterations: 0,
		toolCallsExecuted: 0,
		toolCallFailures: 0,
		toolSearchCount: 0,
		evaluatorFailures: 0,
		...partial,
	};
}

function trajectory(
	traceId: string | undefined,
	m: Partial<RecordedTrajectoryMetrics>,
): RecordedTrajectory {
	return {
		trajectoryId: `${traceId ?? "none"}-${Math.random()}`,
		agentId: "agent-1",
		traceId,
		rootMessage: { id: "m", text: "hi" },
		startedAt: 0,
		status: "finished",
		stages: [],
		metrics: metrics(m),
	};
}

describe("rollUpTrajectoryUsage", () => {
	it("groups by traceId and sums prompt/completion/cache/cost into the grand total", () => {
		const rollup = rollUpTrajectoryUsage([
			trajectory("trace-A", {
				totalPromptTokens: 100,
				totalCompletionTokens: 20,
				totalCacheReadTokens: 5,
				totalCacheCreationTokens: 3,
				totalCostUsd: 0.01,
			}),
			trajectory("trace-A", {
				totalPromptTokens: 50,
				totalCompletionTokens: 10,
				totalCostUsd: 0.005,
			}),
			trajectory("trace-B", {
				totalPromptTokens: 200,
				totalCompletionTokens: 40,
				totalCostUsd: 0.02,
			}),
		]);

		expect(rollup.byTrace).toHaveLength(2);
		const a = rollup.byTrace.find((b) => b.traceId === "trace-A");
		expect(a).toMatchObject({
			promptTokens: 150,
			completionTokens: 30,
			cacheReadTokens: 5,
			cacheCreationTokens: 3,
			totalTokens: 180,
			trajectoryCount: 2,
		});
		expect(a?.costUsd).toBeCloseTo(0.015, 6);

		// Grand total spans both traces.
		expect(rollup.promptTokens).toBe(350);
		expect(rollup.completionTokens).toBe(70);
		expect(rollup.totalTokens).toBe(420);
		expect(rollup.trajectoryCount).toBe(3);
		expect(rollup.costUsd).toBeCloseTo(0.035, 6);
	});

	it("buckets an untraced trajectory under the empty key and keeps it last, never dropping its spend", () => {
		const rollup = rollUpTrajectoryUsage([
			trajectory(undefined, { totalPromptTokens: 10, totalCostUsd: 0.001 }),
			trajectory("trace-Z", { totalPromptTokens: 5, totalCostUsd: 0.0005 }),
		]);
		expect(rollup.byTrace.map((b) => b.traceId)).toEqual(["trace-Z", ""]);
		expect(rollup.promptTokens).toBe(15);
		expect(rollup.trajectoryCount).toBe(2);
	});

	it("treats NaN/undefined metric fields as zero so a truncated file can't poison the total", () => {
		const bad = trajectory("trace-nan", {});
		// Simulate a hand-edited / truncated file.
		(bad.metrics as unknown as Record<string, unknown>).totalPromptTokens =
			Number.NaN;
		(bad.metrics as unknown as Record<string, unknown>).totalCostUsd =
			undefined;
		const rollup = rollUpTrajectoryUsage([
			bad,
			trajectory("trace-nan", { totalPromptTokens: 7, totalCostUsd: 0.002 }),
		]);
		expect(Number.isNaN(rollup.promptTokens)).toBe(false);
		expect(rollup.promptTokens).toBe(7);
		expect(rollup.costUsd).toBeCloseTo(0.002, 6);
	});

	it("returns an empty roll-up for no trajectories", () => {
		const rollup = rollUpTrajectoryUsage([]);
		expect(rollup.byTrace).toEqual([]);
		expect(rollup.totalTokens).toBe(0);
		expect(rollup.trajectoryCount).toBe(0);
		expect(rollup.costUsd).toBe(0);
	});
});
