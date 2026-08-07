/**
 * Verifies chat and voice action parameters persist local-inference preferences.
 * The route mutation module is preloaded during collection so its intentionally
 * lazy production import cannot outlive a timed-out test and mutate the next
 * test's process-global state directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../local-inference-routes";
import { localInferenceManagementAction } from "./local-inference-management";

describe("LOCAL_INFERENCE action twins", () => {
	const previousStateDir = process.env.ELIZA_STATE_DIR;
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), "li-action-"));
		process.env.ELIZA_STATE_DIR = stateDir;
	});

	afterEach(() => {
		if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
		else process.env.ELIZA_STATE_DIR = previousStateDir;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("mutates routing preferences from chat/voice action parameters", async () => {
		const result = await localInferenceManagementAction.handler(
			{} as IAgentRuntime,
			{} as Memory,
			undefined,
			{
				parameters: {
					action: "set_preferred_provider",
					slot: "TEXT_LARGE",
					provider: "eliza-local-inference",
				},
			},
		);

		expect(result?.success).toBe(true);
		expect(result?.data).toMatchObject({
			actionName: "LOCAL_INFERENCE",
			op: "set_preferred_provider",
			slot: "TEXT_LARGE",
			provider: "eliza-local-inference",
		});
	}, 15_000);

	it("mutates curated model assignments from chat/voice action parameters", async () => {
		const result = await localInferenceManagementAction.handler(
			{} as IAgentRuntime,
			{} as Memory,
			undefined,
			{
				parameters: {
					action: "set_assignment",
					slot: "TEXT_SMALL",
					modelId: "eliza-1-2b",
				},
			},
		);

		expect(result?.success).toBe(true);
		expect(result?.data).toMatchObject({
			actionName: "LOCAL_INFERENCE",
			op: "set_assignment",
			slot: "TEXT_SMALL",
			modelId: "eliza-1-2b",
		});
	}, 15_000);

	it("pins voice sub-models from chat/voice action parameters", async () => {
		const result = await localInferenceManagementAction.handler(
			{} as IAgentRuntime,
			{} as Memory,
			undefined,
			{
				parameters: {
					action: "pin_voice_model",
					voiceModelId: "wakeword",
					pinned: true,
				},
			},
		);

		expect(result?.success).toBe(true);
		expect(result?.data).toMatchObject({
			actionName: "LOCAL_INFERENCE",
			op: "pin_voice_model",
			id: "wakeword",
			pinned: true,
		});
	}, 15_000);
});
