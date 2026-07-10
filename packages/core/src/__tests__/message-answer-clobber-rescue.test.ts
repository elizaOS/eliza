/**
 * Behavioral matrix for the answer-clobber rescue in runV5MessageRuntimeStage1:
 * a response-handler evaluator that promotes a simple turn to planning while
 * overwriting a complete stage-0 answer with a progress ack must not end the
 * turn answerless — and the rescue must never overreach (no duplicate of the
 * early reply, no override of planner-produced final text, no fabrication on
 * genuinely progress-only turns, no double delivery of an action's own echo).
 * Drives the real message→planner→evaluator pipeline with a queued
 * canned-response model mock and real clobbering evaluators; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import type { ResponseHandlerEvaluator } from "../runtime/response-handler-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import {
	normalizeVisibleTextForDuplicateCheck,
	runV5MessageRuntimeStage1,
	wrapSingleTurnVisibleCallback,
} from "../services/message";
import type { Action, HandlerCallback } from "../types/components";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

const AGENT_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const RESPONSE_ID = "00000000-0000-0000-0000-000000000005" as UUID;

const SUBSTANTIVE_ANSWER =
	"The top 3 contributors to elizaOS/eliza are lalalune, shakkernerd, and odilitime.";
const PROGRESS_ACK = "On it, working on that now.";

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		agentId: AGENT_ID,
		roomId: "00000000-0000-0000-0000-000000000004" as UUID,
		content: {
			text: "who are the top 3 contributors to the eliza repo",
			source: "test",
		},
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: { availableContexts: "general, web" },
		data: {},
		text: "Recent conversation summary",
	};
}

function stage1Response(fields: {
	contexts?: string[];
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
					thought: "",
					contexts: fields.contexts ?? [],
					intents: [],
					candidateActionNames: [],
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

// Reproduces the live promotion-that-clobbers: force the turn into planning
// and overwrite the substantive stage-0 answer with a bare progress ack.
function clobberEvaluator(name: string, reply: string): ResponseHandlerEvaluator {
	return {
		name,
		priority: 100,
		shouldRun: () => true,
		evaluate: () => ({ reply, requiresTool: true }),
	};
}

// Promotion WITHOUT a clobber: escalate to planning but leave the stage-0
// reply untouched.
const PROMOTE_ONLY_EVALUATOR: ResponseHandlerEvaluator = {
	name: "test-promote-only",
	priority: 100,
	shouldRun: () => true,
	evaluate: () => ({ requiresTool: true }),
};

interface CannedResponse {
	expectModelType?: string;
	body: unknown;
}

function makeRuntime(opts: {
	responses: CannedResponse[];
	evaluators: ResponseHandlerEvaluator[];
	actions?: Action[];
}): IAgentRuntime {
	const queue = [...opts.responses];
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return {
		agentId: AGENT_ID,
		character: {
			name: "Test Agent",
			system: "You are concise.",
			bio: "I help.",
		},
		actions: opts.actions ?? [],
		providers: [],
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		useModel: vi.fn(async (modelType: unknown) => {
			const next = queue.shift();
			if (!next) throw new Error("Unexpected useModel call; queue empty");
			if (next.expectModelType && String(modelType) !== next.expectModelType) {
				throw new Error(
					`Expected ${next.expectModelType} but received ${String(modelType)}`,
				);
			}
			return next.body;
		}),
		// The per-callback character-voice rewrite spends a TEXT_SMALL call and
		// restyles delivered text, which would desync the strict canned-response
		// queue — the same opt-out the scenario runner uses.
		getSetting: vi.fn((key: string) =>
			key === "ACTION_CALLBACK_VOICE_REWRITE" ? "false" : undefined,
		),
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
		responseHandlerEvaluators: opts.evaluators,
	} as unknown as IAgentRuntime;
}

const ANSWERLESS_PLANNER: CannedResponse = {
	expectModelType: String(ModelType.ACTION_PLANNER),
	body: { text: "", toolCalls: [] },
};
const ANSWERLESS_FINISH: CannedResponse = {
	expectModelType: String(ModelType.RESPONSE_HANDLER),
	body: JSON.stringify({
		success: true,
		decision: "FINISH",
		thought: "Nothing further.",
		messageToUser: "",
	}),
};

async function runTurn(opts: {
	runtime: IAgentRuntime;
	callback?: HandlerCallback;
}): Promise<{
	finalText: string | undefined;
	earlyReplies: string[];
	kind: string;
}> {
	const earlyReplies: string[] = [];
	const message = makeMessage();
	// Mirror DefaultMessageService's wiring: action deliveries are recorded into
	// deliveredVisibleTexts through the instrumented callback, which is what the
	// action-echo suppression reads.
	const deliveredVisibleTexts = new Set<string>();
	const instrumentedCallback = opts.callback
		? wrapSingleTurnVisibleCallback(
				opts.runtime,
				message,
				opts.callback,
				(text) =>
					deliveredVisibleTexts.add(
						normalizeVisibleTextForDuplicateCheck(text),
					),
			)
		: undefined;
	const result = await runV5MessageRuntimeStage1({
		runtime: opts.runtime,
		message,
		state: makeState(),
		responseId: RESPONSE_ID,
		...(instrumentedCallback ? { callback: instrumentedCallback } : {}),
		deliveredVisibleTexts,
		onResponseHandlerEarlyReply: async ({ text }) => {
			earlyReplies.push(text);
		},
	});
	const finalText =
		result.kind === "planned_reply"
			? result.result.responseContent?.text
			: undefined;
	return { finalText, earlyReplies, kind: result.kind };
}

describe("answer-clobber rescue", () => {
	it("delivers the preserved stage-0 answer when a promotion clobbers it with a progress ack", async () => {
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["web"],
						replyText: SUBSTANTIVE_ANSWER,
					}),
				},
				ANSWERLESS_PLANNER,
				ANSWERLESS_FINISH,
			],
			evaluators: [clobberEvaluator("test-clobber", PROGRESS_ACK)],
		});

		const { finalText, earlyReplies } = await runTurn({ runtime });

		// The ack was the early reply the user saw first; the preserved
		// substantive answer is the final delivered text.
		expect(earlyReplies).toContain(PROGRESS_ACK);
		expect(finalText).toBe(SUBSTANTIVE_ANSWER);
	});

	it("survives multiple promotions: the pre-patch answer is preserved across stacked evaluator patches", async () => {
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["web"],
						replyText: SUBSTANTIVE_ANSWER,
					}),
				},
				ANSWERLESS_PLANNER,
				ANSWERLESS_FINISH,
			],
			evaluators: [
				clobberEvaluator("test-clobber-one", "Working on it."),
				clobberEvaluator("test-clobber-two", PROGRESS_ACK),
			],
		});

		const { finalText } = await runTurn({ runtime });

		expect(finalText).toBe(SUBSTANTIVE_ANSWER);
	});

	it("does not duplicate the early reply when the promotion kept the substantive answer", async () => {
		// Promotion WITHOUT a clobber: the substantive answer itself became the
		// early reply. An answerless planner finish must not deliver it again.
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["web"],
						replyText: SUBSTANTIVE_ANSWER,
					}),
				},
				ANSWERLESS_PLANNER,
				ANSWERLESS_FINISH,
			],
			evaluators: [PROMOTE_ONLY_EVALUATOR],
		});

		const { finalText, earlyReplies } = await runTurn({ runtime });

		expect(earlyReplies).toContain(SUBSTANTIVE_ANSWER);
		// No second bubble with the same text.
		expect(finalText ?? "").not.toBe(SUBSTANTIVE_ANSWER);
	});

	it("lets planner-produced final text win over the preserved stage-0 answer", async () => {
		const plannerAnswer = "Fresh planner answer with newer data.";
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["web"],
						replyText: SUBSTANTIVE_ANSWER,
					}),
				},
				{
					expectModelType: String(ModelType.ACTION_PLANNER),
					body: {
						text: "",
						toolCalls: [
							{
								id: "reply-1",
								name: "REPLY",
								arguments: { text: plannerAnswer },
							},
						],
					},
				},
			],
			evaluators: [clobberEvaluator("test-clobber", PROGRESS_ACK)],
		});

		const { finalText } = await runTurn({ runtime });

		expect(finalText).toBe(plannerAnswer);
		expect(finalText).not.toBe(SUBSTANTIVE_ANSWER);
	});

	it("rescues nothing on a genuinely progress-only stage-0 turn", async () => {
		// Stage-0 itself produced only an ack; there is no answer to preserve, so
		// an answerless finish stays answerless (no fabricated content).
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["web"],
						replyText: PROGRESS_ACK,
					}),
				},
				ANSWERLESS_PLANNER,
				ANSWERLESS_FINISH,
			],
			evaluators: [PROMOTE_ONLY_EVALUATOR],
		});

		const { finalText } = await runTurn({ runtime });

		expect(finalText ?? "").not.toContain("contributors");
		expect(finalText ?? "").not.toBe(PROGRESS_ACK);
	});

	it("does not double-deliver when an action already delivered the preserved text", async () => {
		const delivered: string[] = [];
		const callback: HandlerCallback = async (content) => {
			if (typeof content.text === "string" && content.text.length > 0) {
				delivered.push(content.text);
			}
			return [];
		};
		const echoAction: Action = {
			name: "ANSWER_LOOKUP",
			description: "returns the contributors answer via its own callback",
			similes: [],
			examples: [],
			parameters: [],
			validate: async () => true,
			handler: async (_rt, _msg, _state, _opts, cb) => {
				await cb?.({ text: SUBSTANTIVE_ANSWER });
				return { success: true, text: SUBSTANTIVE_ANSWER };
			},
		} as unknown as Action;

		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["web"],
						replyText: SUBSTANTIVE_ANSWER,
					}),
				},
				{
					expectModelType: String(ModelType.ACTION_PLANNER),
					body: {
						text: "",
						toolCalls: [{ id: "call-1", name: "ANSWER_LOOKUP", args: {} }],
					},
				},
				// The evaluator echoes the text the action already delivered — the
				// classic redundant-second-bubble shape the echo suppression exists
				// for. The preserved-answer fallback must not defeat it.
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "The lookup answered it.",
						messageToUser: SUBSTANTIVE_ANSWER,
					}),
				},
				{
					body: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "The lookup answered it.",
						messageToUser: SUBSTANTIVE_ANSWER,
					}),
				},
			],
			evaluators: [clobberEvaluator("test-clobber", PROGRESS_ACK)],
			actions: [echoAction],
		});

		const { finalText } = await runTurn({ runtime, callback });

		// The action's own delivery is the single copy of the answer; neither the
		// evaluator echo nor the preserved-answer fallback adds a second bubble.
		const copies = delivered.filter((t) => t === SUBSTANTIVE_ANSWER).length;
		expect(copies).toBe(1);
		expect(finalText ?? "").not.toBe(SUBSTANTIVE_ANSWER);
	});

	it("surfaces the preserved answer when the required-tool miss budget exhausts", async () => {
		// The clobbered promotion also names a required tool. A planner that
		// never calls it exhausts the miss budget (3), and the loop's captured
		// answer for that exhaustion must be the preserved substantive stage-0
		// reply — not the progress ack the promotion wrote over it.
		const lookupAction: Action = {
			name: "ANSWER_LOOKUP",
			description: "looks up the contributors answer",
			similes: [],
			examples: [],
			parameters: [],
			validate: async () => true,
			handler: async () => ({ success: true, text: "unused" }),
		} as unknown as Action;
		const missPlanner: CannedResponse = {
			expectModelType: String(ModelType.ACTION_PLANNER),
			body: { text: "", toolCalls: [] },
		};
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["web"],
						replyText: SUBSTANTIVE_ANSWER,
						extra: { candidateActionNames: ["ANSWER_LOOKUP"] },
					}),
				},
				// Four consecutive tool-less planner turns: misses 1-3 burn the
				// budget, the fourth exceeds it and triggers the captured-answer
				// finish.
				missPlanner,
				missPlanner,
				missPlanner,
				missPlanner,
			],
			evaluators: [clobberEvaluator("test-clobber", PROGRESS_ACK)],
			actions: [lookupAction],
		});

		const { finalText, earlyReplies } = await runTurn({ runtime });

		expect(earlyReplies).toContain(PROGRESS_ACK);
		expect(finalText).toBe(SUBSTANTIVE_ANSWER);
	});
});
