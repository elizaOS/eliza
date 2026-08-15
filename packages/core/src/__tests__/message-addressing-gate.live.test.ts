/**
 * Exercises the group-addressing engagement gate through the real
 * Cerebras-backed, PGLite-backed message loop. The proof captures the raw
 * Stage-1 model response and contrasts an Alice-addressed ambient turn with a
 * turn that explicitly addresses the agent. Deterministic integration tests
 * separately force the post-Stage-1 engagement-gate branch.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	ChannelType,
	createMessageMemory,
	type HandlerCallback,
	type Memory,
	stringToUuid,
	type UUID,
} from "../index.ts";
import {
	createRealTestRuntime,
	type RealTestRuntimeResult,
} from "../testing/index.ts";

interface LiveTrajectoryDetail {
	metrics?: { finalStatus?: string };
	steps?: Array<{
		llmCalls?: Array<{
			provider?: string;
			response?: string;
		}>;
	}>;
}

interface LiveTrajectoryService {
	flushWriteQueue?: (trajectoryId: string) => Promise<void>;
	getTrajectoryDetail?: (
		trajectoryId: string,
	) => Promise<LiveTrajectoryDetail | null>;
}

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
		const result = await service.handleMessage(
			harness.runtime,
			message,
			callback,
			{},
		);
		const trajectoryId = (message.metadata as { trajectoryId?: unknown } | null)
			?.trajectoryId;
		if (typeof trajectoryId !== "string" || !trajectoryId.trim()) {
			throw new Error("live group turn did not create a trajectory");
		}
		const trajectoryService = harness.runtime.getService(
			"trajectories",
		) as LiveTrajectoryService | null;
		if (typeof trajectoryService?.getTrajectoryDetail !== "function") {
			throw new Error("live group turn has no readable trajectory service");
		}
		let trajectory: LiveTrajectoryDetail | null = null;
		for (let attempt = 0; attempt < 50; attempt += 1) {
			await trajectoryService.flushWriteQueue?.(trajectoryId);
			trajectory = await trajectoryService.getTrajectoryDetail(trajectoryId);
			if (trajectory?.metrics?.finalStatus === "completed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		if (!trajectory) throw new Error("live group trajectory was not persisted");
		const modelResponses =
			trajectory.steps
				?.flatMap((step) => step.llmCalls ?? [])
				.map((call) => call.response)
				.filter((response): response is string => Boolean(response?.trim())) ??
			[];
		return { delivered, message, modelResponses, result, trajectory };
	}

	it("suppresses an ambient Alice-addressed turn while preserving an agent-addressed control", async () => {
		const overheard = await runGroupTurn(
			"Alice, what is two plus two? Anyone who knows should jump in with the answer.",
		);
		expect(overheard.trajectory.metrics?.finalStatus).toBe("completed");
		expect(overheard.modelResponses.length).toBeGreaterThan(0);
		expect(
			overheard.modelResponses.some((response) =>
				/"shouldRespond"\s*:\s*"IGNORE"/i.test(response),
			),
			JSON.stringify({ modelResponses: overheard.modelResponses }),
		).toBe(true);
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
		expect(direct.trajectory.metrics?.finalStatus).toBe("completed");
		expect(
			direct.delivered.length > 0 ||
				typeof direct.result.responseContent?.text === "string",
		).toBe(true);
	}, 240_000);
});
