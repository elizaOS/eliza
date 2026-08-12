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
import type { Content, Media, UUID } from "../types/primitives";
import type { IAgentRuntime, ModelCallProvenance } from "../types/runtime";
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
function clobberEvaluator(
	name: string,
	reply: string,
): ResponseHandlerEvaluator {
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
		getRoom: vi.fn(async () => null),
		reportError: vi.fn(),
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		useModel: vi.fn(
			async (
				modelType: unknown,
				_params: unknown,
				_provider: unknown,
				provenance?: ModelCallProvenance,
			) => {
				if (provenance) provenance.resolvedProvider = "test-provider";
				const next = queue.shift();
				if (!next) throw new Error("Unexpected useModel call; queue empty");
				if (
					next.expectModelType &&
					String(modelType) !== next.expectModelType
				) {
					throw new Error(
						`Expected ${next.expectModelType} but received ${String(modelType)}`,
					);
				}
				return next.body;
			},
		),
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
	// Connectors like Discord do not wire an early-reply channel
	// (message.ts:12122): the stage-0 ack is never delivered early and instead
	// survives as the post-action ackFallback. Omitting the callback reproduces
	// that path.
	noEarlyReply?: boolean;
}): Promise<{
	finalText: string | undefined;
	earlyReplies: string[];
	deliveredMediaUrls: string[];
	kind: string;
}> {
	const earlyReplies: string[] = [];
	const message = makeMessage();
	// Mirror DefaultMessageService's wiring: action deliveries are recorded into
	// deliveredVisibleTexts through the instrumented callback, which is what the
	// action-echo suppression reads.
	const deliveredVisibleTexts = new Set<string>();
	const deliveredMediaUrls = new Set<string>();
	const instrumentedCallback = opts.callback
		? wrapSingleTurnVisibleCallback(
				opts.runtime,
				message,
				opts.callback,
				(text) =>
					deliveredVisibleTexts.add(
						normalizeVisibleTextForDuplicateCheck(text),
					),
				(urls) => {
					for (const url of urls) deliveredMediaUrls.add(url);
				},
			)
		: undefined;
	const result = await runV5MessageRuntimeStage1({
		runtime: opts.runtime,
		message,
		state: makeState(),
		responseId: RESPONSE_ID,
		...(instrumentedCallback ? { callback: instrumentedCallback } : {}),
		deliveredVisibleTexts,
		deliveredMediaUrls,
		...(opts.noEarlyReply
			? {}
			: {
					onResponseHandlerEarlyReply: async ({ text }) => {
						earlyReplies.push(text);
					},
				}),
	});
	const finalText =
		result.kind === "planned_reply"
			? result.result.responseContent?.text
			: undefined;
	return {
		finalText,
		earlyReplies,
		deliveredMediaUrls: [...deliveredMediaUrls],
		kind: result.kind,
	};
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

	it("never rescues a pre-tool success claim marked as already applied", async () => {
		const ungroundedClaim = "Created a note titled ‘Eat Lunch’.";
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["simple"],
						replyText: ungroundedClaim,
						extra: { replyEffectStatus: "applied" },
					}),
				},
				ANSWERLESS_PLANNER,
				ANSWERLESS_FINISH,
			],
			evaluators: [clobberEvaluator("test-clobber", PROGRESS_ACK)],
		});

		const { finalText, earlyReplies } = await runTurn({ runtime });

		expect(earlyReplies).toEqual([]);
		expect(finalText ?? "").not.toBe(ungroundedClaim);
	});

	it("keeps callbacks from more-work-pending actions out of the transcript", async () => {
		const delivered: Content[] = [];
		const callback: HandlerCallback = async (content) => {
			delivered.push(content);
			return [];
		};
		const attachment: Media = {
			id: "intermediate-image",
			url: "https://example.test/intermediate.png",
			title: "Intermediate image",
		};
		const intermediateAction: Action = {
			name: "INTERMEDIATE_LOOKUP",
			description: "performs the first step of a multi-step request",
			similes: [],
			examples: [],
			parameters: [],
			validate: async () => true,
			handler: async (_rt, _msg, _state, _opts, cb) => {
				await cb?.({
					text: "Intermediate implementation detail.",
					attachments: [attachment],
				});
				return { success: true, text: "First step complete." };
			},
		} as unknown as Action;
		const finalReply = "The complete request is finished.";
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["general"],
						replyText: PROGRESS_ACK,
						extra: { candidateActionNames: ["INTERMEDIATE_LOOKUP"] },
					}),
				},
				{
					expectModelType: String(ModelType.ACTION_PLANNER),
					body: {
						text: "",
						toolCalls: [
							{
								id: "intermediate-1",
								name: "INTERMEDIATE_LOOKUP",
								arguments: { eliza_turn_scope: "more_work_pending" },
							},
						],
					},
				},
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: JSON.stringify({
						success: true,
						decision: "CONTINUE",
						thought: "One more step remains.",
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
								arguments: { text: finalReply },
							},
						],
					},
				},
			],
			evaluators: [],
			actions: [intermediateAction],
		});

		const { finalText } = await runTurn({ runtime, callback });

		expect(delivered.map((content) => content.text)).not.toContain(
			"Intermediate implementation detail.",
		);
		expect(delivered).toContainEqual({ attachments: [attachment] });
		expect(finalText).toBe(finalReply);
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

describe("media deliverable suppresses the trailing progress ack", () => {
	const IMAGE_URL = "https://example.test/neon-cat.png";
	const SECOND_IMAGE_URL = "https://example.test/neon-dog.png";

	function generateMediaAction(
		options: {
			turnComplete?: boolean;
			userFacingText?: string | false;
			attachments?: Media[];
		} = {},
	): Action {
		const attachment: Media = {
			id: "generated-image",
			url: IMAGE_URL,
			title: "neon cat",
			contentType: "image/png",
			source: "media-generation",
		};
		const attachments = options.attachments ?? [attachment];
		return {
			name: "GENERATE_MEDIA_TEST",
			description: "generates an image and delivers it as an attachment",
			similes: [],
			examples: [],
			parameters: [],
			validate: async () => true,
			// Mirrors the real GENERATE_MEDIA delivery shape: an attachment-only,
			// text:"" callback posts the image while result metadata also carries
			// URLs. Only a nonempty callback receipt may establish delivery.
			handler: async (_rt, _msg, _state, _opts, cb) => {
				await cb?.({
					attachments,
					text: "",
					actions: ["GENERATE_MEDIA_TEST"],
					source: "media-generation",
				});
				return {
					success: true,
					text: "Generated image",
					...(options.turnComplete ? { turnComplete: true } : {}),
					...(options.userFacingText === false
						? {}
						: {
								userFacingText: options.userFacingText ?? "Here's your image.",
								...(options.turnComplete ? { verifiedUserFacing: true } : {}),
							}),
					data: {
						actionName: "GENERATE_MEDIA_TEST",
						mediaUrl: attachments[0]?.url ?? IMAGE_URL,
						imageUrl: attachments[0]?.url ?? IMAGE_URL,
					},
				};
			},
		} as unknown as Action;
	}

	it("does not resurrect the stage-1 ack behind an already-posted image", async () => {
		// BUG 2: GENERATE_MEDIA posts the image through its own attachment-only
		// callback, then the answerless-final floor resurrected the stage-1
		// "on it" ack behind it — a redundant, out-of-order second bubble. Once a
		// media deliverable shipped this turn, the ack must be suppressed.
		const delivered: Content[] = [];
		const callback: HandlerCallback = async (content) => {
			delivered.push(content);
			return [
				{
					...makeMessage(),
					id: "00000000-0000-0000-0000-000000000099" as UUID,
					content,
				},
			];
		};
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["general"],
						replyText: PROGRESS_ACK,
						extra: { candidateActionNames: ["GENERATE_MEDIA_TEST"] },
					}),
				},
				{
					expectModelType: String(ModelType.ACTION_PLANNER),
					body: {
						text: "",
						toolCalls: [
							{
								id: "gen-media-1",
								name: "GENERATE_MEDIA_TEST",
								arguments: {},
							},
						],
					},
				},
				// The post-media evaluator summarizes the delivered image with a bare
				// completion ack ("Done."), which the media-delivery sanitizer strips
				// to empty — exactly the answerless-final state where the pre-fix
				// floor resurrected the stage-1 ack behind the already-posted image.
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Image delivered.",
						messageToUser: "Done.",
					}),
				},
			],
			evaluators: [],
			actions: [generateMediaAction()],
		});

		const { deliveredMediaUrls, finalText } = await runTurn({
			runtime,
			callback,
			noEarlyReply: true,
		});

		// The image WAS delivered through the action callback.
		expect(
			delivered.some((content) =>
				content.attachments?.some((media) => media.url === IMAGE_URL),
			),
		).toBe(true);
		expect(deliveredMediaUrls).toEqual([IMAGE_URL]);
		// No trailing ack after the image.
		expect(finalText ?? "").toBe("");
		expect(delivered.map((content) => content.text)).not.toContain(
			PROGRESS_ACK,
		);
	});

	it("keeps the progress ack when an attachment callback returns no receipt", async () => {
		const attempted: Content[] = [];
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["general"],
						replyText: PROGRESS_ACK,
						extra: { candidateActionNames: ["GENERATE_MEDIA_TEST"] },
					}),
				},
				{
					expectModelType: String(ModelType.ACTION_PLANNER),
					body: {
						text: "",
						toolCalls: [
							{
								id: "gen-media-no-receipt",
								name: "GENERATE_MEDIA_TEST",
								arguments: {},
							},
						],
					},
				},
			],
			evaluators: [],
			actions: [
				generateMediaAction({
					turnComplete: true,
					userFacingText: PROGRESS_ACK,
				}),
			],
		});

		const { deliveredMediaUrls, finalText } = await runTurn({
			runtime,
			callback: async (content) => {
				attempted.push(content);
				return [];
			},
			noEarlyReply: true,
		});

		expect(attempted).toHaveLength(1);
		expect(deliveredMediaUrls).toEqual([]);
		expect(finalText).toBe(PROGRESS_ACK);
	});

	it("keeps the progress ack when a nonempty receipt contains only text", async () => {
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["general"],
						replyText: PROGRESS_ACK,
						extra: { candidateActionNames: ["GENERATE_MEDIA_TEST"] },
					}),
				},
				{
					expectModelType: String(ModelType.ACTION_PLANNER),
					body: {
						text: "",
						toolCalls: [
							{
								id: "gen-media-text-only-receipt",
								name: "GENERATE_MEDIA_TEST",
								arguments: {},
							},
						],
					},
				},
			],
			evaluators: [],
			actions: [
				generateMediaAction({
					turnComplete: true,
					userFacingText: PROGRESS_ACK,
				}),
			],
		});

		const { deliveredMediaUrls, finalText } = await runTurn({
			runtime,
			callback: async () => [
				{
					...makeMessage(),
					id: "00000000-0000-0000-0000-000000000098" as UUID,
					content: { text: "The connector delivered a text-only fallback." },
				},
			],
			noEarlyReply: true,
		});

		expect(deliveredMediaUrls).toEqual([]);
		expect(finalText).toBe(PROGRESS_ACK);
	});

	it("sanitizes only the attachment URL proven by a partial receipt", async () => {
		const first: Media = {
			id: "generated-image",
			url: IMAGE_URL,
			contentType: "image/png",
			source: "media-generation",
		};
		const second: Media = {
			id: "generated-image-two",
			url: SECOND_IMAGE_URL,
			contentType: "image/png",
			source: "media-generation",
		};
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["general"],
						replyText: PROGRESS_ACK,
						extra: { candidateActionNames: ["GENERATE_MEDIA_TEST"] },
					}),
				},
				{
					expectModelType: String(ModelType.ACTION_PLANNER),
					body: {
						text: "",
						toolCalls: [
							{
								id: "gen-media-partial-receipt",
								name: "GENERATE_MEDIA_TEST",
								arguments: {},
							},
						],
					},
				},
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "One attachment delivered.",
						messageToUser: `Here they are:\n${IMAGE_URL}\n${SECOND_IMAGE_URL}`,
					}),
				},
			],
			evaluators: [],
			actions: [generateMediaAction({ attachments: [first, second] })],
		});

		const { deliveredMediaUrls, finalText } = await runTurn({
			runtime,
			callback: async (content) => [
				{
					...makeMessage(),
					id: "00000000-0000-0000-0000-000000000097" as UUID,
					content: { ...content, attachments: [first] },
				},
			],
			noEarlyReply: true,
		});

		expect(deliveredMediaUrls).toEqual([IMAGE_URL]);
		expect(finalText).not.toContain(IMAGE_URL);
		expect(finalText).toContain(SECOND_IMAGE_URL);
	});

	it("keeps the progress ack when no attachment callback exists", async () => {
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["general"],
						replyText: PROGRESS_ACK,
						extra: { candidateActionNames: ["GENERATE_MEDIA_TEST"] },
					}),
				},
				{
					expectModelType: String(ModelType.ACTION_PLANNER),
					body: {
						text: "",
						toolCalls: [
							{
								id: "gen-media-no-callback",
								name: "GENERATE_MEDIA_TEST",
								arguments: {},
							},
						],
					},
				},
			],
			evaluators: [],
			actions: [
				generateMediaAction({
					turnComplete: true,
					userFacingText: PROGRESS_ACK,
				}),
			],
		});

		const { deliveredMediaUrls, finalText } = await runTurn({
			runtime,
			noEarlyReply: true,
		});

		expect(deliveredMediaUrls).toEqual([]);
		expect(finalText).toBe(PROGRESS_ACK);
	});

	it("does not treat an unrelated successful data.url as delivery", async () => {
		const metadataAction: Action = {
			name: "URL_METADATA_TEST",
			description: "returns a resource locator as internal result metadata",
			similes: [],
			examples: [],
			parameters: [],
			validate: async () => true,
			handler: async () => ({
				success: true,
				text: "Stored resource locator",
				turnComplete: true,
				userFacingText: "Done.",
				verifiedUserFacing: true,
				data: {
					actionName: "URL_METADATA_TEST",
					url: "https://example.test/not-delivered",
				},
			}),
		} as unknown as Action;
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["general"],
						replyText: PROGRESS_ACK,
						extra: { candidateActionNames: ["URL_METADATA_TEST"] },
					}),
				},
				{
					expectModelType: String(ModelType.ACTION_PLANNER),
					body: {
						text: "",
						toolCalls: [
							{
								id: "url-metadata",
								name: "URL_METADATA_TEST",
								arguments: {},
							},
						],
					},
				},
			],
			evaluators: [],
			actions: [metadataAction],
		});

		const { finalText } = await runTurn({
			runtime,
			noEarlyReply: true,
		});

		expect(finalText).toBe("Done.");
	});

	it("does not suppress a non-media action's own reply (the gate keys on media, not on 'an action ran')", async () => {
		// Regression guard for the fix's blast radius: the new `!mediaDeliverableShipped`
		// conjunct must alter delivery ONLY when a media URL was actually shipped.
		// The SAME answerless-finish turn as above, minus the media (no attachment,
		// no mediaUrl in data), must still surface the action's user-facing text —
		// nothing is stripped or suppressed when no deliverable shipped.
		const summary = "Here's the summary you asked for.";
		const noMediaAction: Action = {
			name: "SUMMARIZE_TEST",
			description: "produces a text summary, no media",
			similes: [],
			examples: [],
			parameters: [],
			validate: async () => true,
			handler: async () => ({
				success: true,
				text: "Summarized",
				userFacingText: summary,
				data: { actionName: "SUMMARIZE_TEST" },
			}),
		} as unknown as Action;
		const runtime = makeRuntime({
			responses: [
				{
					expectModelType: String(ModelType.RESPONSE_HANDLER),
					body: stage1Response({
						contexts: ["general"],
						replyText: PROGRESS_ACK,
						extra: { candidateActionNames: ["SUMMARIZE_TEST"] },
					}),
				},
				{
					expectModelType: String(ModelType.ACTION_PLANNER),
					body: {
						text: "",
						toolCalls: [
							{
								id: "summarize-1",
								name: "SUMMARIZE_TEST",
								arguments: {},
							},
						],
					},
				},
				ANSWERLESS_FINISH,
			],
			evaluators: [],
			actions: [noMediaAction],
		});

		const { finalText } = await runTurn({ runtime, noEarlyReply: true });

		// No media shipped: the action's user-facing text is delivered intact,
		// never collapsed to empty the way the media-delivered turn is.
		expect(finalText).toBe(summary);
	});
});
