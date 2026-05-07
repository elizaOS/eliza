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
import { hasActionContextOrKeyword } from "../../../../utils/action-validation.ts";
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
	contexts: ["memory", "knowledge", "agent_internal"],
	roleGate: { minRole: "USER" },
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	parameters: [
		{
			name: "learning",
			description:
				"Explicit learning or experience text to record. Defaults to the user message text.",
			required: false,
			schema: { type: "string" as const },
		},
	],
	examples: (spec.examples ?? []) as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		if (!runtime.getService("EXPERIENCE")) {
			return false;
		}
		const params =
			options?.parameters && typeof options.parameters === "object"
				? (options.parameters as Record<string, unknown>)
				: {};
		if (typeof params.learning === "string" && params.learning.trim()) {
			return true;
		}
		const text = message.content.text?.toLowerCase() ?? "";
		return (
			/\b(?:remember|record).*\b(?:experience|learning|lesson|this)\b/i.test(
				text,
			) ||
			hasActionContextOrKeyword(message, state, {
				contexts: ["memory", "knowledge", "agent_internal"],
				keywords: [
					"record experience",
					"remember this",
					"record this learning",
					"save this lesson",
				],
			})
		);
	},

	async handler(
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		_callback?: HandlerCallback,
	): Promise<ActionResult> {
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

		const params =
			_options?.parameters && typeof _options.parameters === "object"
				? (_options.parameters as Record<string, unknown>)
				: {};
		const messageText =
			typeof params.learning === "string" && params.learning.trim()
				? params.learning.trim()
				: typeof message.content.text === "string"
					? message.content.text
					: "";
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
			associatedEntityIds: message.entityId ? [message.entityId] : [],
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
