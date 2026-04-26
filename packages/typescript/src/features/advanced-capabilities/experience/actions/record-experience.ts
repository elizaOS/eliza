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
import type { ExperienceService } from "../service.ts";
import { ExperienceType, OutcomeType } from "../types.ts";
import {
	detectExperienceDomain,
	findDuplicateExperienceByLearning,
	sanitizeExperienceText,
} from "../utils/experienceText.ts";

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

		logger.info(
			`[RecordExperienceAction] Recording experience for message ${message.id}`,
		);

		const experienceService = runtime.getService(
			"EXPERIENCE",
		) as ExperienceService | null;
		if (!experienceService) {
			logger.error(
				"[RecordExperienceAction] Experience service is unavailable",
			);
			return {
				success: false,
				text: "Experience service is unavailable.",
			};
		}

		const messageText =
			typeof message.content.text === "string" ? message.content.text : "";
		const learningText = normalizeExplicitLearningText(messageText);
		const sanitizedLearning = sanitizeExperienceText(learningText);
		const duplicate = await findDuplicateExperienceByLearning(
			experienceService,
			sanitizedLearning,
		);
		if (duplicate) {
			logger.info(
				`[RecordExperienceAction] Existing similar experience reused (${duplicate.id})`,
			);
			return {
				success: true,
				text: "Experience already recorded.",
				data: {
					experienceId: duplicate.id,
					duplicate: true,
				},
			};
		}

		const metadata =
			message.metadata &&
			typeof message.metadata === "object" &&
			!Array.isArray(message.metadata)
				? (message.metadata as Record<string, unknown>)
				: {};
		const sourceTrajectoryId =
			typeof metadata.trajectoryId === "string" &&
			metadata.trajectoryId.trim().length > 0
				? metadata.trajectoryId.trim()
				: undefined;
		const sourceTrajectoryStepId =
			typeof metadata.trajectoryStepId === "string" &&
			metadata.trajectoryStepId.trim().length > 0
				? metadata.trajectoryStepId.trim()
				: undefined;

		const recordedExperience = await experienceService.recordExperience({
			type: ExperienceType.LEARNING,
			outcome: OutcomeType.NEUTRAL,
			context: sanitizeExperienceText(state?.text ?? ""),
			action: "explicit_record_request",
			result: "Recorded from explicit remember/record request.",
			learning: sanitizedLearning,
			domain: detectExperienceDomain(sanitizedLearning),
			tags: ["manual", "explicit"],
			sourceMessageIds: message.id ? [message.id] : undefined,
			sourceRoomId: message.roomId,
			sourceTriggerMessageId: message.id,
			sourceTrajectoryId,
			sourceTrajectoryStepId,
			extractionMethod: "record_experience_action",
		});

		logger.info(
			`[RecordExperienceAction] Experience recorded successfully (${recordedExperience.id})`,
		);

		return {
			success: true,
			text: "Experience recorded.",
			data: {
				experienceId: recordedExperience.id,
			},
		};
	},
};

function normalizeExplicitLearningText(text: string): string {
	const normalized = text
		.replace(
			/^\s*(?:please\s+)?(?:remember|record)(?:\s+this)?(?:\s+experience)?\s*:?\s*/i,
			"",
		)
		.trim();

	return normalized || text;
}
