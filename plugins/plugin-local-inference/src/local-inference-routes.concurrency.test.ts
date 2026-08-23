/**
 * Regression coverage for concurrent persisted-config mutations against the
 * real exported `applyLocalInferenceManagementMutation` handler with a temp
 * `ELIZA_STATE_DIR` (issue #25123). Before the fix, `writeJsonFile` staged every
 * write to one shared `${filePath}.tmp` and the read-modify-write helpers ran
 * unserialized, so two mutations touching the same file either raced on
 * `fs.rename` (ENOENT thrown out of a handler that reported success) or both
 * read the pre-write snapshot and the second write clobbered the first (a
 * silently dropped update). These tests drive the assignments.json and
 * registry.json paths concurrently and assert every update lands with no
 * rejection and intact JSON on disk. No mocks: these ops touch only the
 * filesystem.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyLocalInferenceManagementMutation } from "./local-inference-routes.js";

const originalStateDir = process.env.ELIZA_STATE_DIR;
let tempStateDir: string;

function localInferenceRoot(): string {
	return path.join(tempStateDir, "local-inference");
}

function readAssignmentsFile(): {
	version?: number;
	assignments: Record<string, string>;
} {
	return JSON.parse(
		readFileSync(path.join(localInferenceRoot(), "assignments.json"), "utf8"),
	);
}

function readRegistryFile(): {
	version?: number;
	models: Array<{ id: string; path: string }>;
} {
	return JSON.parse(
		readFileSync(path.join(localInferenceRoot(), "registry.json"), "utf8"),
	);
}

function seedRegistry(ids: string[]): void {
	const modelsDir = path.join(localInferenceRoot(), "models");
	mkdirSync(modelsDir, { recursive: true });
	const models = ids.map((id) => {
		const rel = `models/${id}.gguf`;
		const abs = path.join(localInferenceRoot(), rel);
		// readRegistry() stats the artifact and drops rows whose file is missing,
		// so every seeded id must have a real file under the root.
		writeFileSync(abs, "GGUFxxxx");
		return {
			id,
			displayName: id,
			path: rel,
			sizeBytes: 8,
			installedAt: "2026-05-17T06:17:00.000Z",
			lastUsedAt: null,
			source: "eliza-download" as const,
		};
	});
	writeFileSync(
		path.join(localInferenceRoot(), "registry.json"),
		JSON.stringify({ version: 1, models }),
	);
}

describe("local-inference concurrent config mutations (#25123)", () => {
	beforeEach(() => {
		tempStateDir = mkdtempSync(path.join(tmpdir(), "eliza-li-concurrency-"));
		process.env.ELIZA_STATE_DIR = tempStateDir;
		mkdirSync(localInferenceRoot(), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempStateDir, { recursive: true, force: true });
		if (originalStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
		else process.env.ELIZA_STATE_DIR = originalStateDir;
	});

	it("persists both slots when two set_assignment mutations run concurrently", async () => {
		const results = await Promise.all([
			applyLocalInferenceManagementMutation({
				op: "set_assignment",
				slot: "TEXT_SMALL",
				modelId: "eliza-1-2b",
			}),
			applyLocalInferenceManagementMutation({
				op: "set_assignment",
				slot: "TEXT_LARGE",
				modelId: "eliza-1-4b",
			}),
		]);

		// Neither call rejected, and each reported the write it performed.
		expect(results).toHaveLength(2);
		for (const result of results) {
			expect(result.op).toBe("set_assignment");
		}

		// The on-disk file — not just the return value — carries both writes.
		const file = readAssignmentsFile();
		expect(file.version).toBe(1);
		expect(file.assignments).toEqual({
			TEXT_SMALL: "eliza-1-2b",
			TEXT_LARGE: "eliza-1-4b",
		});
	});

	it("keeps every registry row when concurrent uninstalls hit registry.json", async () => {
		seedRegistry(["eliza-1-2b", "eliza-1-4b", "eliza-1-9b"]);

		const [removedA, removedB] = await Promise.all([
			applyLocalInferenceManagementMutation({
				op: "uninstall_model",
				modelId: "eliza-1-2b",
			}),
			applyLocalInferenceManagementMutation({
				op: "uninstall_model",
				modelId: "eliza-1-4b",
			}),
		]);

		// Both uninstalls actually removed their target; a lost update would have
		// resurrected one of the removed ids by writing the stale snapshot.
		expect(removedA).toMatchObject({ op: "uninstall_model", removed: true });
		expect(removedB).toMatchObject({ op: "uninstall_model", removed: true });

		const registry = readRegistryFile();
		expect(registry.version).toBe(1);
		const remainingIds = registry.models.map((model) => model.id).sort();
		expect(remainingIds).toEqual(["eliza-1-9b"]);
	});

	it("survives N concurrent set_assignment writes with intact JSON and no ENOENT", async () => {
		const slots = [
			"TEXT_SMALL",
			"TEXT_LARGE",
			"TEXT_EMBEDDING",
			"TEXT_TO_SPEECH",
			"TRANSCRIPTION",
		] as const;

		const results = await Promise.allSettled(
			slots.map((slot) =>
				applyLocalInferenceManagementMutation({
					op: "set_assignment",
					slot,
					modelId: "eliza-1-2b",
				}),
			),
		);

		// The shared-tmp rename race previously surfaced as a rejected mutation.
		for (const result of results) {
			expect(result.status).toBe("fulfilled");
		}

		// Final file is valid JSON and every distinct slot survived.
		const file = readAssignmentsFile();
		expect(file.version).toBe(1);
		expect(Object.keys(file.assignments).sort()).toEqual([...slots].sort());
		for (const slot of slots) {
			expect(file.assignments[slot]).toBe("eliza-1-2b");
		}
	});
});
