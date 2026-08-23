/**
 * The trajectory exporters are exercised against real temporary files, covering
 * filtering, stable limiting, output-path resolution, and both grouped formats.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	exportForOpenPipeART,
	exportGroupedByScenario,
	exportGroupedForGRPO,
	exportToHuggingFace,
} from "./export.ts";
import type { Trajectory } from "./types.ts";

let outputDir: string;
const cwdOutputs: string[] = [];

beforeEach(async () => {
	outputDir = await mkdtemp(join(tmpdir(), "eliza-core-export-"));
});

afterEach(async () => {
	await rm(outputDir, { recursive: true, force: true });
	await Promise.all(
		cwdOutputs.splice(0).map((path) => rm(path, { force: true })),
	);
});

function trajectory(
	trajectoryId: string,
	startTime: number,
	totalReward: number,
	agentId = "agent-a",
	scenarioId: string | null = "scenario-a",
): Trajectory {
	return {
		trajectoryId: trajectoryId as Trajectory["trajectoryId"],
		agentId: agentId as Trajectory["agentId"],
		startTime,
		scenarioId: scenarioId ?? undefined,
		steps: [],
		totalReward,
		rewardComponents: { environmentReward: totalReward },
		metrics: { episodeLength: 0, finalStatus: "completed" },
		metadata: { agentName: trajectoryId },
	};
}

async function readJsonlIds(path: string): Promise<string[]> {
	const content = await readFile(path, "utf8");
	return content
		.trim()
		.split("\n")
		.map(
			(line) =>
				(
					JSON.parse(line) as {
						metadata: { trajectoryId: string };
					}
				).metadata.trajectoryId,
		);
}

describe("trajectory export", () => {
	it("applies inclusive date, ID, scenario, and reward filters", async () => {
		const path = join(outputDir, "filtered.jsonl");
		const trajectories = [
			trajectory("before", 99, 1),
			trajectory("at-start", 100, 1),
			trajectory("at-end", 200, 2),
			trajectory("after", 201, 2),
			trajectory("other-agent", 150, 1, "agent-b"),
			trajectory("other-scenario", 150, 1, "agent-a", "scenario-b"),
			trajectory("missing-scenario", 150, 1, "agent-a", null),
			trajectory("below-reward", 150, 0.99),
			trajectory("above-reward", 150, 2.01),
		];

		const result = await exportForOpenPipeART({
			datasetName: "filtered",
			trajectories,
			startDate: new Date(100),
			endDate: new Date(200),
			agentIds: ["agent-a"],
			scenarioIds: ["scenario-a"],
			minReward: 1,
			maxReward: 2,
			outputPath: path,
		});

		expect(result).toEqual({
			success: true,
			trajectoriesExported: 2,
			datasetUrl: path,
		});
		expect(await readJsonlIds(path)).toEqual(["at-start", "at-end"]);
	});

	it("keeps input order when limiting and treats empty filters and a zero limit as unbounded", async () => {
		const trajectories = [
			trajectory("first", 100, 1),
			trajectory("second", 100, 1),
			trajectory("third", 50, 1),
		];
		const limitedPath = join(outputDir, "limited.jsonl");
		const unboundedPath = join(outputDir, "unbounded.jsonl");

		const limited = await exportForOpenPipeART({
			datasetName: "limited",
			trajectories,
			maxTrajectories: 2,
			outputPath: limitedPath,
		});
		const unbounded = await exportForOpenPipeART({
			datasetName: "unbounded",
			trajectories,
			agentIds: [],
			scenarioIds: [],
			maxTrajectories: 0,
			outputPath: unboundedPath,
		});

		expect(limited.trajectoriesExported).toBe(2);
		expect(await readJsonlIds(limitedPath)).toEqual(["first", "second"]);
		expect(unbounded.trajectoriesExported).toBe(3);
		expect(await readJsonlIds(unboundedPath)).toEqual([
			"first",
			"second",
			"third",
		]);
	});

	it("writes a single newline for an empty ART export", async () => {
		const path = join(outputDir, "nested", "empty.jsonl");

		const result = await exportForOpenPipeART({
			datasetName: "empty",
			outputPath: path,
		});

		expect(result.trajectoriesExported).toBe(0);
		expect(await readFile(path, "utf8")).toBe("\n");
	});

	it("groups trajectories by scenario and uses the default group for missing IDs", async () => {
		const trajectories = [
			trajectory("scenario-a-1", 1, 1),
			trajectory("default", 2, 1, "agent-a", null),
			trajectory("scenario-a-2", 3, 1),
		];

		const result = await exportGroupedByScenario({
			datasetName: "grouped",
			trajectories,
			outputDir,
		});
		const grouped = JSON.parse(
			await readFile(join(outputDir, "grouped-by-scenario.json"), "utf8"),
		) as Record<string, Trajectory[]>;

		expect(result.trajectoriesExported).toBe(3);
		expect(result.datasetUrl).toBe(join(outputDir, "grouped-by-scenario.json"));
		expect(
			grouped["scenario-a"]?.map(({ trajectoryId }) => trajectoryId),
		).toEqual(["scenario-a-1", "scenario-a-2"]);
		expect(grouped.default?.map(({ trajectoryId }) => trajectoryId)).toEqual([
			"default",
		]);
	});

	it("exports GRPO groups in first-seen scenario order", async () => {
		const path = join(outputDir, "groups.json");
		const result = await exportGroupedForGRPO({
			datasetName: "grpo",
			trajectories: [
				trajectory("b-1", 1, 1, "agent-a", "scenario-b"),
				trajectory("a-1", 2, 1),
				trajectory("b-2", 3, 1, "agent-a", "scenario-b"),
			],
			outputPath: path,
		});
		const groups = JSON.parse(await readFile(path, "utf8")) as Array<{
			groupId: string;
			scenarioId: string;
			trajectories: Trajectory[];
		}>;

		expect(result.trajectoriesExported).toBe(3);
		expect(
			groups.map(({ groupId, scenarioId }) => ({ groupId, scenarioId })),
		).toEqual([
			{ groupId: "group-0", scenarioId: "scenario-b" },
			{ groupId: "group-1", scenarioId: "scenario-a" },
		]);
		expect(
			groups[0]?.trajectories.map(({ trajectoryId }) => trajectoryId),
		).toEqual(["b-1", "b-2"]);
	});

	it("prefers an explicit output path over outputDir", async () => {
		const path = join(outputDir, "explicit", "chosen.json");
		const result = await exportGroupedByScenario({
			datasetName: "explicit",
			trajectories: [trajectory("one", 1, 1)],
			outputPath: path,
			outputDir: join(outputDir, "ignored"),
		});

		expect(result.datasetUrl).toBe(path);
		expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty(
			"scenario-a",
		);
	});

	it("delegates the Hugging Face compatibility export and sanitizes the default filename", async () => {
		const datasetName = `export test ${process.pid} / unsafe`;
		const safeName = `export_test_${process.pid}_unsafe.trajectories.art.jsonl`;
		const path = join(process.cwd(), safeName);
		cwdOutputs.push(path);

		const result = await exportToHuggingFace({
			datasetName,
			trajectories: [trajectory("delegated", 1, 1)],
		});

		expect(result).toEqual({
			success: true,
			trajectoriesExported: 1,
			datasetUrl: path,
		});
		expect(await readJsonlIds(path)).toEqual(["delegated"]);
	});
});
