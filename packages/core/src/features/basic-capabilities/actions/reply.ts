import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import { logger } from "../../../logger.ts";
import { replyTemplate } from "../../../prompts.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { ModelType } from "../../../types/index.ts";
import { hasActionContext } from "../../../utils/action-validation.ts";
import {
	composePromptFromState,
	parseJSONObjectFromText,
} from "../../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("REPLY");

const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 4;

export interface ReplyQuestionOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface ReplyQuestion {
	question: string;
	header: string;
	options?: ReplyQuestionOption[];
	multiSelect?: boolean;
}

function parseOption(
	raw: unknown,
	qIdx: number,
	oIdx: number,
): ReplyQuestionOption | { error: string } {
	if (!raw || typeof raw !== "object") {
		return { error: `questions[${qIdx}].options[${oIdx}] must be an object` };
	}
	const obj = raw as Record<string, unknown>;
	const label = obj.label;
	if (typeof label !== "string" || label.length === 0) {
		return {
			error: `questions[${qIdx}].options[${oIdx}].label must be a non-empty string`,
		};
	}
	const out: ReplyQuestionOption = { label };
	if (typeof obj.description === "string") out.description = obj.description;
	if (typeof obj.preview === "string") out.preview = obj.preview;
	return out;
}

function parseQuestion(
	raw: unknown,
	idx: number,
): ReplyQuestion | { error: string } {
	if (!raw || typeof raw !== "object") {
		return { error: `questions[${idx}] must be an object` };
	}
	const obj = raw as Record<string, unknown>;

	const question = obj.question;
	if (typeof question !== "string" || question.trim().length === 0) {
		return { error: `questions[${idx}].question must be a non-empty string` };
	}
	const header = obj.header;
	if (typeof header !== "string" || header.trim().length === 0) {
		return { error: `questions[${idx}].header must be a non-empty string` };
	}

	const out: ReplyQuestion = { question, header };

	if (obj.multiSelect !== undefined) {
		if (typeof obj.multiSelect !== "boolean") {
			return { error: `questions[${idx}].multiSelect must be a boolean` };
		}
		out.multiSelect = obj.multiSelect;
	}

	if (obj.options !== undefined) {
		if (!Array.isArray(obj.options)) {
			return {
				error: `questions[${idx}].options must be an array when provided`,
			};
		}
		if (obj.options.length > 0) {
			const opts: ReplyQuestionOption[] = [];
			for (let oIdx = 0; oIdx < obj.options.length; oIdx++) {
				const parsed = parseOption(obj.options[oIdx], idx, oIdx);
				if ("error" in parsed) return { error: parsed.error };
				opts.push(parsed);
			}
			out.options = opts;
		}
	}

	return out;
}

function renderQuestions(questions: readonly ReplyQuestion[]): string {
	return questions
		.map((q, idx) => {
			const lines: string[] = [`${idx + 1}. ${q.header}`, q.question];
			if (q.options && q.options.length > 0) {
				for (const opt of q.options) {
					const desc = opt.description ? ` — ${opt.description}` : "";
					lines.push(`   - ${opt.label}${desc}`);
				}
				if (q.multiSelect) lines.push("   (select one or more)");
			} else {
				lines.push("   (freeform answer)");
			}
			return lines.join("\n");
		})
		.join("\n\n");
}

function getPlannerReplyFallback(responses?: Memory[]): string {
	for (const response of responses ?? []) {
		const text = response.content?.text;
		if (typeof text === "string" && text.trim().length > 0) {
			return text.trim();
		}
	}

	return "";
}

function readQuestionsParam(options: HandlerOptions | undefined): unknown {
	if (!options || typeof options !== "object") return undefined;
	const opts = options as Record<string, unknown>;
	const params = opts.parameters as Record<string, unknown> | undefined;
	return params?.questions ?? opts.questions;
}

function readTextParam(
	options: HandlerOptions | undefined,
): string | undefined {
	if (!options || typeof options !== "object") return undefined;
	const opts = options as Record<string, unknown>;
	const params = opts.parameters as Record<string, unknown> | undefined;
	const value = params?.text ?? opts.text;
	return typeof value === "string" ? value : undefined;
}

const baseDescription = spec.description ?? "";
const extendedDescription = baseDescription.includes("questions[]")
	? baseDescription
	: `${baseDescription} Use to reply with text, or to ask the user a structured question by passing questions[] (1-4 items, optional multi-choice options).`.trim();

const baseDescriptionCompressed =
	(spec as { descriptionCompressed?: string }).descriptionCompressed ??
	"reply to the user";
const extendedDescriptionCompressed = baseDescriptionCompressed.includes(
	"questions",
)
	? baseDescriptionCompressed
	: `${baseDescriptionCompressed}; pass questions[] (1-4) to broadcast a structured question instead of free text`;

export const replyAction = {
	name: spec.name,
	contexts: ["general", "messaging"],
	roleGate: { minRole: "USER" },
	similes: [
		...((spec.similes ?? []) as string[]),
		"ASK_USER_QUESTION",
		"ASK",
		"CLARIFY",
	],
	description: extendedDescription,
	descriptionCompressed: extendedDescriptionCompressed,
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "text",
			description:
				"Optional reply text. If omitted (and `questions` is also omitted), the action composes a reply from current state.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "questions",
			description:
				"Optional. Array of 1-4 structured question objects: { question, header, options?: Array<{label, description?, preview?}>, multiSelect? }. When provided, REPLY broadcasts the structured questions and returns requiresUserInteraction: true (UI integration pending; non-blocking).",
			required: false,
			schema: {
				type: "array",
				items: {
					type: "object",
					properties: {
						question: { type: "string" },
						header: { type: "string" },
						multiSelect: { type: "boolean" },
						options: {
							type: "array",
							items: {
								type: "object",
								properties: {
									label: { type: "string" },
									description: { type: "string" },
									preview: { type: "string" },
								},
								required: ["label"],
							},
						},
					},
					required: ["question", "header"],
				},
			},
		},
	],
	validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) =>
		hasActionContext(message, state, {
			contexts: ["general", "messaging"],
			keywords: ["reply", "respond", "answer", "say", "tell me", "explain"],
		}),
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
		responses?: Memory[],
	): Promise<ActionResult> => {
		// Structured-question branch (absorbs old ASK_USER_QUESTION action).
		const rawQuestions = readQuestionsParam(_options);
		if (rawQuestions !== undefined) {
			if (!Array.isArray(rawQuestions)) {
				return {
					success: false,
					text: "questions must be an array when provided",
					data: {
						actionName: "REPLY",
						error: "INVALID_PARAM",
						field: "questions",
					},
					error: new Error("questions must be an array when provided"),
				};
			}
			if (
				rawQuestions.length < MIN_QUESTIONS ||
				rawQuestions.length > MAX_QUESTIONS
			) {
				return {
					success: false,
					text: `questions must contain ${MIN_QUESTIONS}-${MAX_QUESTIONS} items, got ${rawQuestions.length}`,
					data: {
						actionName: "REPLY",
						error: "INVALID_PARAM",
						field: "questions",
					},
					error: new Error(
						`questions must contain ${MIN_QUESTIONS}-${MAX_QUESTIONS} items`,
					),
				};
			}

			const questions: ReplyQuestion[] = [];
			for (let i = 0; i < rawQuestions.length; i++) {
				const parsed = parseQuestion(rawQuestions[i], i);
				if ("error" in parsed) {
					return {
						success: false,
						text: parsed.error,
						data: {
							actionName: "REPLY",
							error: "INVALID_PARAM",
							message: parsed.error,
						},
						error: new Error(parsed.error),
					};
				}
				questions.push(parsed);
			}

			const text = renderQuestions(questions);
			logger.debug(
				{
					src: "plugin:basic-capabilities:action:reply:questions",
					agentId: runtime.agentId,
					count: questions.length,
				},
				"REPLY broadcasting structured questions",
			);

			if (callback) {
				await callback({ text, source: "reply" });
			}

			return {
				success: true,
				text,
				values: {
					success: true,
					responded: true,
					requiresUserInteraction: true,
					questionCount: questions.length,
				},
				data: {
					actionName: "REPLY",
					questions,
					requiresUserInteraction: true,
				},
			};
		}

		// Free-text branch (the original REPLY behavior).
		const actionContext = _options?.actionContext;
		const previousResults = actionContext?.previousResults || [];

		if (previousResults.length > 0) {
			logger.debug(
				{
					src: "plugin:basic-capabilities:action:reply",
					agentId: runtime.agentId,
					count: previousResults.length,
				},
				"Found previous action results",
			);
		}

		const allProviders: string[] = [];
		if (responses) {
			for (const res of responses) {
				const providers = res.content?.providers;
				if (providers && providers.length > 0) {
					allProviders.push(...providers);
				}
			}
		}

		state = await runtime.composeState(message, [
			...(allProviders ?? []),
			"RECENT_MESSAGES",
			"ACTION_STATE",
		]);

		// If a caller provided text directly, skip the model and use it verbatim.
		const directText = readTextParam(_options);

		const prompt = composePromptFromState({
			state,
			template: runtime.character.templates?.replyTemplate || replyTemplate,
		});

		const plannerReplyFallback = getPlannerReplyFallback(responses);
		let response: string;
		if (directText !== undefined && directText.trim().length > 0) {
			response = directText;
		} else {
			try {
				response = await runtime.useModel(ModelType.TEXT_LARGE, {
					prompt,
				});
			} catch (error) {
				if (plannerReplyFallback) {
					logger.warn(
						{
							src: "plugin:basic-capabilities:action:reply",
							agentId: runtime.agentId,
							error: error instanceof Error ? error.message : String(error),
						},
						"Reply model failed; using planner reply fallback",
					);
					response = "";
				} else {
					throw error;
				}
			}
		}

		const parsedJson = parseJSONObjectFromText(response);
		const thoughtValue = parsedJson?.thought;
		const textValue = parsedJson?.text;
		const thought: string =
			typeof thoughtValue === "string" ? thoughtValue : "";
		const parsedText = typeof textValue === "string" ? textValue.trim() : "";
		const rawText = response.trim();
		const text =
			parsedText ||
			plannerReplyFallback ||
			(rawText.startsWith("<") ? "" : rawText);

		const responseContent = {
			thought,
			text,
			actions: ["REPLY"] as string[],
		};

		if (callback) {
			await callback(responseContent);
		}

		const now = Date.now();
		return {
			text: responseContent.text,
			values: {
				success: true,
				responded: true,
				lastReply: responseContent.text,
				lastReplyTime: now,
				thoughtProcess: thought,
			},
			data: {
				actionName: "REPLY",
				responseThought: thought,
				responseText: text,
				thought,
				messageGenerated: true,
			},
			success: true,
		};
	},
	examples: (spec.examples ?? []) as ActionExample[][],
} as Action;
