/**
 * Pins the ELIZA_RECALL_SHORT_CIRCUIT gate in runV5MessageRuntimeStage1:
 *
 * 1. Flag off (default): a Stage-1 RECALL_MEMORY-family candidate follows the
 *    unchanged planner path (Stage 1 + planner + evaluator = 3 model calls).
 * 2. Flag on: the same recall turn short-circuits to exactly 2 model calls —
 *    Stage 1 plus one TEXT_LARGE synthesis — with the MEMORY action executed
 *    deterministically as {action:"search", query:<raw user message>} and the
 *    synthesis text delivered as a direct reply.
 * 3. Flag on, non-recall turns: simple replies and non-recall planner turns are
 *    untouched (no MEMORY execution, no TEXT_LARGE call).
 *
 * Deterministic: fabricated runtime with a queued useModel mock — no live
 * model, no DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { runV5MessageRuntimeStage1 } from "../services/message";
import type { Action } from "../types/components";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

const RECALL_QUESTION = "who taught Shadow guitar? check memory";
const MEMORY_EVIDENCE = "Stored note: Royce taught Shadow guitar in Denver.";
const SYNTHESIS_REPLY = "Royce taught Shadow guitar back in Denver.";
const RESPONSE_ID = "00000000-0000-0000-0000-000000000005" as UUID;

function useModelCalls(runtime: IAgentRuntime): unknown[][] {
	return (runtime.useModel as { mock: { calls: unknown[][] } }).mock.calls;
}

function modelTypesCalled(runtime: IAgentRuntime): unknown[] {
	return useModelCalls(runtime).map((call) => call[0]);
}

function makeMessage(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		roomId: "00000000-0000-0000-0000-000000000004" as UUID,
		content: { text, source: "test" },
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: { availableContexts: "general, memory" },
		data: {},
		text: "Recent conversation summary",
	};
}

function stage1Response(fields: {
	thought?: string;
	contexts?: string[];
	candidateActionNames?: string[];
	replyText?: string;
	extra?: Record<string, unknown>;
}) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: fields.thought ?? "",
					contexts: fields.contexts ?? [],
					intents: [],
					candidateActionNames: fields.candidateActionNames ?? [],
					replyText: fields.replyText ?? "",
					facts: [],
					relationships: [],
					addressedTo: [],
					...(fields.extra ?? {}),
				},
			},
		],
	};
}

function makeRuntime(
	responses: unknown[],
	settings?: Record<string, string>,
): IAgentRuntime {
	const queue = [...responses];
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return {
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		character: {
			name: "Test Agent",
			system: "You are concise.",
			bio: "I help with memories.",
		},
		actions: [],
		providers: [],
		getService: vi.fn(() => null),
		getRoom: vi.fn(async () => null),
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		reportError: vi.fn(),
		useModel: vi.fn(async () => {
			if (queue.length === 0) {
				throw new Error("Unexpected useModel call");
			}
			return queue.shift();
		}),
		getSetting: vi.fn((key: string) => settings?.[key]),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
		responseHandlerEvaluators: [],
	} as IAgentRuntime;
}

/**
 * Mirrors the live MEMORY umbrella action's identity surface: the canonical
 * name plus the RECALL_MEMORY-family similes that Stage 1 actually emits.
 */
function makeMemoryAction(handler: Action["handler"]): Action {
	return {
		name: "MEMORY",
		similes: ["RECALL_MEMORY", "RECALL_MEMORIES", "MEMORY_SEARCH"],
		description: "Search stored conversation records.",
		contexts: ["memory"],
		parameters: [
			{
				name: "action",
				description: "Memory operation.",
				required: true,
				schema: { type: "string", enum: ["search"] },
			},
			{
				name: "query",
				description: "Search query.",
				schema: { type: "string" },
			},
		],
		validate: async () => true,
		handler,
	} as Action;
}

function makeMemoryHandler() {
	return vi.fn(async () => ({
		success: true,
		text: MEMORY_EVIDENCE,
		data: { actionName: "MEMORY" },
	}));
}

const FLAG_ON = { ELIZA_RECALL_SHORT_CIRCUIT: "1" };

describe("recall short-circuit (ELIZA_RECALL_SHORT_CIRCUIT)", () => {
	beforeEach(() => {
		delete process.env.ELIZA_RECALL_SHORT_CIRCUIT;
	});
	afterEach(() => {
		delete process.env.ELIZA_RECALL_SHORT_CIRCUIT;
	});

	it("flag off: a recall candidate turn keeps the unchanged planner path (3 model calls)", async () => {
		const memoryHandler = makeMemoryHandler();
		const runtime = makeRuntime([
			stage1Response({
				thought: "Recall request — search stored memory.",
				contexts: ["memory"],
				candidateActionNames: ["RECALL_MEMORY"],
				replyText: "",
				extra: { requiresTool: true },
			}),
			{
				thought: "Search memory for the guitar teacher.",
				toolCalls: [
					{
						id: "memory-1",
						name: "MEMORY",
						args: { action: "search", query: "who taught Shadow guitar" },
					},
				],
			},
			JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "Memory search answered the question.",
				messageToUser: "Royce taught Shadow guitar.",
			}),
		]);
		runtime.actions = [makeMemoryAction(memoryHandler)] as never;

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(RECALL_QUESTION),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		// Unchanged default: Stage 1 + planner + evaluator, memory via planner.
		expect(modelTypesCalled(runtime)).toEqual([
			ModelType.RESPONSE_HANDLER,
			ModelType.ACTION_PLANNER,
			ModelType.RESPONSE_HANDLER,
		]);
		expect(memoryHandler).toHaveBeenCalledTimes(1);
		expect(result.kind).toBe("planned_reply");
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toContain("Royce");
		}
	});

	it("flag on: a recall turn makes exactly 2 model calls (Stage 1 + synthesis) with a deterministic MEMORY search", async () => {
		const memoryHandler = makeMemoryHandler();
		const runtime = makeRuntime(
			[
				stage1Response({
					thought: "Recall request — search stored memory.",
					contexts: ["memory"],
					candidateActionNames: ["RECALL_MEMORY"],
					replyText: "",
					extra: { requiresTool: true },
				}),
				SYNTHESIS_REPLY,
			],
			FLAG_ON,
		);
		runtime.actions = [makeMemoryAction(memoryHandler)] as never;

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(RECALL_QUESTION),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		// Exactly two model calls: Stage 1 plus one TEXT_LARGE synthesis. No
		// planner, no evaluator.
		expect(modelTypesCalled(runtime)).toEqual([
			ModelType.RESPONSE_HANDLER,
			ModelType.TEXT_LARGE,
		]);
		// The MEMORY action ran once, deterministically, with the raw user
		// message as the search query — no model-composed params.
		expect(memoryHandler).toHaveBeenCalledTimes(1);
		const handlerOptions = memoryHandler.mock.calls[0]?.[3] as
			| { parameters?: Record<string, unknown> }
			| undefined;
		expect(handlerOptions?.parameters).toMatchObject({
			action: "search",
			query: RECALL_QUESTION,
		});
		// The synthesis text ships as the direct reply.
		expect(result.kind).toBe("direct_reply");
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe(SYNTHESIS_REPLY);
		}
		// The synthesis prompt carries the tool evidence and the user question.
		const synthesisParams = useModelCalls(runtime)[1]?.[1] as
			| { prompt?: string }
			| undefined;
		expect(synthesisParams?.prompt).toContain(MEMORY_EVIDENCE);
		expect(synthesisParams?.prompt).toContain(RECALL_QUESTION);
		// Observability: the short-circuit logs its decision.
		const infoCalls = (runtime.logger.info as { mock: { calls: unknown[][] } })
			.mock.calls;
		expect(
			infoCalls.some((call) =>
				String(call[1] ?? call[0]).includes("Recall short-circuit"),
			),
		).toBe(true);
	});

	it("flag on: a simple non-recall turn stays a one-call direct reply", async () => {
		const memoryHandler = makeMemoryHandler();
		const runtime = makeRuntime(
			[
				stage1Response({
					contexts: ["simple"],
					candidateActionNames: [],
					replyText: "hey! all good here.",
				}),
			],
			FLAG_ON,
		);
		runtime.actions = [makeMemoryAction(memoryHandler)] as never;

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("hey how are you"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		expect(modelTypesCalled(runtime)).toEqual([ModelType.RESPONSE_HANDLER]);
		expect(memoryHandler).not.toHaveBeenCalled();
		expect(result.kind).toBe("direct_reply");
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe("hey! all good here.");
		}
	});

	it("flag on: a non-recall planner turn keeps the unchanged planner path", async () => {
		const memoryHandler = makeMemoryHandler();
		const calendarHandler = vi.fn(async () => ({
			success: true,
			text: "clear tomorrow.",
			data: { actionName: "CALENDAR" },
		}));
		const runtime = makeRuntime(
			[
				stage1Response({
					contexts: ["calendar"],
					candidateActionNames: ["CALENDAR"],
					replyText: "",
					extra: { requiresTool: true },
				}),
				{
					thought: "Read tomorrow's calendar.",
					toolCalls: [
						{
							id: "calendar-1",
							name: "CALENDAR",
							args: { intent: "whats on my calendar tomorrow" },
						},
					],
				},
				JSON.stringify({
					success: true,
					decision: "FINISH",
					thought: "Calendar read finished.",
					messageToUser: "You're clear tomorrow.",
				}),
			],
			FLAG_ON,
		);
		runtime.actions = [
			makeMemoryAction(memoryHandler),
			{
				name: "CALENDAR",
				similes: [],
				description: "Read the owner's live calendar.",
				contexts: ["calendar"],
				parameters: [
					{
						name: "intent",
						description: "Natural-language calendar request.",
						schema: { type: "string" },
					},
				],
				validate: async () => true,
				handler: calendarHandler,
			},
		] as never;

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage("whats on my calendar tomorrow"),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		expect(modelTypesCalled(runtime)).toEqual([
			ModelType.RESPONSE_HANDLER,
			ModelType.ACTION_PLANNER,
			ModelType.RESPONSE_HANDLER,
		]);
		expect(memoryHandler).not.toHaveBeenCalled();
		expect(calendarHandler).toHaveBeenCalledTimes(1);
		expect(result.kind).toBe("planned_reply");
	});
});
