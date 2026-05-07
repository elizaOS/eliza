import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import { logger } from "../../../logger.ts";
import { thinkTemplate } from "../../../prompts.ts";
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
import {
	composePromptFromState,
	parseJSONObjectFromText,
} from "../../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("THINK");

export const thinkAction = {
	name: spec.name,
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
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

		logger.debug(
			{
				src: "plugin:advanced-capabilities:action:think",
				agentId: runtime.agentId,
				previousResultCount: previousResults.length,
			},
			"Starting deep thinking",
		);

		// Gather all providers requested by earlier responses in the chain
		const allProviders: string[] = [];
		if (responses) {
			for (const res of responses) {
				const providers = res.content?.providers;
				if (providers && providers.length > 0) {
					allProviders.push(...providers);
				}
			}
		}

		// Compose full state with all available context
		state = await runtime.composeState(message, [
			...(allProviders ?? []),
			"RECENT_MESSAGES",
			"ACTION_STATE",
		]);

		const prompt = composePromptFromState({
			state,
			template: runtime.character.templates?.thinkTemplate || thinkTemplate,
		});

		// Use the large model for deeper reasoning — this is the core
		// upgrade over the default planning pass which uses ACTION_PLANNER
		const response = await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt,
		});

		const parsedJson = parseJSONObjectFromText(response);
		const thoughtValue = parsedJson?.thought;
		const textValue = parsedJson?.text;
		const thought: string =
			typeof thoughtValue === "string" ? thoughtValue : "";
		const text: string =
			typeof textValue === "string" ? textValue : response.trim();

		if (callback) {
			await callback({
				thought,
				text,
				actions: ["THINK"] as string[],
			});
		}

		// The result flows to subsequent actions via actionContext.previousResults.
		// Downstream actions see this as the first link in the chain and can build
		// on the deeper analysis without re-deriving it.
		const now = Date.now();
		return {
			text,
			values: {
				success: true,
				responded: true,
				lastReply: text,
				lastReplyTime: now,
				thoughtProcess: thought,
			},
			data: {
				actionName: "THINK",
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
