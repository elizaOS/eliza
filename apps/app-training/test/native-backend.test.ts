import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runNativeBackend } from "../src/backends/native.js";
import type { LlmAdapter } from "../src/optimizers/index.js";

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "native-backend-"));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function writeJsonl(path: string, rows: unknown[]): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const body = rows.map((row) => JSON.stringify(row)).join("\n");
	writeFileSync(path, `${body}\n`, "utf-8");
}

const stubAdapter: LlmAdapter = {
	async complete(input) {
		const system = input.system ?? "";
		if (
			system.startsWith("You are a prompt engineer.") &&
			system.includes("Improve")
		) {
			return "PERFECT";
		}
		if (system === "PERFECT") return input.user;
		if (system === "BAD") return "WRONG";
		return input.user;
	},
};

describe("runNativeBackend", () => {
	it("optimizes a JSONL dataset and returns lineage", async () => {
		const datasetPath = join(workDir, "should_respond.jsonl");
		writeJsonl(datasetPath, [
			{
				messages: [
					{ role: "system", content: "BAD" },
					{ role: "user", content: "alpha" },
					{ role: "model", content: "alpha" },
				],
			},
			{
				messages: [
					{ role: "system", content: "BAD" },
					{ role: "user", content: "beta" },
					{ role: "model", content: "beta" },
				],
			},
		]);
		const result = await runNativeBackend({
			datasetPath,
			task: "should_respond",
			optimizer: "instruction-search",
			baselinePrompt: "BAD",
			runtime: { useModel: async () => "" },
			adapter: stubAdapter,
		});
		expect(result.invoked).toBe(true);
		expect(result.datasetSize).toBe(2);
		expect(result.baselineScore).toBe(0);
		expect(result.score).toBe(1);
		expect(result.result.optimizedPrompt).toBe("PERFECT");
		expect(result.result.lineage[0]?.notes).toBe("baseline");
	});

	it("returns invoked=false when the dataset has no usable rows", async () => {
		const datasetPath = join(workDir, "empty.jsonl");
		writeJsonl(datasetPath, [
			{ messages: [{ role: "system", content: "S" }] },
		]);
		const result = await runNativeBackend({
			datasetPath,
			task: "should_respond",
			optimizer: "bootstrap-fewshot",
			baselinePrompt: "BAD",
			runtime: { useModel: async () => "" },
			adapter: stubAdapter,
		});
		expect(result.invoked).toBe(false);
		expect(result.notes[0]).toContain("0 usable rows");
	});

	it("throws when the dataset file is missing", async () => {
		await expect(
			runNativeBackend({
				datasetPath: join(workDir, "missing.jsonl"),
				task: "response",
				optimizer: "instruction-search",
				baselinePrompt: "X",
				runtime: { useModel: async () => "" },
				adapter: stubAdapter,
			}),
		).rejects.toThrow(/dataset not found/);
	});
});
