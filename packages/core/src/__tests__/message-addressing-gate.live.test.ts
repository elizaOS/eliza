/**
 * Exercises the group-addressing engagement gate through the real
 * Cerebras-backed, PGLite-backed message loop. The proof captures the raw
 * Stage-1 model response and contrasts an Alice-addressed ambient turn with a
 * turn that explicitly addresses the agent. Deterministic integration tests
 * separately force the post-Stage-1 engagement-gate branch.
 */

import {
	createRealTestRuntime,
	type RealTestRuntimeResult,
} from "@elizaos/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAssistantPlugin } from "../../../../plugins/plugin-assistant/src/index.ts";
import { createJsonFileTrajectoryRecorder } from "../../../../plugins/plugin-assistant/src/runtime/trajectory-recorder.ts";
import {
	ChannelType,
	createMessageMemory,
	type HandlerCallback,
	type Memory,
	stringToUuid,
	type UUID,
} from "../index.ts";

const liveDescribe =
	process.env.ELIZA_RUN_LIVE_TESTS === "1" &&
	process.env.CEREBRAS_API_KEY?.trim()
		? describe
		: describe.skip;

liveDescribe("group addressing gate — live Cerebras message loop", () => {
	let harness: RealTestRuntimeResult;

	beforeAll(async () => {
		harness = await createRealTestRuntime({
			characterName: "AddressingProofAgent",
			plugins: [createAssistantPlugin()],
			withLLM: true,
			preferredProvider: "openai",
		});
		if (harness.providerConfig?.baseUrl !== "https://api.cerebras.ai/v1") {
			throw new Error(
				"Live addressing-gate proof requires the Cerebras provider",
			);
		}
	}, 180_000);

	afterAll(async () => {
		await harness?.cleanup();
	});

	async function runGroupTurn(text: string) {
		const roomId = stringToUuid(`addressing-gate-room:${text}`) as UUID;
		const worldId = stringToUuid(`addressing-gate-world:${text}`) as UUID;
		const senderId = stringToUuid(`addressing-gate-sender:${text}`) as UUID;
		const aliceId = stringToUuid(`addressing-gate-alice:${text}`) as UUID;
		await harness.runtime.ensureConnection({
			entityId: senderId,
			roomId,
			worldId,
			userName: "Group speaker",
			source: "discord",
			channelId: roomId,
			type: ChannelType.GROUP,
		});
		await harness.runtime.ensureConnection({
			entityId: aliceId,
			roomId,
			worldId,
			userName: "Alice",
			source: "discord",
			channelId: roomId,
			type: ChannelType.GROUP,
		});
		const message: Memory = createMessageMemory({
			id: stringToUuid(`addressing-gate-message:${text}`) as UUID,
			entityId: senderId,
			roomId,
			content: {
				text,
				source: "discord",
				channelType: ChannelType.GROUP,
			},
		});
		const delivered: string[] = [];
		const callback: HandlerCallback = async (content) => {
			if (typeof content.text === "string" && content.text.trim()) {
				delivered.push(content.text);
			}
			return [];
		};
		const service = harness.runtime.messageService;
		if (!service) throw new Error("message service was not initialized");
		const startedAt = Date.now();
		const result = await service.handleMessage(
			harness.runtime,
			message,
			callback,
			{},
		);
		const recorder = createJsonFileTrajectoryRecorder();
		const read = async () =>
			(
				await recorder.list({
					agentId: harness.runtime.agentId,
					since: startedAt,
				})
			).find((record) => record.rootMessage.id === message.id);
		await expect
			.poll(async () => (await read())?.status, { timeout: 10000 })
			.toMatch(/^(finished|errored)$/);
		const trajectory = await read();
		if (!trajectory)
			throw new Error(
				"Live group turn has no recorded model evidence; enable ELIZA_TRAJECTORY_LOGGING",
			);
		const modelResponses =
			trajectory.stages.flatMap((stage) =>
				stage.model ? [stage.model.response] : [],
			) ?? [];
		return { delivered, message, modelResponses, result, trajectory };
	}

	it("suppresses an ambient Alice-addressed turn while preserving an agent-addressed control", async () => {
		const overheard = await runGroupTurn(
			"Alice, what is two plus two? Anyone who knows should jump in with the answer.",
		);
		expect(overheard.trajectory.status).toBe("finished");
		expect(overheard.modelResponses.length).toBeGreaterThan(0);
		expect(overheard.delivered).toEqual([]);
		expect(overheard.result.responseContent?.text?.trim() ?? "").toBe("");
		const overheardMessageId = overheard.message.id;
		if (!overheardMessageId) {
			throw new Error("live group message lost its deterministic id");
		}
		expect(
			await harness.runtime.getMemoryById(overheardMessageId),
		).not.toBeNull();

		const direct = await runGroupTurn(
			"AddressingProofAgent, how are you today?",
		);
		expect(direct.trajectory.status).toBe("finished");
		expect(direct.modelResponses.length).toBeGreaterThan(0);
		expect(
			direct.modelResponses.some((response) =>
				/"(?:shouldRespond|processMessage)"\s*:\s*"RESPOND"/i.test(response),
			),
		).toBe(true);
		expect(
			direct.delivered.length > 0 ||
				Boolean(direct.result.responseContent?.text?.trim()),
		).toBe(true);
	}, 240_000);
});
