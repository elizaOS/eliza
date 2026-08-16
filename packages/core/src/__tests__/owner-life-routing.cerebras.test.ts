/**
 * Live Cerebras proof that the direct-message Stage-1 floor routes owner todos
 * and alarms to their distinct canonical actions while VIEWS is available as
 * an adversarial alternative.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type Action,
	ChannelType,
	createMessageMemory,
	type HandlerCallback,
	type Memory,
	type Plugin,
	stringToUuid,
	type UUID,
} from "../index.ts";
import {
	createRealTestRuntime,
	type RealTestRuntimeResult,
} from "../testing/index.ts";

interface LiveTrajectoryDetail {
	metrics?: { finalStatus?: string };
	steps?: Array<{ llmCalls?: Array<{ response?: string }> }>;
}

interface LiveTrajectoryService {
	flushWriteQueue?: (trajectoryId: string) => Promise<void>;
	getTrajectoryDetail?: (
		trajectoryId: string,
	) => Promise<LiveTrajectoryDetail | null>;
}

function proofAction(name: string): Action {
	return {
		name,
		description: `Deterministic live routing proof surface for ${name}.`,
		validate: async () => true,
		handler: async () => ({ success: true, text: `${name} selected` }),
	};
}

const routingProofPlugin: Plugin = {
	name: "owner-life-routing-live-proof",
	description:
		"Registers canonical owner-life actions plus VIEWS for live routing proof.",
	actions: [
		proofAction("OWNER_GOALS"),
		proofAction("OWNER_TODOS"),
		proofAction("OWNER_REMINDERS"),
		proofAction("OWNER_ALARMS"),
		proofAction("OWNER_ROUTINES"),
		proofAction("VIEWS"),
	],
};

const liveDescribe =
	process.env.ELIZA_RUN_LIVE_TESTS === "1" &&
	process.env.CEREBRAS_API_KEY?.trim()
		? describe
		: describe.skip;

liveDescribe("owner-life Stage-1 routing — live Cerebras", () => {
	let harness: RealTestRuntimeResult;

	beforeAll(async () => {
		harness = await createRealTestRuntime({
			characterName: "OwnerRoutingProofAgent",
			plugins: [routingProofPlugin],
			preferredProvider: "openai",
			withLLM: true,
		});
	}, 180_000);

	afterAll(async () => {
		await harness?.cleanup();
	});

	async function runTurn(text: string): Promise<string[]> {
		const roomId = stringToUuid(`owner-routing-room:${text}`) as UUID;
		const entityId = stringToUuid(`owner-routing-user:${text}`) as UUID;
		const worldId = stringToUuid("owner-routing-world") as UUID;
		await harness.runtime.ensureConnection({
			channelId: roomId,
			entityId,
			roomId,
			worldId,
			source: "api_private",
			type: ChannelType.DM,
			userName: "Owner",
		});
		const message: Memory = createMessageMemory({
			entityId,
			id: stringToUuid(`owner-routing-message:${text}`) as UUID,
			roomId,
			content: { channelType: ChannelType.DM, source: "api_private", text },
		});
		const callback: HandlerCallback = async () => [];
		const service = harness.runtime.messageService;
		if (!service) throw new Error("message service was not initialized");
		await service.handleMessage(harness.runtime, message, callback, {});
		const trajectoryId = (message.metadata as { trajectoryId?: unknown } | null)
			?.trajectoryId;
		if (typeof trajectoryId !== "string") {
			throw new Error("live turn did not create a trajectory");
		}
		const trajectories = harness.runtime.getService(
			"trajectories",
		) as LiveTrajectoryService | null;
		let trajectory: LiveTrajectoryDetail | null = null;
		for (let attempt = 0; attempt < 50; attempt += 1) {
			await trajectories?.flushWriteQueue?.(trajectoryId);
			trajectory =
				(await trajectories?.getTrajectoryDetail?.(trajectoryId)) ?? null;
			if (trajectory?.metrics?.finalStatus === "completed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		if (!trajectory) throw new Error("live trajectory was not persisted");
		return (
			trajectory.steps
				?.flatMap((step) => step.llmCalls ?? [])
				.map((call) => call.response)
				.filter((response): response is string => Boolean(response?.trim())) ??
			[]
		);
	}

	it("selects OWNER_TODOS and OWNER_ALARMS instead of VIEWS", async () => {
		const todo = await runTurn("add a todo: water the ferns. no due date.");
		const alarm = await runTurn("set an alarm for 7am tomorrow");
		console.log(JSON.stringify({ alarm, todo }, null, 2));
		expect(todo.some((output) => output.includes("OWNER_TODOS"))).toBe(true);
		expect(alarm.some((output) => output.includes("OWNER_ALARMS"))).toBe(true);
		expect(todo.some((output) => output.includes('"VIEWS"'))).toBe(false);
		expect(alarm.some((output) => output.includes('"VIEWS"'))).toBe(false);
	}, 240_000);
});
