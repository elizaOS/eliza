import { createUniqueUuid } from "../../../../entities.ts";
import { logger } from "../../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
} from "../../../../types/components.ts";
import type { Memory } from "../../../../types/memory.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { State } from "../../../../types/state.ts";
import { requireActionSpec } from "../generated/specs/spec-helpers";

const spec = requireActionSpec("RECORD_EXPERIENCE");

export const recordExperienceAction: Action = {
	name: spec.name,
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	examples: (spec.examples ?? []) as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const __avTextRaw =
			typeof message?.content?.text === "string" ? message.content.text : "";
		const __avText = __avTextRaw.toLowerCase();
		const __avKeywords = ["record", "experience"];
		const __avKeywordOk =
			__avKeywords.length > 0 &&
			__avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
		const __avRegex = /\b(?:record|experience)\b/i;
		const __avRegexOk = Boolean(__avText.match(__avRegex));
		const __avSource = String(message?.content?.source ?? "");
		const __avExpectedSource = "";
		const __avSourceOk = __avExpectedSource
			? __avSource === __avExpectedSource
			: Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
		const __avOptions = options && typeof options === "object" ? options : {};
		const __avInputOk =
			__avText.trim().length > 0 ||
			Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
			Boolean(message?.content && typeof message.content === "object");

		if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
			return false;
		}

		const __avLegacyValidate = async (
			_runtime: IAgentRuntime,
			message: Memory,
		) => {
			const text = message.content.text?.toLowerCase();
			return text?.includes("remember") || text?.includes("record") || false;
		};
		try {
			return Boolean(await __avLegacyValidate(runtime, message));
		} catch {
			return false;
		}
	},

	async handler(
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		_callback?: HandlerCallback,
	): Promise<ActionResult> {
		void _options;
		void _callback;

		logger.info("Recording experience for message:", message.id);

		// Create experience memory with context
		const experienceMemory: Memory = {
			id: createUniqueUuid(runtime, `experience-${message.id}`),
			entityId: message.entityId,
			agentId: runtime.agentId,
			roomId: message.roomId,
			content: {
				text: message.content.text,
				source: message.content.source,
				type: "experience",
				context: state?.text,
			},
			createdAt: Date.now(),
		};

		// Store in experiences table
		await runtime.createMemory(experienceMemory, "experiences", true);
		logger.info("Experience recorded successfully");

		return {
			success: true,
			text: "Experience recorded.",
			data: {
				experienceMemoryId: experienceMemory.id,
			},
		};
	},
};
