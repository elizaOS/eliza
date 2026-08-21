/**
 * Exercises continuation resolution through the real Cerebras-backed,
 * PGlite-backed message loop. The live harness proves directive and approval
 * turns execute the pending tool while an unrelated topic switch does not.
 */

import { randomUUID } from "node:crypto";
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
	type PlannerContinuationRunProgress,
	readCompletedPlannerContinuationTrajectory,
	serializePlannerContinuationEvidence,
	serializePlannerContinuationEvidenceStarted,
	writePlannerContinuationEvidenceArtifact,
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

const evidencePath = process.env.PR20227_EVIDENCE_PATH?.trim();
const runId = randomUUID();
const liveEnabled =
	process.env.ELIZA_RUN_LIVE_TESTS === "1" &&
	Boolean(process.env.CEREBRAS_API_KEY?.trim());
const liveDescribe = liveEnabled ? describe : describe.skip;

// A skipped describe block never runs beforeAll/afterAll, so without this a
// requested evidence path would silently keep whatever a previous *live* run
// last wrote there — a stale `captured` artifact reading as this (skipped)
// run's receipt. Write the honest status eagerly, at module load, before any
// test framework hook would fire.
if (!liveEnabled && evidencePath) {
	await writePlannerContinuationEvidenceArtifact(
		evidencePath,
		serializePlannerContinuationEvidence({
			runId,
			harness: undefined,
			evidence: [],
			progress: { totalCases: 0, completedCases: 0 },
			skipped: {
				reason:
					"live suite skipped: ELIZA_RUN_LIVE_TESTS=1 and CEREBRAS_API_KEY were not both set",
			},
		}),
	);
}

liveDescribe("planner continuation — live Cerebras message loop", () => {
	let harness: RealTestRuntimeResult | undefined;
	let setupError: unknown;
	let testError: unknown;
	const progress: PlannerContinuationRunProgress = {
		totalCases: 3,
		completedCases: 0,
	};
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
		try {
			harness = await createRealTestRuntime({
				characterName: "ContinuationProofAgent",
				withLLM: true,
				preferredProvider: "openai",
			});
			if (harness.providerConfig?.baseUrl !== "https://api.cerebras.ai/v1") {
				throw new Error(
					"Live continuation proof requires the Cerebras provider",
				);
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
			// Written only once setup fully succeeded (provider validated, both
			// actions registered) and before any of the three cases has run, so
			// an interrupted run leaves this — never a stale `captured` file, and
			// never a half-written final artifact (the final write is atomic).
			if (evidencePath) {
				await writePlannerContinuationEvidenceArtifact(
					evidencePath,
					serializePlannerContinuationEvidenceStarted(runId, harness),
				);
			}
		} catch (err) {
			setupError = err;
			throw err;
		}
	}, 180_000);

	afterAll(async () => {
		if (evidencePath) {
			await writePlannerContinuationEvidenceArtifact(
				evidencePath,
				serializePlannerContinuationEvidence({
					runId,
					harness,
					evidence,
					progress,
					setupError,
					testError,
				}),
			);
		}
		try {
			await harness?.cleanup();
		} catch (cleanupError) {
			// A would-be `captured` run whose teardown then fails is downgraded to
			// `cleanup-failed` so the artifact does not read as a fully clean run;
			// a run that already failed on its own terms keeps that more specific
			// status instead of being overwritten by the later teardown failure —
			// this is the same "don't let a second failure mask the first" defect
			// this file exists to fix, just one step later in the sequence.
			if (evidencePath) {
				await writePlannerContinuationEvidenceArtifact(
					evidencePath,
					serializePlannerContinuationEvidence({
						runId,
						harness,
						evidence,
						progress,
						setupError,
						testError,
						cleanupError,
					}),
				);
			}
			throw cleanupError;
		}
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
		// Recorded at the moment this case actually produced evidence — not
		// inferred later from `harness` or from the `it` body's own assertions —
		// so a `partial`/`test-failed` verdict reflects real progress even if a
		// later case or a later assertion in the same test throws.
		evidence.push(record);
		progress.completedCases += 1;
		return record;
	}

	it("executes directive and STOP-approved continuations without replaying on a topic switch", async () => {
		try {
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
		} catch (err) {
			testError = err;
			throw err;
		}
	}, 300_000);
});
