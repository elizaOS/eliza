/**
 * End-to-end check that the trajectory-export pipeline never writes raw user
 * secrets to disk. Every JSONL emitted by the nightly cron must go through
 * `applyPrivacyFilter` first.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runNightlyTrajectoryExport } from "../src/core/trajectory-export-cron.js";
import type { FilterableTrajectory } from "../src/core/privacy-filter.js";

interface FakeTrajectoryService {
	listTrajectories: (opts: { limit?: number }) => Promise<{
		trajectories: Array<{ id: string }>;
	}>;
	getTrajectoryDetail: (id: string) => Promise<FilterableTrajectory | null>;
}

function createRuntime(trajectories: FilterableTrajectory[]): {
	getService: (name: string) => unknown;
} {
	const service: FakeTrajectoryService = {
		listTrajectories: async () => ({
			trajectories: trajectories.map((t) => ({ id: t.trajectoryId })),
		}),
		getTrajectoryDetail: async (id) =>
			trajectories.find((t) => t.trajectoryId === id) ?? null,
	};
	return {
		getService: (name) => (name === "trajectories" ? service : null),
	};
}

describe("runNightlyTrajectoryExport — privacy filter at write site", () => {
	let outputRoot: string;

	beforeAll(async () => {
		outputRoot = await mkdtemp(join(tmpdir(), "traj-export-test-"));
	});

	afterAll(async () => {
		await rm(outputRoot, { recursive: true, force: true });
	});

	it("never writes raw bearer / openai / github credentials to JSONL", async () => {
		const trajectories: FilterableTrajectory[] = [
			{
				trajectoryId: "tr-credentialed",
				steps: [
					{
						llmCalls: [
							{
								purpose: "response",
								systemPrompt:
									"Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
								userPrompt:
									"try sk-abcdefghijklmnopqrstuvxyz0123456789",
								response: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
							},
						],
					},
				],
			},
		];

		const runtime = createRuntime(trajectories);
		const report = await runNightlyTrajectoryExport(runtime, {
			outputRoot,
		});

		expect(report).not.toBeNull();
		expect(report?.redactionCount).toBeGreaterThanOrEqual(3);

		// Read every JSONL in the output dir and check raw credentials never
		// appear in the written bytes. The filter must have run before these
		// files were written.
		const jsonlPaths = [
			report?.exportPaths.shouldRespondPath,
			report?.exportPaths.contextRoutingPath,
			report?.exportPaths.actionPlannerPath,
			report?.exportPaths.responsePath,
			report?.exportPaths.mediaDescriptionPath,
			report?.exportPaths.summaryPath,
		].filter((p): p is string => Boolean(p));

		const RAW_CREDENTIALS = [
			"abcdefghijklmnopqrstuvwxyz123456",
			"sk-abcdefghijklmnopqrstuvxyz0123456789",
			"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
		];

		for (const path of jsonlPaths) {
			const bytes = await readFile(path, "utf-8");
			for (const cred of RAW_CREDENTIALS) {
				expect(
					bytes.includes(cred),
					`raw credential "${cred}" leaked into ${path}`,
				).toBe(false);
			}
		}
	});
});
