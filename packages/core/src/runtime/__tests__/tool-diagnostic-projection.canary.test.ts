/**
 * Deterministic synthetic-canary harness for the tool-call diagnostic
 * projection (#19175). Proves the two halves of the contract at once: the
 * action handler receives the exact raw validated arguments (raw sentinel,
 * CLI --token form, URI userinfo, runtime-known secret), while JSON
 * serialization of every diagnostic egress surface — streaming onToolCall /
 * onToolResult payloads, ACTION_COMPLETED event content, trajectory
 * settlement parameters, planner queue/context/events, and the persisted
 * file-recorder trajectory — excludes those values. Stub runtime with vitest
 * mocks plus the real JSON-file recorder writing to a temp dir; no live
 * model. Every credential-shaped value is an obviously synthetic canary.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithStreamingContext } from "../../streaming-context";
import { runWithTrajectoryContext } from "../../trajectory-context";
import type { Action, IAgentRuntime, Memory } from "../../types";
import { EventType } from "../../types";
import { executePlannedToolCall } from "../execute-planned-tool-call";
import { runPlannerLoop } from "../planner-loop";
import { createJsonFileTrajectoryRecorder } from "../trajectory-recorder";

const RAW_SENTINEL = "SYNTHETIC-CANARY-RAW-SENTINEL-000000";
const RUNTIME_SECRET = "SYNTHETIC-CANARY-RUNTIME-SECRET-111111";
const FLAG_CANARY = "SYNTHETIC-CANARY-FLAG-222222";
const URI_CANARY = "SYNTHETIC-CANARY-URI-333333";

const CANARY_PARAMS = {
	command: `deploy --token=${FLAG_CANARY} ${RUNTIME_SECRET}`,
	target: `https://canary-user:${URI_CANARY}@synthetic.invalid/path`,
	note: RAW_SENTINEL,
	retries: 3,
	dryRun: false,
};

const CANARIES = [RUNTIME_SECRET, FLAG_CANARY, URI_CANARY] as const;

function expectNoCanaries(serialized: string): void {
	for (const canary of CANARIES) {
		expect(serialized).not.toContain(canary);
	}
}

function makeMessage(): Memory {
	return {
		id: "message-id",
		entityId: "entity-id",
		roomId: "room-id",
		content: { text: "run the canary" },
	} as Memory;
}

/** Runtime-known-secret redaction stub mirroring AgentRuntime.redactSecrets. */
function redactRuntimeSecrets(text: string): string {
	return text.split(RUNTIME_SECRET).join("[REDACTED:CANARY_SECRET]");
}

describe("tool-call diagnostic projection canaries", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("delivers exact raw arguments to the handler while every executor egress surface excludes the canaries", async () => {
		const seenParameters: unknown[] = [];
		const action: Action = {
			name: "CANARY_TOOL",
			description: "Records the exact parameters it receives",
			parameters: [
				{
					name: "command",
					description: "Command line",
					required: true,
					schema: { type: "string" },
				},
				{
					name: "target",
					description: "Target URL",
					required: true,
					schema: { type: "string" },
				},
				{
					name: "note",
					description: "Free-form note",
					required: true,
					schema: { type: "string" },
				},
				{
					name: "retries",
					description: "Retry count",
					required: false,
					schema: { type: "number" },
				},
				{
					name: "dryRun",
					description: "Dry-run switch",
					required: false,
					schema: { type: "boolean" },
				},
			],
			validate: async () => true,
			handler: async (_runtime, _message, _state, options) => {
				seenParameters.push(options?.parameters);
				return {
					success: true,
					text: `ran ${CANARY_PARAMS.command} against ${CANARY_PARAMS.target}`,
					data: { echoedCommand: CANARY_PARAMS.command, exitCode: 0 },
				};
			},
		};

		const emittedEvents: Array<{ event: string; payload: unknown }> = [];
		const trajectoryLogger = {
			isEnabled: vi.fn(() => true),
			startStep: vi.fn(() => "canary-step"),
			completeStep: vi.fn(),
			flushWriteQueue: vi.fn(async () => {}),
			annotateStep: vi.fn(async () => {}),
		};
		const completeStep = trajectoryLogger.completeStep;
		const runtime = {
			actions: [action],
			redactSecrets: redactRuntimeSecrets,
			emitEvent: vi.fn(async (event: string, payload: unknown) => {
				emittedEvents.push({ event, payload });
			}),
			getRoom: vi.fn(async () => null),
			getService: vi.fn((serviceType: string) =>
				serviceType === "trajectories" ? trajectoryLogger : undefined,
			),
			getServicesByType: vi.fn(() => []),
			reportError: vi.fn(),
			logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
		} as unknown as IAgentRuntime;

		const toolResults: unknown[] = [];
		const result = await runWithTrajectoryContext(
			{ trajectoryId: "canary-trajectory", trajectoryStepId: "canary-parent" },
			() =>
				runWithStreamingContext(
					{
						onStreamChunk: vi.fn(),
						onToolResult: vi.fn(async (payload: unknown) => {
							toolResults.push(payload);
						}),
					},
					() =>
						executePlannedToolCall(
							runtime,
							{ message: makeMessage() },
							{ id: "call-77", name: "CANARY_TOOL", params: CANARY_PARAMS },
						),
				),
		);
		expect(result.success).toBe(true);

		// The handler received the exact raw values — including the runtime-known
		// secret, the --token form, and the URI userinfo — untouched.
		expect(seenParameters).toHaveLength(1);
		expect(seenParameters[0]).toEqual(CANARY_PARAMS);
		const rawReceived = seenParameters[0] as typeof CANARY_PARAMS;
		expect(rawReceived.command).toBe(CANARY_PARAMS.command);
		expect(rawReceived.target).toBe(CANARY_PARAMS.target);
		expect(rawReceived.note).toBe(RAW_SENTINEL);

		// Streaming observer payload: no canaries, raw call identity preserved,
		// non-sensitive scalars intact.
		expect(toolResults).toHaveLength(1);
		const streamed = toolResults[0] as {
			toolCall: { id: string; arguments: Record<string, unknown> };
			toolCallId: string;
		};
		expectNoCanaries(JSON.stringify(streamed));
		expect(streamed.toolCall.id).toBe("call-77");
		expect(streamed.toolCallId).toBe("call-77");
		expect(streamed.toolCall.arguments.retries).toBe(3);
		expect(streamed.toolCall.arguments.dryRun).toBe(false);
		expect(streamed.toolCall.arguments.note).toBe(RAW_SENTINEL);

		// Lifecycle events (ACTION_STARTED / ACTION_COMPLETED): no canaries.
		expect(emittedEvents.map((entry) => entry.event)).toEqual([
			EventType.ACTION_STARTED,
			EventType.ACTION_COMPLETED,
		]);
		expectNoCanaries(JSON.stringify(emittedEvents));

		// Trajectory settlement (the completeStep funnel): no canaries, scalar
		// parameters preserved exactly.
		expect(completeStep).toHaveBeenCalledTimes(1);
		const settlement = completeStep.mock.calls[0]?.[2] as {
			parameters: Record<string, unknown>;
		};
		expectNoCanaries(JSON.stringify(completeStep.mock.calls[0]));
		expect(settlement.parameters.retries).toBe(3);
		expect(settlement.parameters.dryRun).toBe(false);
		expect(settlement.parameters.note).toBe(RAW_SENTINEL);
	});

	it("keeps planner queue/context/events and the persisted file trajectory canary-free while the executor sees raw params", async () => {
		const trajectoryRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "eliza-canary-trajectories-"),
		);
		const recorder = createJsonFileTrajectoryRecorder({
			enabled: true,
			rootDir: trajectoryRoot,
			redactSecrets: redactRuntimeSecrets,
		});
		const trajectoryId = recorder.startTrajectory({
			agentId: "canary-agent",
			rootMessage: { id: "root-msg", text: "run the canary" },
		});

		let plannerCall = 0;
		const runtime = {
			redactSecrets: redactRuntimeSecrets,
			useModel: vi.fn(async () => {
				plannerCall += 1;
				if (plannerCall === 1) {
					return {
						text: "",
						toolCalls: [
							{ id: "call-1", name: "CANARY_TOOL", arguments: CANARY_PARAMS },
						],
					};
				}
				return { text: "", toolCalls: [] };
			}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: `ran ${CANARY_PARAMS.command}`,
			data: { echoedTarget: CANARY_PARAMS.target },
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
			messageToUser: "Done.",
		}));

		const streamedToolCalls: unknown[] = [];
		const loopResult = await runWithStreamingContext(
			{
				onStreamChunk: vi.fn(),
				onToolCall: vi.fn(async (payload: unknown) => {
					streamedToolCalls.push(payload);
				}),
			},
			() =>
				runPlannerLoop({
					runtime,
					context: {
						id: "ctx",
						events: [
							{
								id: "msg",
								type: "message",
								message: { role: "user", content: { text: "run the canary" } },
							},
						],
					},
					executeToolCall,
					evaluate,
					recorder,
					trajectoryId,
				}),
		);
		await recorder.endTrajectory(trajectoryId, "finished");

		// The execution path received the exact raw call, id included.
		expect(executeToolCall).toHaveBeenCalledWith(
			{ id: "call-1", name: "CANARY_TOOL", params: CANARY_PARAMS },
			expect.objectContaining({ iteration: 1 }),
		);
		expect(loopResult.status).toBe("finished");

		// Streaming onToolCall (pending phase): projected, identity preserved.
		expect(streamedToolCalls).toHaveLength(1);
		const pending = streamedToolCalls[0] as {
			toolCall: { id: string; arguments: Record<string, unknown> };
		};
		expectNoCanaries(JSON.stringify(pending));
		expect(pending.toolCall.id).toBe("call-1");
		expect(pending.toolCall.arguments.retries).toBe(3);

		// Planner queue and context events: diagnostic copies exclude canaries;
		// the raw sentinel and scalars survive for correlation and debugging.
		const contextSerialized = JSON.stringify(loopResult.trajectory.context);
		expectNoCanaries(contextSerialized);
		expect(contextSerialized).toContain(RAW_SENTINEL);
		const queueEntry = loopResult.trajectory.context.plannedQueue?.[0] as {
			id?: string;
			args: string;
		};
		expect(queueEntry.id).toBe("call-1");
		expectNoCanaries(queueEntry.args);
		expect(queueEntry.args).toContain('"retries": 3');

		// The planner's own in-memory step kept the raw call for the ephemeral
		// path (result correlation, retry signatures).
		expect(
			loopResult.trajectory.steps.find((step) => step.toolCall)?.toolCall
				?.params,
		).toEqual(CANARY_PARAMS);

		// Persisted file trajectory (final persistence boundary): the on-disk
		// JSON — planner-stage toolCalls args, tool-stage args, and captured
		// tool I/O included — excludes every canary.
		const persistedPath = path.join(
			trajectoryRoot,
			"canary-agent",
			`${trajectoryId}.json`,
		);
		const persisted = await fs.readFile(persistedPath, "utf8");
		expectNoCanaries(persisted);
		expect(persisted).toContain("CANARY_TOOL");
		expect(persisted).toContain(RAW_SENTINEL);

		await fs.rm(trajectoryRoot, { recursive: true, force: true });
	});
});
