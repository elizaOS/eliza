/**
 * Router contract for a corrupt `assignments.json`: the local-inference
 * candidate gate must not reject the whole routed call (cloud candidates
 * included). It drops the unassigned local candidate, logs the store fault,
 * and leaves the damaged file on disk untouched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const engineState = { loaded: false };

vi.mock("./engine", () => ({
	localInferenceEngine: {
		hasLoadedModel: () => engineState.loaded,
		canTranscribeLocally: async () => false,
	},
}));

import { filterUnavailableLocalInference } from "./router-handler";

type Candidates = Parameters<typeof filterUnavailableLocalInference>[3];

const handler = vi.fn(async () => "ok");
const candidates: Candidates = [
	{
		modelType: "TEXT_SMALL",
		provider: "eliza-local-inference",
		priority: 0,
		handler,
	},
	{ modelType: "TEXT_SMALL", provider: "elizacloud", priority: 0, handler },
];

const originalStateDir = process.env.ELIZA_STATE_DIR;
const corruptBytes =
	'{"version": 1, "assignments": {"TEXT_SMALL": "eliza-1-4b"';
let assignmentFile: string;

beforeEach(() => {
	engineState.loaded = false;
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-router-"));
	process.env.ELIZA_STATE_DIR = stateDir;
	const root = path.join(stateDir, "local-inference");
	fs.mkdirSync(root, { recursive: true });
	assignmentFile = path.join(root, "assignments.json");
	fs.writeFileSync(assignmentFile, corruptBytes);
});

afterEach(() => {
	vi.restoreAllMocks();
	const stateDir = process.env.ELIZA_STATE_DIR;
	if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
	if (originalStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
	else process.env.ELIZA_STATE_DIR = originalStateDir;
});

describe("router with a corrupt assignments.json", () => {
	it("keeps non-local candidates routable and logs the store fault", async () => {
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		const routed = await filterUnavailableLocalInference(
			"TEXT_SMALL",
			"prefer-local",
			null,
			candidates,
		);

		expect(routed.map((candidate) => candidate.provider)).toEqual([
			"elizacloud",
		]);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				code: "ASSIGNMENTS_CORRUPT",
				slot: "TEXT_SMALL",
			}),
			expect.stringContaining("assignments are corrupt"),
		);
		expect(fs.readFileSync(assignmentFile, "utf8")).toBe(corruptBytes);
	});

	it("keeps local when a model is already loaded", async () => {
		vi.spyOn(logger, "error").mockImplementation(() => {});
		engineState.loaded = true;

		const routed = await filterUnavailableLocalInference(
			"TEXT_SMALL",
			"prefer-local",
			null,
			candidates,
		);

		expect(routed).toEqual(candidates);
	});
});
