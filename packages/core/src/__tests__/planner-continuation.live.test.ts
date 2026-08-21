/**
 * Exercises continuation resolution through the real Cerebras-backed,
 * PGlite-backed message loop. The live harness proves directive and approval
 * turns execute the pending tool while an unrelated topic switch does not.
 */

import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import {
	readCompletedPlannerContinuationTrajectory,
	serializePlannerContinuationEvidence,
} from "./planner-continuation-trajectory.ts";

interface LiveTrajectoryDetail {
	metrics?: { finalStatus?: string };
	steps?: Array<{
		llmCalls?: Array<{
			provider?: string;
			model?: string;
			response?: string;
		}>;
	}>;
}

const liveDescribe =
	process.env.ELIZA_RUN_LIVE_TESTS === "1" &&
	process.env.CEREBRAS_API_KEY?.trim()
		? describe
		: describe.skip;

liveDescribe("planner continuation — live Cerebras message loop", () => {
	let harness: RealTestRuntimeResult;
	const toolCalls = vi.fn(async (_runtime, _message, _state, _options) => ({
		success: true,
		text: "Filesystem usage: 42%",
	}));
	const webCalls = vi.fn(async (_runtime, _message, _state, _options) => ({
		success: true,
		text: "Tokyo is 24°C with clear skies.",
	}));
	const evidence: Array<Record<string, unknown>> = [];

	beforeAll(async () => {
		harness = await createRealTestRuntime({
			characterName: "ContinuationProofAgent",
			withLLM: true,
			preferredProvider: "openai",
		});
		if (harness.providerConfig?.baseUrl !== "https://api.cerebras.ai/v1") {
			throw new Error("Live continuation proof requires the Cerebras provider");
		}
		harness.runtime.registerAction({
			name: "SHELL",
			similes: ["RUN_SHELL_COMMAND"],
			description: "Run a local shell command and return its output.",
			tags: ["shell-direct"],
			contextGate: {},
			roleGate: {},
			parameters: [
				{
					name: "command",
					description: "The shell command to run",
					required: true,
					schema: { type: "string" },
				},
			],
			examples: [],
			validate: async () => true,
			handler: toolCalls,
		});
		harness.runtime.registerAction({
			name: "WEB_SEARCH",
			similes: ["SEARCH_WEB"],
			description: "Search the web for current information.",
			tags: ["web-search"],
			contextGate: {},
			roleGate: {},
			parameters: [
				{
					name: "query",
					description: "The web search query",
					required: true,
					schema: { type: "string" },
				},
			],
			examples: [],
			validate: async () => true,
			handler: webCalls,
		});
	}, 180_000);

	afterAll(async () => {
		const evidencePath = process.env.PR20227_EVIDENCE_PATH?.trim();
		if (evidencePath) {
			await writeFile(
				evidencePath,
				serializePlannerContinuationEvidence(harness, evidence),
			);
		}
		await harness?.cleanup();
	});

	async function runTurn(params: {
		caseName: string;
		assistantActions?: string[];
		currentText: string;
	}) {
		const roomId = stringToUuid(`continuation-room:${params.caseName}`) as UUID;
		const worldId = stringToUuid(
			`continuation-world:${params.caseName}`,
		) as UUID;
		const senderId = stringToUuid(
			`continuation-sender:${params.caseName}`,
		) as UUID;
		await harness.runtime.ensureConnection({
			entityId: senderId,
			roomId,
			worldId,
			userName: "Continuation requester",
			source: "test",
			channelId: roomId,
			type: ChannelType.DM,
		});

		const priorUser = createMessageMemory({
			id: stringToUuid(`continuation-prior-user:${params.caseName}`) as UUID,
			entityId: senderId,
			roomId,
			createdAt: 1,
			content: {
				text: "show me disk usage on this server",
				source: "test",
				channelType: ChannelType.DM,
			},
		});
		const priorAssistant = createMessageMemory({
			id: stringToUuid(`continuation-prior-agent:${params.caseName}`) as UUID,
			entityId: harness.runtime.agentId,
			roomId,
			createdAt: 2,
			content: {
				text: "On it when you are ready.",
				source: "test",
				channelType: ChannelType.DM,
				actions: params.assistantActions,
			},
		});
		await harness.runtime.createMemory(priorUser, "messages");
		await harness.runtime.createMemory(priorAssistant, "messages");

		const message: Memory = createMessageMemory({
			id: stringToUuid(`continuation-current:${params.caseName}`) as UUID,
			entityId: senderId,
			roomId,
			createdAt: 3,
			content: {
				text: params.currentText,
				source: "test",
				channelType: ChannelType.DM,
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
		const toolCallsBefore = toolCalls.mock.calls.length;
		const webCallsBefore = webCalls.mock.calls.length;
		const result = await service.handleMessage(
			harness.runtime,
			message,
			callback,
			{},
		);

		const trajectoryId = (message.metadata as { trajectoryId?: unknown } | null)
			?.trajectoryId;
		if (typeof trajectoryId !== "string" || !trajectoryId.trim()) {
			throw new Error("live continuation turn did not create a trajectory");
		}
		const trajectoryService = harness.runtime.getService("trajectories");
		const trajectory =
			await readCompletedPlannerContinuationTrajectory<LiveTrajectoryDetail>(
				harness.runtime,
				trajectoryId,
				trajectoryService,
			);
		const modelResponses =
			trajectory.steps
				?.flatMap((step) => step.llmCalls ?? [])
				.map((call) => ({
					provider: call.provider,
					model: call.model,
					response: call.response,
				}))
				.filter((call) => Boolean(call.response?.trim())) ?? [];
		const record = {
			caseName: params.caseName,
			trajectoryId,
			priorUser: priorUser.content,
			priorAssistant: priorAssistant.content,
			currentText: params.currentText,
			shellToolCalls: toolCalls.mock.calls.length - toolCallsBefore,
			webToolCalls: webCalls.mock.calls.length - webCallsBefore,
			delivered,
			responseContent: result.responseContent,
			trajectoryStatus: trajectory.metrics?.finalStatus,
			modelResponses,
		};
		evidence.push(record);
		return record;
	}

	it("executes directive and STOP-approved continuations without replaying on a topic switch", async () => {
		const directive = await runTurn({
			caseName: "directive",
			currentText: "finish my request",
		});
		expect(directive.trajectoryStatus).toBe("completed");
		expect(directive.modelResponses.length).toBeGreaterThan(0);
		expect(directive.shellToolCalls).toBe(1);
		expect(directive.webToolCalls).toBe(0);

		const approvalAfterStop = await runTurn({
			caseName: "approval-after-stop",
			assistantActions: ["STOP"],
			currentText: "that is good",
		});
		expect(approvalAfterStop.trajectoryStatus).toBe("completed");
		expect(approvalAfterStop.modelResponses.length).toBeGreaterThan(0);
		expect(approvalAfterStop.shellToolCalls).toBe(1);
		expect(approvalAfterStop.webToolCalls).toBe(0);

		const topicSwitch = await runTurn({
			caseName: "topic-switch",
			currentText: "What is the weather in Tokyo right now?",
		});
		expect(topicSwitch.trajectoryStatus).toBe("completed");
		expect(topicSwitch.modelResponses.length).toBeGreaterThan(0);
		expect(topicSwitch.shellToolCalls).toBe(0);
		expect(topicSwitch.webToolCalls).toBe(1);
	}, 300_000);
});
