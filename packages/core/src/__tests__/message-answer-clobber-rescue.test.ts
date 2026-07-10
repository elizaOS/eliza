/**
 * Regression coverage for the answer-clobber rescue in runV5MessageRuntimeStage1:
 * when a response-handler evaluator promotes a simple turn to planning and
 * overwrites a COMPLETE stage-0 answer with a bare progress ack ("On it."), the
 * turn must not end answerless — the preserved pre-patch answer is delivered as
 * the final message. Drives the real message→planner→evaluator pipeline with a
 * queued canned-response model mock (no live model) and a real clobbering
 * evaluator, exactly reproducing the live failure: eliza-code finished the
 * "top contributors" answer, the promotion flailed through NOTIFY, and the turn
 * ended with only the ack visible.
 */
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import type { ResponseHandlerEvaluator } from "../runtime/response-handler-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { runV5MessageRuntimeStage1 } from "../services/message";
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
		content: { text: "who are the top 3 contributors to the eliza repo", source: "test" },
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

// A response-handler evaluator that reproduces the live promotion-that-clobbers:
// it forces the turn into planning (requiresTool) and overwrites the substantive
// stage-0 answer with a bare progress ack.
const CLOBBER_EVALUATOR: ResponseHandlerEvaluator = {
	name: "test-clobber-to-ack",
	priority: 100,
	shouldRun: () => true,
	evaluate: () => ({ reply: PROGRESS_ACK, requiresTool: true }),
};

function makeRuntime(responses: unknown[]): IAgentRuntime {
	const queue = [...responses];
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return {
		agentId: AGENT_ID,
		character: { name: "Test Agent", system: "You are concise.", bio: "I help." },
		actions: [],
		providers: [],
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		useModel: vi.fn(async () => {
			if (queue.length === 0) throw new Error("Unexpected useModel call");
			return queue.shift();
		}),
		getSetting: vi.fn(() => undefined),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS],
		responseHandlerEvaluators: [CLOBBER_EVALUATOR],
	} as unknown as IAgentRuntime;
}

describe("answer-clobber rescue", () => {
	it("delivers the preserved stage-0 answer when a promotion clobbers it with a progress ack", async () => {
		const earlyReplies: string[] = [];
		const runtime = makeRuntime([
			stage1Response({
				contexts: ["web"],
				replyText: SUBSTANTIVE_ANSWER,
			}),
			// Planner finishes without producing any new final text (answerless).
			{
				expectModelType: ModelType.ACTION_PLANNER,
				body: { text: "", toolCalls: [] },
			},
			// Evaluator FINISHes with no messageToUser — nothing new to say.
			{
				expectModelType: ModelType.RESPONSE_HANDLER,
				body: JSON.stringify({
					success: true,
					decision: "FINISH",
					thought: "Nothing further.",
					messageToUser: "",
				}),
			},
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: RESPONSE_ID,
			onResponseHandlerEarlyReply: async ({ text }) => {
				earlyReplies.push(text);
			},
		});

		// The ack was the early reply the user saw first.
		expect(earlyReplies).toContain(PROGRESS_ACK);
		// The turn does NOT end answerless: the preserved substantive answer is the
		// final delivered text, not a second copy of the progress ack.
		expect(result.kind).toBe("planned_reply");
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(SUBSTANTIVE_ANSWER);
		}
	});
});
