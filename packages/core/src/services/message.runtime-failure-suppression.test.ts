/**
 * Failure-reply gating when the v5 message runtime dies BEFORE any
 * RESPOND/IGNORE decision exists.
 *
 * Rate limits and provider outages throw from the Stage 1 model call itself,
 * so no shouldRespond decision was ever made for the turn. The old behavior
 * unconditionally sent the canned "something went wrong" reply — observed
 * live as 91 canned-failure sends in 2 days into group relay rooms that never
 * addressed the agent. The pipeline must:
 *
 *   1. stay SILENT (terminal IGNORE, no user-visible text) when the failing
 *      turn was ambiguous group traffic the agent would have ignored, and
 *   2. still surface the failure text when the turn deterministically
 *      addressed the agent (platform mention/reply, DM/API channel).
 *
 * These tests drive the real `DefaultMessageService.handleMessage` pipeline —
 * memory persistence, room fetch, Stage 1 dispatch, the failure catch, and
 * terminal delivery — with only the runtime I/O surface mocked. The Stage 1
 * `useModel` call rejects with a real provider rate-limit error, exactly like
 * the live incident.
 */

import { v4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import {
	TurnAbortedError,
	TurnControllerRegistry,
} from "../runtime/turn-controller";
import { getStreamingContext } from "../streaming-context";
import { createMockRuntime } from "../testing/mock-runtime";
import type { EffectReceipt } from "../types/effects";
import type { Room } from "../types/environment";
import type { Memory } from "../types/memory";
import {
	asUUID,
	ChannelType,
	type Content,
	type UUID,
} from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import { DefaultMessageService } from "./message";

const AGENT = "00000000-0000-0000-0000-00000000000a" as UUID;
const ENTITY = "00000000-0000-0000-0000-00000000000b" as UUID;
const ROOM = "00000000-0000-0000-0000-00000000000c" as UUID;
const RUN_ID = "00000000-0000-0000-0000-00000000000d" as UUID;

const RATE_LIMIT_ERROR = new Error(
	"[cli-inference:sdk] subscription rate limit reached: You've hit your session limit",
);

function makeMessage(overrides: Partial<Content> = {}): Memory {
	return {
		id: asUUID(v4()),
		entityId: ENTITY,
		agentId: AGENT,
		roomId: ROOM,
		content: {
			text: "anyone up for a raid tonight?",
			source: "discord",
			channelType: ChannelType.GROUP,
			...overrides,
		},
		createdAt: Date.now(),
	};
}

function makeState(): State {
	return { values: {}, data: {}, text: "" };
}

function makeFailingRuntime(room: Room): IAgentRuntime {
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return createMockRuntime({
		agentId: AGENT,
		character: {
			name: "Remilio",
			bio: "test agent",
		},
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		} as unknown as IAgentRuntime["logger"],
		getSetting: vi.fn(() => undefined),
		getService: vi.fn(() => null),
		getModel: vi.fn(() => async () => {
			throw RATE_LIMIT_ERROR;
		}),
		// Stage 1 RESPONSE_HANDLER dies with a provider rate limit — the same
		// shape as the live incident. Every other model call (the failure-reply
		// generator retries TEXT_* models) fails the same way, which routes
		// buildStructuredFailureReply onto its rate-limited template path.
		useModel: vi.fn(async () => {
			throw RATE_LIMIT_ERROR;
		}),
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		applyPipelineHooks: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		reportError: vi.fn(),
		startRun: vi.fn(() => RUN_ID),
		getCurrentRunId: vi.fn(() => RUN_ID),
		endRun: vi.fn(),
		getMemoryById: vi.fn(async () => null),
		createMemory: vi.fn(async () => asUUID(v4())),
		updateMemory: vi.fn(async () => true),
		queueEmbeddingGeneration: vi.fn(async () => undefined),
		getParticipantUserState: vi.fn(async () => null),
		getRoom: vi.fn(async () => room),
		getRoomsByIds: vi.fn(async () => [room]),
		getMemories: vi.fn(async () => []),
		isCheckShouldRespondEnabled: vi.fn(() => true),
		turnControllers: new TurnControllerRegistry(),
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
	});
}

function makeRoom(type: ChannelType): Room {
	return {
		id: ROOM,
		source: "discord",
		type,
	} as Room;
}

async function runTurn(message: Memory, room: Room) {
	const runtime = makeFailingRuntime(room);
	const service = new DefaultMessageService();
	const deliveries: Content[] = [];
	const result = await service.handleMessage(
		runtime,
		message,
		async (content) => {
			deliveries.push(content);
			return [];
		},
	);
	// Everything the callback delivered with visible text — what a connector
	// would actually post to the channel.
	const visibleTexts = deliveries
		.map((content) => (typeof content.text === "string" ? content.text : ""))
		.filter((text) => text.trim().length > 0);
	return { runtime, result, deliveries, visibleTexts };
}

describe("v5 runtime failure before a respond decision", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("stays silent on ambiguous group traffic the agent would have ignored", async () => {
		const { result, deliveries, visibleTexts } = await runTurn(
			makeMessage(),
			makeRoom(ChannelType.GROUP),
		);

		// No user-visible text may leave the pipeline — the canned failure
		// reply into an unaddressed relay room was the bug.
		expect(visibleTexts).toEqual([]);
		expect(result.didRespond).toBe(false);
		// The turn resolves as a terminal IGNORE, exactly like the decision the
		// agent would have made had Stage 1 survived.
		const terminal = deliveries.find((content) =>
			Array.isArray(content.actions),
		);
		expect(terminal?.actions).toEqual(["IGNORE"]);
	});

	it("still surfaces the failure reply when the agent was platform-mentioned", async () => {
		const { result, visibleTexts } = await runTurn(
			makeMessage({
				text: "@Remilio what's the plan?",
				mentionContext: { isMention: true },
			}),
			makeRoom(ChannelType.GROUP),
		);

		expect(result.didRespond).toBe(true);
		expect(visibleTexts).toHaveLength(1);
		// buildStructuredFailureReply lands on the rate-limited template since
		// every model call in this turn is rate-limited.
		expect(visibleTexts[0].toLowerCase()).toContain("rate-limit");
	});

	it.each([
		RATE_LIMIT_ERROR,
		Object.assign(new Error("Local text model is not installed"), {
			name: "VoiceLifecycleError",
			code: "arm-failed",
		}),
		new Error("Unexpected provider failure"),
	])(
		"keeps %s diagnostic-only while delivering one DM failure",
		async (error) => {
			const runtime = makeFailingRuntime(makeRoom(ChannelType.DM));
			vi.mocked(runtime.useModel).mockRejectedValue(error);
			const visibleTexts: string[] = [];
			const result = await new DefaultMessageService().handleMessage(
				runtime,
				makeMessage({ channelType: ChannelType.DM }),
				async (content) => {
					if (content.text) visibleTexts.push(content.text);
					return [];
				},
			);
			expect(runtime.reportError).toHaveBeenCalledWith(
				"MessageService.v5Runtime",
				error,
				expect.objectContaining({ diagnosticOnly: true }),
			);

			expect(result.didRespond).toBe(true);
			expect(visibleTexts).toHaveLength(1);
		},
	);

	it("propagates exhausted reply grounding without a second apology model pass", async () => {
		const runtime = makeFailingRuntime(makeRoom(ChannelType.DM));
		const failure = Object.assign(new Error("Grounded reply unavailable"), {
			code: "REPLY_GROUNDING_FAILED",
		});
		runtime.useModel = vi.fn(async () => {
			throw failure;
		}) as IAgentRuntime["useModel"];
		const callback = vi.fn(async () => []);
		await expect(
			new DefaultMessageService().handleMessage(
				runtime,
				makeMessage({ channelType: ChannelType.DM }),
				callback,
			),
		).rejects.toBe(failure);
		expect(
			vi
				.mocked(runtime.useModel)
				.mock.calls.map(([modelType]) => String(modelType))
				.filter((modelType) => modelType !== "TEXT_EMBEDDING"),
		).toEqual(["RESPONSE_HANDLER"]);
		expect(callback).not.toHaveBeenCalled();
	});

	it("propagates caller cancellation without generating a failure reply", async () => {
		const runtime = makeFailingRuntime(makeRoom(ChannelType.DM));
		const controller = new AbortController();
		const abortReason = new DOMException("client disconnected", "AbortError");
		const modelCallTypes: string[] = [];
		runtime.useModel = vi.fn(async (modelType: unknown) => {
			modelCallTypes.push(String(modelType));
			if (String(modelType) !== "RESPONSE_HANDLER") return [];
			controller.abort(abortReason);
			throw abortReason;
		}) as IAgentRuntime["useModel"];
		const service = new DefaultMessageService();
		const deliveries: Content[] = [];

		await expect(
			service.handleMessage(
				runtime,
				makeMessage({ channelType: ChannelType.DM }),
				async (content) => {
					deliveries.push(content);
					return [];
				},
				{ abortSignal: controller.signal },
			),
		).rejects.toMatchObject({
			code: "TURN_ABORTED",
			reason: "client disconnected",
		});
		expect(
			modelCallTypes.filter((modelType) => modelType !== "TEXT_EMBEDDING"),
		).toEqual(["RESPONSE_HANDLER"]);
		expect(deliveries).toEqual([]);
	});

	it("keeps a cancellation-only route turn off streaming while propagating abort", async () => {
		const runtime = makeFailingRuntime(makeRoom(ChannelType.DM));
		const controller = new AbortController();
		const abortReason = new DOMException("route disconnected", "AbortError");
		const deliveries: Content[] = [];
		let releaseEntered: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			releaseEntered = resolve;
		});
		const observed: { stream: boolean; hasSignal: boolean }[] = [];
		const service = new DefaultMessageService();
		const serviceProbe = service as unknown as {
			processMessage: (...args: unknown[]) => Promise<never>;
		};

		serviceProbe.processMessage = vi.fn(async () => {
			const context = getStreamingContext();
			observed.push({
				stream: context?.onStreamChunk !== undefined,
				hasSignal: context?.abortSignal !== undefined,
			});
			releaseEntered?.();
			if (!context?.abortSignal) {
				throw new Error("expected the route-owned abort signal");
			}
			await new Promise<never>((_resolve, reject) => {
				context.abortSignal?.addEventListener(
					"abort",
					() => reject(context.abortSignal?.reason),
					{ once: true },
				);
			});
			throw new Error("unreachable");
		});

		const turn = service.handleMessage(
			runtime,
			makeMessage({ channelType: ChannelType.DM }),
			async (content) => {
				deliveries.push(content);
				return [];
			},
			{ abortSignal: controller.signal },
		);
		await entered;
		controller.abort(abortReason);

		await expect(turn).rejects.toBe(abortReason);
		expect(observed).toEqual([{ stream: false, hasSignal: true }]);
		expect(deliveries).toEqual([]);
	});

	it("keeps a turn-owned cancellation scope off streaming and abortable", async () => {
		const runtime = makeFailingRuntime(makeRoom(ChannelType.DM));
		const observed: { stream: boolean; hasSignal: boolean }[] = [];
		let releaseEntered: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			releaseEntered = resolve;
		});
		const service = new DefaultMessageService();
		const serviceProbe = service as unknown as {
			processMessage: (...args: unknown[]) => Promise<never>;
		};

		serviceProbe.processMessage = vi.fn(async () => {
			const context = getStreamingContext();
			observed.push({
				stream: context?.onStreamChunk !== undefined,
				hasSignal: context?.abortSignal !== undefined,
			});
			releaseEntered?.();
			if (!context?.abortSignal) {
				throw new Error("expected the turn-owned abort signal");
			}
			await new Promise<never>((_resolve, reject) => {
				context.abortSignal?.addEventListener(
					"abort",
					() => reject(context.abortSignal?.reason),
					{ once: true },
				);
			});
			throw new Error("unreachable");
		});

		const turn = service.handleMessage(
			runtime,
			makeMessage({ channelType: ChannelType.DM }),
			async () => [],
		);
		await entered;
		expect(runtime.turnControllers.abortTurn(ROOM, "turn cancelled")).toBe(
			true,
		);

		await expect(turn).rejects.toMatchObject({
			code: "TURN_ABORTED",
			reason: "turn cancelled",
		});
		expect(observed).toEqual([{ stream: false, hasSignal: true }]);
	});
});

describe("planner failure after a promoted stage-1 answer", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	const SUBSTANTIVE =
		"The top 3 contributors are lalalune, shakkernerd, and odilitime.";

	it.each([
		"provider outage",
		"caller cancellation",
		"turn cancellation",
		"registered turn cancellation",
		"coded cancellation",
	])(
		"handles %s after a promoted stage-1 answer without claiming a cancelled action completed",
		async (failure) => {
			// Stage 1 answers the question, a response-handler evaluator promotes the
			// turn to planning while overwriting the reply with a progress ack, and
			// the planner then fails. A provider outage can preserve an existing
			// answer, but cancellation cannot turn a pre-action draft into success.
			const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
			for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
				responseHandlerFieldRegistry.register(evaluator);
			}
			const modelCallTypes: string[] = [];
			let stage1Served = false;
			const controller = new AbortController();
			const cancelled = failure !== "provider outage";
			const abortReason = new TurnAbortedError("ui-chat-abort");
			let plannerEntered: (() => void) | undefined;
			let rejectPlanner: ((error: Error) => void) | undefined;
			const pendingPlanner = new Promise<void>((resolve) => {
				plannerEntered = resolve;
			});
			const runtime = createMockRuntime({
				agentId: AGENT,
				character: { name: "Remilio", bio: "test agent" },
				logger: {
					debug: vi.fn(),
					info: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(),
					trace: vi.fn(),
				} as unknown as IAgentRuntime["logger"],
				getSetting: vi.fn(() => undefined),
				getService: vi.fn(() => null),
				getModel: vi.fn(() => async () => {
					throw RATE_LIMIT_ERROR;
				}),
				// Stage 1 succeeds; the planner exercises the selected failure mode.
				useModel: vi.fn(async (modelType: unknown) => {
					modelCallTypes.push(String(modelType));
					if (String(modelType) === "TEXT_EMBEDDING") return [0.1, 0.2, 0.3];
					if (String(modelType) === "RESPONSE_HANDLER" && !stage1Served) {
						stage1Served = true;
						return {
							text: "",
							toolCalls: [
								{
									id: "handle-response-1",
									name: "HANDLE_RESPONSE",
									arguments: {
										shouldRespond: "RESPOND",
										thought: "",
										contexts: ["general"],
										intents: [],
										candidateActionNames: [],
										replyText: cancelled ? "Back home." : SUBSTANTIVE,
										replyEffectStatus: "non_applied",
										facts: [],
										relationships: [],
										addressedTo: [],
									},
								},
							],
						};
					}
					if (failure === "caller cancellation") {
						controller.abort(abortReason);
						// A transport may reject generically after the caller cancels.
						// The signal remains authoritative over answer rescue.
						throw new Error("request interrupted");
					}
					if (failure === "turn cancellation") throw abortReason;
					if (
						failure === "registered turn cancellation" &&
						String(modelType) === "ACTION_PLANNER"
					) {
						return await new Promise<never>((_resolve, reject) => {
							rejectPlanner = reject;
							plannerEntered?.();
						});
					}
					if (failure === "coded cancellation") {
						throw { code: "TURN_ABORTED", reason: "ui-chat-abort" };
					}
					throw RATE_LIMIT_ERROR;
				}),
				composeState: vi.fn(async () => makeState()),
				runActionsByMode: vi.fn(async () => undefined),
				applyPipelineHooks: vi.fn(async () => undefined),
				emitEvent: vi.fn(async () => undefined),
				reportError: vi.fn(),
				startRun: vi.fn(() => RUN_ID),
				getCurrentRunId: vi.fn(() => RUN_ID),
				endRun: vi.fn(),
				getMemoryById: vi.fn(async () => null),
				createMemory: vi.fn(async () => asUUID(v4())),
				updateMemory: vi.fn(async () => true),
				queueEmbeddingGeneration: vi.fn(async () => undefined),
				getParticipantUserState: vi.fn(async () => null),
				getRoom: vi.fn(async () => makeRoom(ChannelType.DM)),
				getRoomsByIds: vi.fn(async () => [makeRoom(ChannelType.DM)]),
				getMemories: vi.fn(async () => []),
				isCheckShouldRespondEnabled: vi.fn(() => true),
				turnControllers: new TurnControllerRegistry(),
				responseHandlerFieldRegistry,
				responseHandlerFieldEvaluators: [
					...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
				],
				responseHandlerEvaluators: [
					{
						name: "test-clobber-to-ack",
						priority: 100,
						shouldRun: () => true,
						evaluate: () => ({ reply: "On it.", requiresTool: true }),
					},
				],
			} as never);

			const service = new DefaultMessageService();
			const deliveries: Content[] = [];
			const turn = service.handleMessage(
				runtime,
				makeMessage({ channelType: ChannelType.DM }),
				async (content) => {
					deliveries.push(content);
					return [];
				},
				{ abortSignal: controller.signal },
			);
			if (failure === "registered turn cancellation") {
				await pendingPlanner;
				// Cancel externally, as the UI route does. The registry deliberately
				// excludes the current turn when an action itself requests an abort.
				expect(runtime.turnControllers.abortTurn(ROOM, "ui-chat-abort")).toBe(
					true,
				);
				rejectPlanner?.(new Error("request interrupted"));
			}
			if (cancelled) {
				await expect(turn).rejects.toMatchObject({
					code: "TURN_ABORTED",
					reason: "ui-chat-abort",
				});
				expect(deliveries).toEqual([]);
				expect(
					modelCallTypes.filter((modelType) => modelType !== "TEXT_EMBEDDING"),
				).toEqual(["RESPONSE_HANDLER", "ACTION_PLANNER"]);
				return;
			}
			const result = await turn;

			const visibleTexts = deliveries
				.map((content) =>
					typeof content.text === "string" ? content.text : "",
				)
				.filter((text) => text.trim().length > 0);

			expect(result.didRespond).toBe(true);
			// The preserved stage-0 answer reaches the user; the canned rate-limit
			// apology does not replace an answer the turn already produced.
			expect(visibleTexts.join("\n"), modelCallTypes.join(",")).toContain(
				"lalalune",
			);
			expect(visibleTexts.join("\n").toLowerCase()).not.toContain("rate-limit");
		},
	);

	it("delivers the failure reply on an unaddressed group turn once stage-1 committed to respond", async () => {
		// Stage 1 commits to RESPOND on a bare group message but produces no
		// preservable answer (empty replyText, promoted to planning), and the
		// planner then dies. The deterministic addressing gate alone would
		// suppress the failure reply — the model's own RESPOND decision must
		// qualify the turn for a visible failure instead of dead silence.
		const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
		for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
			responseHandlerFieldRegistry.register(evaluator);
		}
		let stage1Served = false;
		const runtime = createMockRuntime({
			agentId: AGENT,
			character: { name: "Remilio", bio: "test agent" },
			logger: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				trace: vi.fn(),
			} as unknown as IAgentRuntime["logger"],
			getSetting: vi.fn(() => undefined),
			getService: vi.fn(() => null),
			getModel: vi.fn(() => async () => {
				throw RATE_LIMIT_ERROR;
			}),
			useModel: vi.fn(async (modelType: unknown) => {
				if (String(modelType) === "RESPONSE_HANDLER" && !stage1Served) {
					stage1Served = true;
					return {
						text: "",
						toolCalls: [
							{
								id: "handle-response-1",
								name: "HANDLE_RESPONSE",
								arguments: {
									shouldRespond: "RESPOND",
									thought: "",
									contexts: ["general"],
									intents: [],
									candidateActionNames: [],
									replyText: "",
									facts: [],
									relationships: [],
									addressedTo: [],
								},
							},
						],
					};
				}
				throw RATE_LIMIT_ERROR;
			}),
			composeState: vi.fn(async () => makeState()),
			runActionsByMode: vi.fn(async () => undefined),
			applyPipelineHooks: vi.fn(async () => undefined),
			emitEvent: vi.fn(async () => undefined),
			reportError: vi.fn(),
			startRun: vi.fn(() => RUN_ID),
			getCurrentRunId: vi.fn(() => RUN_ID),
			endRun: vi.fn(),
			getMemoryById: vi.fn(async () => null),
			createMemory: vi.fn(async () => asUUID(v4())),
			updateMemory: vi.fn(async () => true),
			queueEmbeddingGeneration: vi.fn(async () => undefined),
			getParticipantUserState: vi.fn(async () => null),
			getRoom: vi.fn(async () => makeRoom(ChannelType.GROUP)),
			getRoomsByIds: vi.fn(async () => [makeRoom(ChannelType.GROUP)]),
			getMemories: vi.fn(async () => []),
			isCheckShouldRespondEnabled: vi.fn(() => true),
			turnControllers: new TurnControllerRegistry(),
			responseHandlerFieldRegistry,
			responseHandlerFieldEvaluators: [
				...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
			],
			responseHandlerEvaluators: [
				{
					name: "test-clobber-to-ack",
					priority: 100,
					shouldRun: () => true,
					evaluate: () => ({ reply: "On it.", requiresTool: true }),
				},
			],
		} as never);

		const service = new DefaultMessageService();
		const deliveries: Content[] = [];
		const result = await service.handleMessage(
			runtime,
			makeMessage({}),
			async (content) => {
				deliveries.push(content);
				return [];
			},
		);

		const visibleTexts = deliveries
			.map((content) => (typeof content.text === "string" ? content.text : ""))
			.filter((text) => text.trim().length > 0);

		expect(result.didRespond).toBe(true);
		expect(visibleTexts).toHaveLength(1);
		expect(visibleTexts[0].toLowerCase()).toContain("rate-limit");
	});
});

it.each(["valid", "unknown"])(
	"repairs native scope before a mutation through the complete message service with %s evaluator receipts",
	async (receiptSelection) => {
		const runtime = makeFailingRuntime(makeRoom(ChannelType.DM));
		const finalText = "I updated the todo to completed.";
		const receipt: EffectReceipt = {
			receiptId: "record-completion-receipt",
			operation: "record.complete",
			resource: { kind: "record", id: "record-1", version: "2" },
			artifacts: [],
			idempotency: { key: null, replayed: false },
			observedAt: "2026-09-10T00:00:00Z",
			outcome: "applied",
			commit: {
				kind: "provider_accepted",
				id: "record-1-v2",
				committedAt: "2026-09-10T00:00:00Z",
			},
		};
		let writes = 0;
		runtime.actions = [
			{
				name: "READ_RECORD",
				description: "Read the record identifier.",
				validate: async () => true,
				handler: async () => ({
					success: true,
					text: "Record identifier is record-1.",
					data: { id: "record-1" },
				}),
			},
			{
				name: "COMPLETE_RECORD",
				description: "Mark the selected record complete.",
				validate: async () => true,
				parameters: [
					{
						name: "id",
						description: "Record identifier",
						required: true,
						schema: { type: "string" },
					},
				],
				handler: async (_runtime, _message, _state, options) => {
					expect(options?.parameters).toEqual({ id: "record-1" });
					writes++;
					return {
						success: true,
						text: "Record record-1 status is complete.",
						effectReceipts: [receipt],
					};
				},
			},
		];
		const plan = (name: string, scope?: string) => ({
			text: "",
			toolCalls: [
				{
					id: name,
					name,
					arguments: {
						...(name === "COMPLETE_RECORD" ? { id: "record-1" } : {}),
						...(scope ? { eliza_turn_scope: scope } : {}),
					},
				},
			],
		});
		const responses = [
			{
				text: "",
				toolCalls: [
					{
						id: "handler",
						name: "HANDLE_RESPONSE",
						arguments: {
							shouldRespond: "RESPOND",
							thought: "Read then complete.",
							contexts: ["general"],
							intents: ["read record", "complete record"],
							candidateActionNames: ["READ_RECORD", "COMPLETE_RECORD"],
							replyText: "",
							replyEffectStatus: "pending",
							facts: [],
							relationships: [],
							addressedTo: [],
						},
					},
				],
			},
			plan("READ_RECORD", "more_work_pending"),
			JSON.stringify({
				thought: "The returned ID grounds the completion.",
				success: false,
				decision: "CONTINUE",
			}),
			plan("COMPLETE_RECORD"),
			plan("COMPLETE_RECORD", "final"),
			JSON.stringify({
				thought: "The completion receipt proves the requested result.",
				success: true,
				decision: "FINISH",
				messageToUser: finalText,
				effectReceiptIds: [
					receiptSelection === "valid"
						? receipt.receiptId
						: "unknown-mutated-receipt",
				],
			}),
		];
		if (receiptSelection === "unknown")
			responses.push(
				JSON.stringify({
					response: finalText,
					effectReceiptIds: [receipt.receiptId],
				}),
			);
		const modelInputs: unknown[] = [];
		runtime.useModel = vi.fn(async (type, params) => {
			if (String(type) === "TEXT_EMBEDDING") return [0.1, 0.2, 0.3];
			modelInputs.push(params);
			const output = responses.shift();
			if (output === undefined)
				throw new Error("Unexpected additional model call");
			return output;
		}) as IAgentRuntime["useModel"];
		const deliveries: Content[] = [];
		await new DefaultMessageService().handleMessage(
			runtime,
			makeMessage({
				text: "Read the record, then mark that record complete.",
				source: "dashboard",
				channelType: ChannelType.DM,
			}),
			async (content) => {
				deliveries.push(content);
				return [];
			},
		);
		expect(writes).toBe(1);
		expect(responses).toEqual([]);
		expect(JSON.stringify(modelInputs[4])).toContain(
			"PLANNER_SCOPE_DECLARATION_REQUIRED",
		);
		expect(deliveries.map((content) => content.text)).toContain(finalText);
		expect(
			deliveries.find((content) => content.text === finalText)
				?.effectReceiptIds,
		).toEqual([receipt.receiptId]);
	},
);

it.each([
	["available", false],
	["unavailable", false],
	["available", true],
	["unavailable", true],
	["empty", false],
	["empty", true],
	["rejected", false],
	["rejected", true],
] as const)(
	"preserves four completed operations after protocol exhaustion with %s presentation (earlier failure: %s)",
	async (presentation, earlierFailure) => {
		const runtime = makeFailingRuntime(makeRoom(ChannelType.DM));
		const completed: string[] = [];
		const names = ["STORE_ONE", "STORE_TWO", "STORE_THREE", "STORE_FOUR"];
		const receipts: EffectReceipt[] = names.map((name, index) => ({
			receiptId: `stored-${index}`,
			operation: "record.store",
			resource: { kind: "record", id: name },
			artifacts: [],
			idempotency: { key: null, replayed: false },
			observedAt: "2026-09-10T00:00:00Z",
			outcome: "applied",
			commit: {
				kind: "provider_accepted",
				id: name,
				committedAt: "2026-09-10T00:00:00Z",
			},
		}));
		runtime.actions = [
			...(earlierFailure
				? [
						{
							name: "FAILED_READ",
							description: "Read the initial record.",
							validate: async () => true,
							handler: async () => ({
								success: false,
								error: "Initial read failed.",
							}),
						},
					]
				: []),
			...names.map((name, index) => ({
				name,
				description: `Store record ${name}.`,
				validate: async () => true,
				handler: async () => {
					completed.push(name);
					return {
						success: true,
						transcriptVisibility: "internal" as const,
						data: { id: name, status: "stored" },
						...(earlierFailure && index === 0
							? {
									verifiedUserFacing: true,
									userFacingText: "Done. The first todo was created.",
									userFacingEffectReceiptIds: [receipts[index].receiptId],
								}
							: {}),
						effectReceipts: [receipts[index]],
					};
				},
			})),
			{
				name: "UPDATE_REMAINING",
				description: "Update the remaining record.",
				validate: async () => true,
				handler: async () => {
					throw new Error("Rejected batch dispatched unexpectedly");
				},
			},
		];
		const plan = (name: string, scope?: string) => ({
			text: "",
			toolCalls: [
				{ id: name, name, arguments: scope ? { eliza_turn_scope: scope } : {} },
			],
		});
		const partial =
			(earlierFailure ? "The initial read failed. " : "") +
			"I created the todo records STORE_ONE, STORE_TWO, STORE_THREE, and STORE_FOUR. The remaining update did not run because planning stopped on invalid scope declarations.";
		const responses: unknown[] = [
			{
				text: "",
				toolCalls: [
					{
						id: "handler",
						name: "HANDLE_RESPONSE",
						arguments: {
							shouldRespond: "RESPOND",
							thought: "Store four records, then update the remaining one.",
							contexts: ["general"],
							intents: ["store four records", "update remaining record"],
							candidateActionNames: [
								...(earlierFailure ? ["FAILED_READ"] : []),
								...names,
								"UPDATE_REMAINING",
							],
							replyText: "",
							replyEffectStatus: "pending",
							facts: [],
							relationships: [],
							addressedTo: [],
						},
					},
				],
			},
		];
		if (earlierFailure)
			responses.push(
				plan("FAILED_READ", "more_work_pending"),
				JSON.stringify({
					success: false,
					decision: "CONTINUE",
					thought: "The initial read failed; continue independent writes.",
				}),
			);
		for (const name of names) {
			responses.push(plan(name, "more_work_pending"));
			responses.push(
				JSON.stringify({
					success: false,
					decision: "CONTINUE",
					thought: "Continue the explicitly requested work.",
				}),
			);
		}
		responses.push(plan("UPDATE_REMAINING"), plan("UPDATE_REMAINING"));
		responses.push(
			presentation === "available"
				? partial
				: presentation === "empty"
					? { text: "", toolCalls: [] }
					: presentation === "rejected"
						? "I'm working on the remaining event now."
						: new Error("presentation provider unavailable"),
		);
		if (presentation === "available")
			responses.push(
				JSON.stringify({
					response: partial,
					effectReceiptIds: receipts.map((receipt) => receipt.receiptId),
				}),
			);
		const modelInputs: unknown[] = [];
		runtime.useModel = vi.fn(async (type, params) => {
			if (String(type) === "TEXT_EMBEDDING") return [0.1, 0.2, 0.3];
			modelInputs.push(params);
			const response = responses.shift();
			if (response instanceof Error) throw response;
			if (response === undefined)
				throw new Error("Unexpected extra model call");
			return response;
		}) as IAgentRuntime["useModel"];
		const delivered: Content[] = [];
		const result = await new DefaultMessageService().handleMessage(
			runtime,
			makeMessage({
				text: "Store four records, then update the remaining record.",
				source: "dashboard",
				channelType: ChannelType.DM,
			}),
			async (content) => {
				delivered.push(content);
				return [];
			},
		);
		expect(completed).toEqual(names);
		expect(result.actionResults).toHaveLength(earlierFailure ? 5 : 4);
		expect(
			result.actionResults
				?.filter((outcome) => outcome.success)
				.map((outcome) => outcome.data?.id),
		).toEqual(names);
		if (earlierFailure) expect(result.actionResults?.[0].success).toBe(false);
		expect(
			result.actionResults?.flatMap(
				(outcome) =>
					outcome.effectReceipts?.map((receipt) => receipt.receiptId) ?? [],
			),
		).toEqual(receipts.map((receipt) => receipt.receiptId));
		expect(result.terminalFailure).toMatchObject({
			code: "PLANNER_SCOPE_DECLARATION_REQUIRED",
			transient: false,
		});
		expect(JSON.stringify(modelInputs[earlierFailure ? 13 : 11])).toContain(
			"PLANNER_SCOPE_DECLARATION_REQUIRED",
		);
		for (const name of names)
			expect(JSON.stringify(modelInputs[earlierFailure ? 13 : 11])).toContain(
				name,
			);
		if (presentation === "available") {
			expect(result.terminalFailure?.message).toBe(partial);
			expect(delivered.map((content) => content.text)).toContain(partial);
			expect(
				delivered.find((content) => content.text === partial)?.effectReceiptIds,
			).toEqual(receipts.map((receipt) => receipt.receiptId));
		} else {
			expect(result.terminalFailure?.message).toContain(
				"Earlier action outcomes are preserved; the rejected batch did not run.",
			);
			expect(delivered).toEqual([]);
			expect(result.responseContent).toBeNull();
		}
		expect(responses).toEqual([]);
	},
);
