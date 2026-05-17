/**
 * Tests for OptimizedPromptService symlink-based versioning + rollback.
 *
 * Covers the contract documented in optimized-prompt.ts:
 *   - setPrompt writes v1.json, v2.json, ... and points `current` at the
 *     newest, `previous` at the second-newest, `previous2` at the third.
 *   - Only the last OPTIMIZED_PROMPT_RETAIN_VERSIONS versions are retained.
 *   - rollback flips `current` and `previous`, swapping which version
 *     `getPrompt` returns.
 *   - refresh reads via `current` symlink and falls back to the directory
 *     scan when no symlink is present (legacy stores).
 */

import { existsSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	OPTIMIZED_PROMPT_CURRENT_LINK,
	OPTIMIZED_PROMPT_PREVIOUS_LINK,
	OPTIMIZED_PROMPT_PREVIOUS2_LINK,
	OPTIMIZED_PROMPT_RETAIN_VERSIONS,
	type OptimizedPromptArtifact,
	OptimizedPromptService,
} from "./optimized-prompt";

function makeArtifact(index: number): OptimizedPromptArtifact {
	const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
	return {
		task: "action_planner",
		optimizer: "instruction-search",
		baseline: "baseline prompt",
		prompt: `optimized prompt v${index}`,
		score: 0.5 + index * 0.01,
		baselineScore: 0.4,
		datasetId: "test-dataset",
		datasetSize: 100,
		generatedAt: stamp,
		lineage: [{ round: 1, variant: index, score: 0.5 + index * 0.01 }],
	};
}

describe("OptimizedPromptService — symlink-based versioning", () => {
	let storeRoot: string;
	let service: OptimizedPromptService;

	beforeEach(async () => {
		storeRoot = await mkdtemp(join(tmpdir(), "optimized-prompt-test-"));
		service = new OptimizedPromptService();
		service.setStoreRoot(storeRoot);
	});

	afterEach(async () => {
		await rm(storeRoot, { recursive: true, force: true });
	});

	it("writes vN.json files and points the current/previous/previous2 symlinks", async () => {
		const dir = join(storeRoot, "action_planner");
		const v1Path = await service.setPrompt("action_planner", makeArtifact(1));
		expect(v1Path).toBe(join(dir, "v1.json"));
		// After one write: current → v1, no previous, no previous2.
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v1.json",
		);
		expect(existsSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK))).toBe(false);
		expect(existsSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS2_LINK))).toBe(false);

		await service.setPrompt("action_planner", makeArtifact(2));
		// After two writes: current → v2, previous → v1.
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v2.json",
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK))).toBe(
			"v1.json",
		);
		expect(existsSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS2_LINK))).toBe(false);

		await service.setPrompt("action_planner", makeArtifact(3));
		// After three writes: current → v3, previous → v2, previous2 → v1.
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v3.json",
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK))).toBe(
			"v2.json",
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS2_LINK))).toBe(
			"v1.json",
		);
	});

	it("retains the most recent OPTIMIZED_PROMPT_RETAIN_VERSIONS artifacts", async () => {
		const totalWrites = OPTIMIZED_PROMPT_RETAIN_VERSIONS + 2;
		for (let i = 1; i <= totalWrites; i += 1) {
			await service.setPrompt("action_planner", makeArtifact(i));
		}
		const dir = join(storeRoot, "action_planner");
		const entries = await readdir(dir);
		const versionFiles = entries.filter((name) => /^v\d+\.json$/.test(name));
		expect(versionFiles.length).toBe(OPTIMIZED_PROMPT_RETAIN_VERSIONS);
		// The two oldest must have been pruned.
		expect(versionFiles).not.toContain("v1.json");
		expect(versionFiles).not.toContain("v2.json");
		// The newest is current.
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			`v${totalWrites}.json`,
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK))).toBe(
			`v${totalWrites - 1}.json`,
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS2_LINK))).toBe(
			`v${totalWrites - 2}.json`,
		);
	});

	it("getPrompt returns the artifact pointed to by current", async () => {
		await service.setPrompt("action_planner", makeArtifact(1));
		await service.setPrompt("action_planner", makeArtifact(2));
		await service.setPrompt("action_planner", makeArtifact(3));

		const live = service.getPrompt("action_planner");
		expect(live).not.toBeNull();
		expect(live?.prompt).toBe("optimized prompt v3");
	});

	it("rollback flips current and previous so the predecessor becomes live", async () => {
		// Write 5 artifacts so the matrix matches the task spec.
		for (let i = 1; i <= 5; i += 1) {
			await service.setPrompt("action_planner", makeArtifact(i));
		}
		const dir = join(storeRoot, "action_planner");

		expect(service.getPrompt("action_planner")?.prompt).toBe(
			"optimized prompt v5",
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v5.json",
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK))).toBe(
			"v4.json",
		);

		const newCurrentPath = await service.rollback("action_planner");
		expect(newCurrentPath).toBe(join(dir, "v4.json"));

		// After rollback: current → v4 (was previous), previous → v5 (was current).
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v4.json",
		);
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK))).toBe(
			"v5.json",
		);
		// previous2 untouched.
		expect(readlinkSync(join(dir, OPTIMIZED_PROMPT_PREVIOUS2_LINK))).toBe(
			"v3.json",
		);
		// In-memory cache refreshed via the current symlink.
		expect(service.getPrompt("action_planner")?.prompt).toBe(
			"optimized prompt v4",
		);
	});

	it("rollback can be invoked twice to flip back to the original current", async () => {
		await service.setPrompt("action_planner", makeArtifact(1));
		await service.setPrompt("action_planner", makeArtifact(2));

		await service.rollback("action_planner");
		expect(service.getPrompt("action_planner")?.prompt).toBe(
			"optimized prompt v1",
		);
		await service.rollback("action_planner");
		expect(service.getPrompt("action_planner")?.prompt).toBe(
			"optimized prompt v2",
		);
	});

	it("rollback throws when there is no previous artifact", async () => {
		await service.setPrompt("action_planner", makeArtifact(1));
		await expect(service.rollback("action_planner")).rejects.toThrow(
			/no previous version/,
		);
	});

	it("rollback throws when the task directory does not exist", async () => {
		await expect(service.rollback("should_respond")).rejects.toThrow(
			/no artifact directory/,
		);
	});

	it("refresh prefers the current symlink even when a newer-by-generatedAt file exists in the directory", async () => {
		// v1 has generatedAt later than v2 — but current points at v2. The
		// service must return v2 because the symlink is authoritative.
		const dir = join(storeRoot, "action_planner");
		mkdirSync(dir, { recursive: true });
		const v1 = makeArtifact(1);
		// Force v1's generatedAt to be after v2 to prove the symlink wins.
		v1.generatedAt = new Date(Date.UTC(2027, 0, 1)).toISOString();
		v1.prompt = "v1 (newer by generatedAt)";
		const v2 = makeArtifact(2);
		v2.prompt = "v2 (older by generatedAt but symlink target)";
		writeFileSync(join(dir, "v1.json"), `${JSON.stringify(v1, null, 2)}\n`);
		writeFileSync(join(dir, "v2.json"), `${JSON.stringify(v2, null, 2)}\n`);
		// Manually set up symlinks so we don't go through setPrompt.
		const { symlinkSync } = await import("node:fs");
		symlinkSync("v2.json", join(dir, OPTIMIZED_PROMPT_CURRENT_LINK));
		symlinkSync("v1.json", join(dir, OPTIMIZED_PROMPT_PREVIOUS_LINK));

		await service.refresh();
		expect(service.getPrompt("action_planner")?.prompt).toBe(
			"v2 (older by generatedAt but symlink target)",
		);
	});

	it("refresh falls back to most-recent-by-generatedAt scan when current symlink is absent", async () => {
		// Legacy / corrupted store: only artifact files, no symlinks.
		const dir = join(storeRoot, "action_planner");
		mkdirSync(dir, { recursive: true });
		const older = makeArtifact(1);
		older.prompt = "older";
		const newer = makeArtifact(2);
		newer.prompt = "newer";
		writeFileSync(
			join(dir, "legacy-1.json"),
			`${JSON.stringify(older, null, 2)}\n`,
		);
		writeFileSync(
			join(dir, "legacy-2.json"),
			`${JSON.stringify(newer, null, 2)}\n`,
		);
		await service.refresh();
		expect(service.getPrompt("action_planner")?.prompt).toBe("newer");
	});

	it("isolates versioning between tasks", async () => {
		await service.setPrompt("action_planner", makeArtifact(1));
		await service.setPrompt("action_planner", makeArtifact(2));
		// Different task gets its own v1 — version counter is per-task.
		const otherArtifact = makeArtifact(10);
		otherArtifact.task = "should_respond";
		await service.setPrompt("should_respond", otherArtifact);

		const plannerDir = join(storeRoot, "action_planner");
		const respondDir = join(storeRoot, "should_respond");
		expect(readlinkSync(join(plannerDir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v2.json",
		);
		expect(readlinkSync(join(respondDir, OPTIMIZED_PROMPT_CURRENT_LINK))).toBe(
			"v1.json",
		);
	});
});
