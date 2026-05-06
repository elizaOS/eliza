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
import { composePromptFromState, parseToonKeyValue } from "../../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("REPLY");

function getPlannerReplyFallback(responses?: Memory[]): string {
	for (const response of responses ?? []) {
		const text = response.content?.text;
		if (typeof text === "string" && text.trim().length > 0) {
			return text.trim();
		}
	}

	return "";
}

export const replyAction = {
	name: spec.name,
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	suppressPostActionContinuation: true,
	validate: async (_runtime: IAgentRuntime) => {
		return true;
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
		responses?: Memory[],
	): Promise<ActionResult> => {
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

		const prompt = composePromptFromState({
			state,
			template: runtime.character.templates?.replyTemplate || replyTemplate,
		});

		const plannerReplyFallback = getPlannerReplyFallback(responses);
		let response: string;
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

		const parsedToon = parseToonKeyValue(response);
		const thoughtValue = parsedToon?.thought;
		const textValue = parsedToon?.text;
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
