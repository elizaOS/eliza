/**
 * Semantic mutation action for the experience capability. The Character
 * Experience view edits these same records through HTTP routes; this action
 * gives chat and voice the same use case without asking the model to target a
 * mounted DOM control or raw selector.
 */
import { logger } from "../../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";
import { hasActionContext } from "../../../../utils/action-validation.ts";
import { validateUuid } from "../../../../utils.ts";
import type { ExperienceService } from "../service.ts";
import { type Experience, ExperienceType, OutcomeType } from "../types.ts";

const EXPERIENCE = "EXPERIENCE";
const EXPERIENCE_OPS = ["update", "delete"] as const;
type ExperienceOp = (typeof EXPERIENCE_OPS)[number];

interface ExperienceParams {
	action?: ExperienceOp;
	op?: ExperienceOp;
	subaction?: ExperienceOp;
	experienceId?: string;
	id?: string;
	query?: string;
	confirm?: boolean;
	learning?: string;
	importance?: number | string;
	confidence?: number | string;
	tags?: string[] | string;
	context?: string;
	result?: string;
	domain?: string;
	type?: ExperienceType | string;
	outcome?: OutcomeType | string;
}

function fail(text: string, error: string): ActionResult {
	return { success: false, text, data: { error } };
}

function isActionResult(value: unknown): value is ActionResult {
	return Boolean(
		value && typeof value === "object" && "success" in value && "text" in value,
	);
}

function getActionParams(
	options: HandlerOptions | undefined,
): Record<string, unknown> {
	const direct =
		options && typeof options === "object"
			? (options as Record<string, unknown>)
			: {};
	const parameters =
		direct.parameters && typeof direct.parameters === "object"
			? (direct.parameters as Record<string, unknown>)
			: {};
	return { ...direct, ...parameters };
}

function normalizeExperienceOp(
	params: ExperienceParams,
): ExperienceOp | undefined {
	const candidate = params.action ?? params.subaction ?? params.op;
	return candidate && EXPERIENCE_OPS.includes(candidate)
		? candidate
		: undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function readScore(
	value: unknown,
	name: string,
): number | ActionResult | undefined {
	const parsed = readNumber(value);
	if (parsed === undefined) return undefined;
	if (parsed < 0 || parsed > 1) {
		return fail(
			`${name} must be a number from 0 to 1.`,
			"EXPERIENCE_INVALID_SCORE",
		);
	}
	return parsed;
}

function readTags(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		return value
			.filter((item): item is string => typeof item === "string")
			.map((tag) => tag.trim())
			.filter(Boolean);
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean);
	}
	return undefined;
}

function isExperienceType(value: unknown): value is ExperienceType {
	return Object.values(ExperienceType).includes(value as ExperienceType);
}

function isOutcomeType(value: unknown): value is OutcomeType {
	return Object.values(OutcomeType).includes(value as OutcomeType);
}

function getExperienceService(
	runtime: IAgentRuntime,
): ExperienceService | null {
	return runtime.getService("EXPERIENCE") as ExperienceService | null;
}

async function resolveExperienceTarget(
	service: ExperienceService,
	params: ExperienceParams,
): Promise<Experience | ActionResult> {
	const rawId = readString(params.experienceId) ?? readString(params.id);
	if (rawId) {
		const id = validateUuid(rawId);
		if (!id) {
			return fail(
				`experienceId "${rawId}" is not a valid UUID. Use an id from EXPERIENCE search results or provide a query.`,
				"EXPERIENCE_INVALID_ID",
			);
		}
		const experience = await service.getExperience(id);
		if (!experience) {
			return fail(`Experience ${id} was not found.`, "EXPERIENCE_NOT_FOUND");
		}
		return experience;
	}

	const query = readString(params.query);
	if (!query) {
		return fail(
			"experienceId or query is required.",
			"EXPERIENCE_MISSING_TARGET",
		);
	}

	const matches = await service.queryExperiences({
		query,
		limit: 5,
		minConfidence: 0,
		includeRelated: false,
	});
	if (matches.length === 0) {
		return fail(`No experience matches "${query}".`, "EXPERIENCE_NOT_FOUND");
	}
	if (matches.length > 1) {
		const candidates = matches
			.map((experience) =>
				`- ${experience.id}: ${experience.learning || experience.result || experience.context}`.slice(
					0,
					180,
				),
			)
			.join("\n");
		return {
			success: false,
			text: `Query "${query}" matches multiple experiences. Choose one by experienceId:\n${candidates}`,
			data: { error: "EXPERIENCE_AMBIGUOUS_QUERY", query, candidates: matches },
		};
	}
	return matches[0];
}

function buildExperienceUpdates(
	params: ExperienceParams,
): Partial<Experience> | ActionResult {
	const updates: Partial<Experience> = {};

	const learning = readString(params.learning);
	if (learning !== undefined) updates.learning = learning;
	const context = readString(params.context);
	if (context !== undefined) updates.context = context;
	const result = readString(params.result);
	if (result !== undefined) updates.result = result;
	const domain = readString(params.domain);
	if (domain !== undefined) updates.domain = domain;

	const tags = readTags(params.tags);
	if (tags !== undefined) updates.tags = tags;

	const importance = readScore(params.importance, "importance");
	if (typeof importance === "object") return importance;
	if (importance !== undefined) updates.importance = importance;

	const confidence = readScore(params.confidence, "confidence");
	if (typeof confidence === "object") return confidence;
	if (confidence !== undefined) updates.confidence = confidence;

	if (params.type !== undefined) {
		if (!isExperienceType(params.type)) {
			return fail(
				`type must be one of ${Object.values(ExperienceType).join(", ")}.`,
				"EXPERIENCE_INVALID_TYPE",
			);
		}
		updates.type = params.type;
	}

	if (params.outcome !== undefined) {
		if (!isOutcomeType(params.outcome)) {
			return fail(
				`outcome must be one of ${Object.values(OutcomeType).join(", ")}.`,
				"EXPERIENCE_INVALID_OUTCOME",
			);
		}
		updates.outcome = params.outcome;
	}

	if (Object.keys(updates).length === 0) {
		return fail(
			"At least one editable experience field is required.",
			"EXPERIENCE_EMPTY_UPDATE",
		);
	}

	return updates;
}

async function doUpdate(
	service: ExperienceService,
	params: ExperienceParams,
): Promise<ActionResult> {
	if (params.confirm !== true) {
		return fail(
			"Refusing to update: pass confirm:true to acknowledge overwriting an existing experience.",
			"EXPERIENCE_CONFIRMATION_REQUIRED",
		);
	}

	const target = await resolveExperienceTarget(service, params);
	if (isActionResult(target)) return target;
	const updates = buildExperienceUpdates(params);
	if (isActionResult(updates)) return updates;

	const updated = await service.updateExperience(target.id, updates);
	if (!updated) {
		return fail(
			`Experience ${target.id} was not found.`,
			"EXPERIENCE_NOT_FOUND",
		);
	}

	return {
		success: true,
		text: `Updated experience ${updated.id}: ${updated.learning || updated.result || updated.context}`,
		values: { experienceId: updated.id },
		data: {
			actionName: EXPERIENCE,
			op: "update" as const,
			experienceId: updated.id,
			experience: updated,
		},
	};
}

async function doDelete(
	service: ExperienceService,
	params: ExperienceParams,
): Promise<ActionResult> {
	if (params.confirm !== true) {
		return fail(
			"Refusing to delete: pass confirm:true to acknowledge this destructive action.",
			"EXPERIENCE_CONFIRMATION_REQUIRED",
		);
	}

	const target = await resolveExperienceTarget(service, params);
	if (isActionResult(target)) return target;

	const deleted = await service.deleteExperience(target.id);
	if (!deleted) {
		return fail(
			`Experience ${target.id} was not found.`,
			"EXPERIENCE_NOT_FOUND",
		);
	}

	return {
		success: true,
		text: `Deleted experience ${target.id}: ${target.learning || target.result || target.context}`,
		values: { experienceId: target.id },
		data: {
			actionName: EXPERIENCE,
			op: "delete" as const,
			experienceId: target.id,
			deletedExperience: target,
		},
	};
}

export const experienceAction: Action = {
	name: EXPERIENCE,
	contexts: ["memory", "settings", "agent_internal"],
	roleGate: { minRole: "OWNER" },
	similes: [
		"UPDATE_EXPERIENCE",
		"DELETE_EXPERIENCE",
		"EDIT_EXPERIENCE",
		"REMOVE_EXPERIENCE",
		"FORGET_EXPERIENCE",
	],
	description:
		"Update or delete an agent experience record. Use op=update to edit learning/importance/confidence/tags/context/result/domain/type/outcome, or op=delete to remove an experience. Mutations require confirm:true and can target either experienceId or a unique query.",
	descriptionCompressed:
		"edit/delete agent experiences; target by experienceId or unique query; update/delete require confirm:true",
	routingHint:
		"edit/delete the agent's own learned experience records shown in Character > Experience -> EXPERIENCE; search/read experiences -> SEARCH_EXPERIENCES; ordinary chat facts -> MEMORY",
	validate: async (runtime, message, state, options) => {
		if (!getExperienceService(runtime)) return false;
		const params = getActionParams(options);
		if (normalizeExperienceOp(params as ExperienceParams)) return true;
		const text =
			typeof message.content.text === "string"
				? message.content.text.toLowerCase()
				: "";
		return (
			(/\b(experience|experiences|learning|learnings)\b/.test(text) &&
				/\b(delete|remove|forget|edit|update|change|revise)\b/.test(text)) ||
			hasActionContext(message, state, {
				contexts: ["memory", "settings", "agent_internal"],
			})
		);
	},
	async handler(
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> {
		void message;
		void state;
		void callback;
		const service = getExperienceService(runtime);
		if (!service) {
			return fail(
				"Experience service is unavailable.",
				"EXPERIENCE_UNAVAILABLE",
			);
		}

		const params = getActionParams(options) as ExperienceParams;
		const op = normalizeExperienceOp(params);
		if (!op) {
			return fail(
				`op/subaction is required and must be one of ${EXPERIENCE_OPS.join(", ")}.`,
				"EXPERIENCE_INVALID_OP",
			);
		}

		try {
			switch (op) {
				case "update":
					return await doUpdate(service, params);
				case "delete":
					return await doDelete(service, params);
			}
		} catch (error) {
			// error-policy:J1 action boundary translates internal mutation failures into model-visible action failure.
			const messageText =
				error instanceof Error ? error.message : String(error);
			logger.warn(`[experience:${op}] failed: ${messageText}`);
			return fail(
				`Failed to ${op} experience: ${messageText}`,
				`EXPERIENCE_${op.toUpperCase()}_FAILED`,
			);
		}
	},
	parameters: [
		{
			name: "op",
			description: "Operation to perform. One of: update, delete.",
			required: true,
			schema: { type: "string" as const, enum: [...EXPERIENCE_OPS] },
		},
		{
			name: "experienceId",
			description:
				"ID of the experience to mutate. Optional when query uniquely resolves one experience.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "query",
			description:
				"Natural-language target used when experienceId is unknown; must resolve to exactly one experience.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "confirm",
			description:
				"Must be true for update/delete to acknowledge the destructive mutation.",
			required: true,
			schema: { type: "boolean" as const },
		},
		{
			name: "learning",
			description: "update: replacement learning text.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "importance",
			description: "update: importance score from 0 to 1.",
			required: false,
			schema: { type: "number" as const, minimum: 0, maximum: 1 },
		},
		{
			name: "confidence",
			description: "update: confidence score from 0 to 1.",
			required: false,
			schema: { type: "number" as const, minimum: 0, maximum: 1 },
		},
		{
			name: "tags",
			description:
				"update: replacement tags as an array or comma-separated text.",
			required: false,
			schema: { type: "array" as const, items: { type: "string" as const } },
		},
	],
	examples: [
		[
			{
				name: "{{user}}",
				content: {
					text: "Delete the experience about the stale onboarding tile.",
					actions: [EXPERIENCE],
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "Deleted the matching experience.",
				},
			},
		],
	] as ActionExample[][],
};
