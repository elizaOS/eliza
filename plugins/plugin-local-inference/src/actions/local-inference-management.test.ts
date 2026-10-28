/**
 * Verifies chat and voice action parameters persist local-inference preferences.
 * The route mutation module is preloaded during collection so its intentionally
 * lazy production import cannot outlive a timed-out test and mutate the next
 * test's process-global state directory.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
		expect(result?.text).toBe(
			"Preferred provider for TEXT_LARGE is now eliza-local-inference.",
		);
	}, 15_000);

	it("reports a cleared provider or assignment as cleared, not updated", async () => {
		const call = (parameters: Record<string, unknown>) =>
			localInferenceManagementAction.handler(
				{} as IAgentRuntime,
				{} as Memory,
				undefined,
				{ parameters },
			);

		const provider = await call({
			action: "set_preferred_provider",
			slot: "TEXT_LARGE",
		});
		expect(provider?.success).toBe(true);
		expect(provider?.text).toBe(
			"Preferred provider for TEXT_LARGE was cleared.",
		);

		const assignment = await call({
			action: "set_assignment",
			slot: "TEXT_SMALL",
		});
		expect(assignment?.success).toBe(true);
		expect(assignment?.text).toBe(
			"Local model assignment for TEXT_SMALL was cleared.",
		);
	}, 15_000);

	it("reports an uninstall or cancel that changed nothing as a failure", async () => {
		const call = (parameters: Record<string, unknown>) =>
			localInferenceManagementAction.handler(
				{} as IAgentRuntime,
				{} as Memory,
				undefined,
				{ parameters },
			);

		const uninstall = await call({
			action: "uninstall_model",
			modelId: "not-installed",
		});
		expect(uninstall?.success).toBe(false);
		expect(uninstall?.text).toBe(
			"Model not-installed was not removed: it is not installed, or it is an external model Eliza does not own.",
		);
		expect(uninstall?.data).toMatchObject({
			op: "uninstall_model",
			removed: false,
		});

		const cancel = await call({
			action: "cancel_download",
			modelId: "not-downloading",
		});
		expect(cancel?.success).toBe(false);
		expect(cancel?.text).toBe("No download in progress for not-downloading.");
		expect(cancel?.data).toMatchObject({
			op: "cancel_download",
			cancelled: false,
		});
	}, 15_000);

	it("names the declared voiceModelId argument when it is missing", async () => {
		const result = await localInferenceManagementAction.handler(
			{} as IAgentRuntime,
			{} as Memory,
			undefined,
			{ parameters: { action: "pin_voice_model", pinned: true } },
		);

		expect(result?.success).toBe(false);
		expect(result?.text).toBe("pin_voice_model requires voiceModelId.");
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
		expect(result?.text).toBe(
			"Local model assignment for TEXT_SMALL is now eliza-1-2b.",
		);
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
		expect(result?.text).toBe("Voice model wakeword is now pinned.");
	}, 15_000);

	it("rejects pin_voice_model without pinned and keeps the existing pin", async () => {
		const call = (parameters: Record<string, unknown>) =>
			localInferenceManagementAction.handler(
				{} as IAgentRuntime,
				{} as Memory,
				undefined,
				{ parameters },
			);
		await call({
			action: "pin_voice_model",
			voiceModelId: "mobile-voice",
			pinned: true,
		});

		const result = await call({
			action: "pin_voice_model",
			voiceModelId: "mobile-voice",
		});

		expect(result?.success).toBe(false);
		expect(result?.text).toBe(
			"pin_voice_model requires pinned: true to pin or false to unpin",
		);
		const pins = JSON.parse(
			readFileSync(
				path.join(stateDir, "local-inference", "voice-update-pins.json"),
				"utf8",
			),
		);
		expect(pins.pinned).toEqual(["mobile-voice"]);
	}, 15_000);
	it("persists quiet hours and refuses malformed replacements without changing preferences", async () => {
		const call = (quietHours: unknown) =>
			localInferenceManagementAction.handler(
				{} as IAgentRuntime,
				{} as Memory,
				undefined,
				{ parameters: { action: "set_voice_model_preferences", quietHours } },
			);
		const quietHours = [{ start: "22:00", end: "07:00" }];
		expect((await call(quietHours))?.success).toBe(true);
		const file = path.join(
			stateDir,
			"local-inference",
			"voice-update-prefs.json",
		);
		const before = readFileSync(file, "utf8");
		expect(JSON.parse(before).quietHours).toEqual(quietHours);
		for (const invalid of [
			[{ start: "23:00" }],
			[{ start: "25:00", end: "07:00" }],
			"22:00-07:00",
			[null],
		]) {
			expect((await call(invalid))?.success).toBe(false);
			expect(readFileSync(file, "utf8")).toBe(before);
		}
		expect((await call([]))?.success).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8")).quietHours).toEqual([]);
	}, 15_000);
});
