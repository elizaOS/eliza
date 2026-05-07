import { v4 } from "uuid";
import z from "zod";
import { getEntityDetails } from "../../../entities.ts";
import { requireEvaluatorSpec } from "../../../generated/spec-helpers.ts";
import { reflectionEvaluatorTemplate } from "../../../prompts.ts";
import type {
	Action,
	ActionResult,
	Entity,
	EvaluationExample,
	Evaluator,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { ActionMode, asUUID, ModelType } from "../../../types/index.ts";
import { MemoryType } from "../../../types/memory.ts";
import { composePrompt, parseJSONObjectFromText } from "../../../utils.ts";
import {
	formatTaskCompletionStatus,
	getTaskCompletionCacheKey,
	type TaskCompletionAssessment,
} from "./task-completion.ts";

// Get text content from centralized specs
const spec = requireEvaluatorSpec("REFLECTION");

/** Shape of a single fact in structured JSON responses. */
interface FactJson {
	claim?: string;
	type?: string;
	in_bio?: string;
	already_known?: string;
}

/** Shape of a single relationship in structured responses. */
interface RelationshipJson {
	sourceEntityId?: string;
	targetEntityId?: string;
	tags?: string;
	metadata?: Record<string, unknown>;
}

/** Shape of task completion in structured responses. */
interface TaskCompletionJson {
	completed?: string | boolean;
	reason?: string;
}

interface ReflectionJsonResult {
	thought?: string;
	facts?:
		| {
				fact?: FactJson | FactJson[];
		  }
		| FactJson[];
	relationships?:
		| {
				relationship?: RelationshipJson | RelationshipJson[];
		  }
		| RelationshipJson[];
	task?: TaskCompletionJson;
	taskCompletion?: TaskCompletionJson;
	task_completed?: string | boolean;
	taskCompleted?: string | boolean;
	task_completion_reason?: string;
	taskCompletionReason?: string;
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_ENTITY_REFERENCE_PATTERN =
	/^(entity_(initiating|being)_interaction|user(?:-\d+)?|scenarioagent(?:-agent)?|[a-z]+-agent|clinic|sms-message)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatPromptData(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function normalizeFactEntries(value: unknown): FactJson[] {
	if (Array.isArray(value)) {
		return value.filter(isRecord) as FactJson[];
	}

	if (isRecord(value) && "fact" in value) {
		return normalizeFactEntries(value.fact);
	}

	return isRecord(value) ? [value as FactJson] : [];
}

function normalizeRelationshipEntries(value: unknown): RelationshipJson[] {
	if (Array.isArray(value)) {
		return value.filter(isRecord) as RelationshipJson[];
	}

	if (isRecord(value) && "relationship" in value) {
		return normalizeRelationshipEntries(value.relationship);
	}

	return isRecord(value) ? [value as RelationshipJson] : [];
}

function isOmittedStructuredList(value: unknown, itemKey: string): boolean {
	if (value == null) {
		return true;
	}

	if (Array.isArray(value)) {
		return value.length === 0;
	}

	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		return (
			normalized.length === 0 ||
			normalized === "[]" ||
			normalized === "none" ||
			normalized === "null"
		);
	}

	if (isRecord(value)) {
		const entries = Object.entries(value);
		if (entries.length === 0) {
			return true;
		}

		if (entries.length === 1 && entries[0]?.[0] === itemKey) {
			return isOmittedStructuredList(entries[0][1], itemKey);
		}
	}

	return false;
}

function hasValidStructuredList<T>(
	value: unknown,
	itemKey: string,
	normalize: (input: unknown) => T[],
): boolean {
	return isOmittedStructuredList(value, itemKey) || normalize(value).length > 0;
}

function parseBooleanLike(value: unknown): boolean | null {
	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
		return null;
	}

	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "yes" || normalized === "1") {
			return true;
		}
		if (normalized === "false" || normalized === "no" || normalized === "0") {
			return false;
		}
	}

	return null;
}

const JSON_HEADER_PATTERN = /^JSON(?:\s+OBJECT)?[:\s-]*$/i;
const STRUCTURED_FIELD_PATTERN =
	/^[A-Za-z_][A-Za-z0-9_.-]*(?:\[[^\]\n]*\])?(?:\{[^\n]*\})?:/;

function extractEmbeddedStructuredDocument(text: string): string | null {
	const lines = text.trim().split(/\r?\n/);
	const startIndex = lines.findIndex((line) => {
		const trimmed = line.trim();
		return (
			JSON_HEADER_PATTERN.test(trimmed) ||
			STRUCTURED_FIELD_PATTERN.test(trimmed)
		);
	});

	if (startIndex === -1) {
		return null;
	}

	const collected: string[] = [];
	let sawStructuredField = false;

	for (let index = startIndex; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const trimmed = line.trim();
		const isStructuredField = STRUCTURED_FIELD_PATTERN.test(trimmed);
		const isIndented = /^[\t ]+/.test(line);
		const isHeader = JSON_HEADER_PATTERN.test(trimmed);

		if (isHeader && !sawStructuredField) {
			collected.push(line);
			continue;
		}

		if (isStructuredField) {
			sawStructuredField = true;
			collected.push(line);
			continue;
		}

		if (trimmed.length === 0 || isIndented) {
			if (collected.length > 0) {
				collected.push(line);
				continue;
			}
		}

		break;
	}

	if (!sawStructuredField) {
		return null;
	}

	return collected.join("\n").trim();
}

function extractJsonReflectionRecord(
	value: Record<string, unknown>,
): ReflectionJsonResult | null {
	const candidates = [
		value,
		isRecord(value.response) ? value.response : null,
		isRecord(value.reflection) ? value.reflection : null,
	].filter(
		(candidate): candidate is Record<string, unknown> => candidate != null,
	);

	for (const candidate of candidates) {
		if (
			!("facts" in candidate) &&
			!("relationships" in candidate) &&
			!("thought" in candidate) &&
			!("task" in candidate) &&
			!("taskCompletion" in candidate) &&
			!("task_completed" in candidate) &&
			!("taskCompleted" in candidate) &&
			!("task_completion_reason" in candidate) &&
			!("taskCompletionReason" in candidate)
		) {
			continue;
		}

		const reflection: ReflectionJsonResult = {};
		if ("thought" in candidate && typeof candidate.thought === "string") {
			reflection.thought = candidate.thought;
		}
		if ("facts" in candidate) {
			reflection.facts = candidate.facts as ReflectionJsonResult["facts"];
		}
		if ("relationships" in candidate) {
			reflection.relationships =
				candidate.relationships as ReflectionJsonResult["relationships"];
		}
		if ("task" in candidate && isRecord(candidate.task)) {
			reflection.task = candidate.task as TaskCompletionJson;
		}
		if ("taskCompletion" in candidate && isRecord(candidate.taskCompletion)) {
			reflection.taskCompletion =
				candidate.taskCompletion as TaskCompletionJson;
		}
		if ("task_completed" in candidate) {
			reflection.task_completed =
				candidate.task_completed as ReflectionJsonResult["task_completed"];
		}
		if ("taskCompleted" in candidate) {
			reflection.taskCompleted =
				candidate.taskCompleted as ReflectionJsonResult["taskCompleted"];
		}
		if ("task_completion_reason" in candidate) {
			reflection.task_completion_reason =
				candidate.task_completion_reason as string;
		}
		if ("taskCompletionReason" in candidate) {
			reflection.taskCompletionReason =
				candidate.taskCompletionReason as string;
		}

		return reflection;
	}

	return null;
}

function parseReflectionResponse(response: string): {
	reflection: ReflectionJsonResult | null;
	lookedStructured: boolean;
} {
	const trimmed = response.trim();
	if (!trimmed) {
		return { reflection: null, lookedStructured: false };
	}

	const candidates = new Set<string>([trimmed]);
	const fencedBlocks = trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
	for (const block of fencedBlocks) {
		const candidate = block[1]?.trim();
		if (candidate) {
			candidates.add(candidate);
		}
	}

	const embeddedStructured = extractEmbeddedStructuredDocument(trimmed);
	if (embeddedStructured) {
		candidates.add(embeddedStructured);
	}

	for (const candidate of candidates) {
		const parsedJson = parseJSONObjectFromText(candidate);
		if (parsedJson) {
			const reflection = extractJsonReflectionRecord(parsedJson);
			if (reflection) {
				return { reflection, lookedStructured: true };
			}
		}
	}

	const lookedStructured =
		candidates.size > 1 ||
		trimmed.startsWith("{") ||
		STRUCTURED_FIELD_PATTERN.test(trimmed) ||
		JSON_HEADER_PATTERN.test(trimmed);

	return { reflection: null, lookedStructured };
}

// Schema definitions for the reflection output
const relationshipSchema = z.object({
	sourceEntityId: z.string(),
	targetEntityId: z.string(),
	tags: z.array(z.string()),
	metadata: z
		.object({
			interactions: z.number(),
		})
		.optional(),
});

/**
 * Defines a schema for reflecting on a topic, including facts and relationships.
 * @type {import("zod").object}
 * @property {import("zod").array<import("zod").object<{claim: import("zod").string(), type: import("zod").string(), in_bio: import("zod").boolean(), already_known: import("zod").boolean()}>} facts Array of facts about the topic
 * @property {import("zod").array<import("zod").object>} relationships Array of relationships related to the topic
 */
/**
 * JSDoc comment for reflectionSchema object:
 *
 * Represents a schema for an object containing 'facts' and 'relationships'.
 * 'facts' is an array of objects with properties 'claim', 'type', 'in_bio', and 'already_known'.
 * 'relationships' is an array of objects following the relationshipSchema.
 */

z.object({
	// reflection: z.string(),
	facts: z.array(
		z.object({
			claim: z.string(),
			type: z.string(),
			in_bio: z.boolean(),
			already_known: z.boolean(),
		}),
	),
	relationships: z.array(relationshipSchema),
});

// Use the shared template from prompts
const reflectionTemplate = reflectionEvaluatorTemplate;

/**
 * Resolve an entity name to their UUID
 * @param name - Name to resolve
 * @param entities - List of entities to search through
 * @returns UUID if found, throws error if not found or if input is not a valid UUID
 */
/**
 * Resolves an entity ID by searching through a list of entities.
 *
 * @param {UUID} entityId - The ID of the entity to resolve.
 * @param {Entity[]} entities - The list of entities to search through.
 * @returns {UUID} - The resolved UUID of the entity.
 * @throws {Error} - If the entity ID cannot be resolved to a valid UUID.
 */
function normalizeEntityReference(entityId: string): string {
	const trimmed = entityId.trim();
	const idWrapper = trimmed.match(/^\(id:\s*([^)]+)\)$/i);
	const unwrapped = idWrapper?.[1] ?? trimmed;
	return unwrapped.replace(/^["'`]+|["'`]+$/g, "").trim();
}

function isPlaceholderEntityReference(entityId: string): boolean {
	const normalized = normalizeEntityReference(entityId);
	return (
		normalized.length === 0 ||
		PLACEHOLDER_ENTITY_REFERENCE_PATTERN.test(normalized)
	);
}

function resolveEntity(entityId: string, entities: Entity[]): UUID {
	const normalizedId = normalizeEntityReference(entityId);
	// First try exact UUID match
	if (UUID_PATTERN.test(normalizedId)) {
		return normalizedId as UUID;
	}

	let entity: Entity | undefined;

	// Try to match the entityId exactly
	entity = entities.find((a) => a.id === normalizedId);
	if (entity?.id) {
		return entity.id;
	}

	// Try partial UUID match with entityId
	entity = entities.find((a) => a.id?.includes(normalizedId));
	if (entity?.id) {
		return entity.id;
	}

	// Try name match as last resort
	entity = entities.find((a) =>
		a.names.some((n: string) =>
			n.toLowerCase().includes(normalizedId.toLowerCase()),
		),
	);
	if (entity?.id) {
		return entity.id;
	}

	throw new Error(
		`Could not resolve entityId "${normalizedId}" to a valid UUID`,
	);
}

function isValidUuid(value: string): value is UUID {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		value,
	);
}

function formatActionResults(actionResults: ActionResult[]): string {
	if (actionResults.length === 0) {
		return "No action results available.";
	}

	return actionResults
		.map((result, index) => {
			const actionName =
				typeof result.data?.actionName === "string"
					? result.data.actionName
					: "unknown action";
			const lines = [
				`${index + 1}. ${actionName} - ${result.success === false ? "failed" : "succeeded"}`,
			];
			if (typeof result.text === "string" && result.text.trim()) {
				lines.push(`output: ${result.text.trim().slice(0, 500)}`);
			}
			if (result.error) {
				lines.push(
					`error: ${
						result.error instanceof Error
							? result.error.message.slice(0, 300)
							: String(result.error).slice(0, 300)
					}`,
				);
			}
			return lines.join("\n");
		})
		.join("\n\n");
}

function normalizeTaskCompletion(
	reflection: ReflectionJsonResult,
	messageId?: UUID,
): TaskCompletionAssessment {
	const nestedTask = isRecord(reflection.task)
		? reflection.task
		: isRecord(reflection.taskCompletion)
			? reflection.taskCompletion
			: null;
	const completed =
		parseBooleanLike(reflection.task_completed) ??
		parseBooleanLike(reflection.taskCompleted) ??
		parseBooleanLike(nestedTask?.completed) ??
		false;
	const reasonCandidate =
		typeof reflection.task_completion_reason === "string"
			? reflection.task_completion_reason
			: typeof reflection.taskCompletionReason === "string"
				? reflection.taskCompletionReason
				: typeof nestedTask?.reason === "string"
					? nestedTask.reason
					: "";
	const reason = reasonCandidate.trim();
	const assessed =
		parseBooleanLike(reflection.task_completed) !== null ||
		parseBooleanLike(reflection.taskCompleted) !== null ||
		parseBooleanLike(nestedTask?.completed) !== null ||
		reason.length > 0;

	return {
		assessed,
		completed,
		reason:
			reason ||
			(assessed
				? completed
					? "The task is complete."
					: "The task is not complete yet."
				: "The reflection model did not return a task completion assessment."),
		source: "reflection",
		evaluatedAt: Date.now(),
		messageId,
	};
}

async function storeTaskCompletionReflection(
	runtime: IAgentRuntime,
	message: Memory,
	reflection: ReflectionJsonResult,
	taskCompletion: TaskCompletionAssessment,
): Promise<void> {
	const summaryText = taskCompletion.assessed
		? `Task completion reflection: ${
				taskCompletion.completed ? "completed" : "incomplete"
			}. ${taskCompletion.reason}`
		: `Task completion reflection unavailable. ${taskCompletion.reason}`;

	await runtime.createMemory(
		{
			id: asUUID(v4()),
			entityId: runtime.agentId,
			agentId: runtime.agentId,
			roomId: message.roomId,
			content: {
				text: summaryText,
				type: "task_completion_reflection",
			},
			metadata: {
				type: MemoryType.CUSTOM,
				source: "reflection",
				messageId: message.id,
				taskCompleted: taskCompletion.completed,
				taskAssessed: taskCompletion.assessed,
				taskCompletionReason: taskCompletion.reason,
				reflectionThought:
					typeof reflection.thought === "string" ? reflection.thought : "",
				tags: ["reflection", "task_completion"],
				evaluatedAt: taskCompletion.evaluatedAt,
			},
			createdAt: Date.now(),
		},
		"memories",
	);

	if (message.id) {
		await runtime.setCache<TaskCompletionAssessment>(
			getTaskCompletionCacheKey(message.id),
			taskCompletion,
		);
	}
}

async function handler(
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
): Promise<ActionResult | undefined> {
	const agentId = message.agentId ?? runtime.agentId;
	const { roomId } = message;

	if (!agentId || !roomId) {
		runtime.logger.warn(
			{
				src: "plugin:advanced-capabilities:evaluator:reflection",
				agentId: runtime.agentId,
				message,
			},
			"Missing agentId or roomId in message",
		);
		return undefined;
	}

	const actionResults = message.id ? runtime.getActionResults(message.id) : [];

	// Run all queries in parallel. Facts are owned by `factExtractorEvaluator`
	// now, so we no longer fetch the existing fact list here.
	const [existingRelationships, entities] = await Promise.all([
		runtime.getRelationships({
			entityIds: [message.entityId, agentId],
		}),
		getEntityDetails({ runtime, roomId }),
	]);

	// Strip bloated metadata (indicators arrays grow unbounded over time and
	// blow the prompt past the long-context threshold). Keep only the fields
	// the reflection LLM needs to dedupe relationships: ids, type, tags.
	const slimRelationships = existingRelationships.map((r) => ({
		sourceEntityId: r.sourceEntityId,
		targetEntityId: r.targetEntityId,
		tags: r.tags,
		relationshipType: (r.metadata as { relationshipType?: string } | undefined)
			?.relationshipType,
	}));
	const prompt = composePrompt({
		state: {
			...state?.values,
			actionResults: formatActionResults(actionResults),
			roomType: message.content.channelType as string,
			entitiesInRoom: formatPromptData({ entities }),
			existingRelationships: formatPromptData({
				relationships: slimRelationships,
			}),
			senderId: message.entityId,
		},
		template:
			runtime.character.templates?.reflectionTemplate || reflectionTemplate,
	});

	// Use the model without schema validation
	const response = await runtime.useModel(ModelType.TEXT_SMALL, {
		prompt,
	});

	if (!response) {
		runtime.logger.warn(
			{
				src: "plugin:advanced-capabilities:evaluator:reflection",
				agentId: runtime.agentId,
			},
			"Getting reflection failed - empty response",
		);
		return undefined;
	}

	const { reflection, lookedStructured } = parseReflectionResponse(response);

	if (!reflection) {
		const log = lookedStructured ? runtime.logger.warn : runtime.logger.debug;
		log.call(
			runtime.logger,
			{
				src: "plugin:advanced-capabilities:evaluator:reflection",
				agentId: runtime.agentId,
			},
			lookedStructured
				? "Getting reflection failed - failed to parse structured response"
				: "Skipping reflection - model returned unstructured output",
		);
		return undefined;
	}

	const taskCompletion = normalizeTaskCompletion(
		reflection,
		message.id as UUID | undefined,
	);
	await storeTaskCompletionReflection(
		runtime,
		message,
		reflection,
		taskCompletion,
	);

	// Allow omitted lists when the model has nothing new to add, but still warn
	// on malformed non-empty structures that the normalizer cannot interpret.
	if (!hasValidStructuredList(reflection.facts, "fact", normalizeFactEntries)) {
		runtime.logger.warn(
			{
				src: "plugin:advanced-capabilities:evaluator:reflection",
				agentId: runtime.agentId,
			},
			"Getting reflection failed - invalid facts structure",
		);
		return undefined;
	}

	if (
		!hasValidStructuredList(
			reflection.relationships,
			"relationship",
			normalizeRelationshipEntries,
		)
	) {
		runtime.logger.warn(
			{
				src: "plugin:advanced-capabilities:evaluator:reflection",
				agentId: runtime.agentId,
			},
			"Getting reflection failed - invalid relationships structure",
		);
		return undefined;
	}

	// Fact extraction is handled by `factExtractorEvaluator` now; this
	// evaluator is responsible only for relationships and task completion.

	// Handle relationships - similar structure normalization
	const relationshipsArray = normalizeRelationshipEntries(
		reflection.relationships,
	);

	const relationshipByPair = new Map<
		string,
		(typeof existingRelationships)[number]
	>();
	for (const rel of existingRelationships) {
		relationshipByPair.set(`${rel.sourceEntityId}|${rel.targetEntityId}`, rel);
	}

	// Update or create relationships
	for (const relationship of relationshipsArray) {
		if (!relationship.sourceEntityId || !relationship.targetEntityId) {
			runtime.logger.debug(
				{
					src: "plugin:advanced-capabilities:evaluator:reflection",
					agentId: runtime.agentId,
					relationship,
				},
				"Skipping reflection relationship with missing entity IDs",
			);
			continue;
		}
		if (
			isPlaceholderEntityReference(relationship.sourceEntityId) ||
			isPlaceholderEntityReference(relationship.targetEntityId)
		) {
			runtime.logger.debug(
				{
					src: "plugin:advanced-capabilities:evaluator:reflection",
					agentId: runtime.agentId,
					relationship,
				},
				"Skipping reflection relationship with placeholder entity references",
			);
			continue;
		}

		let sourceId: UUID;
		let target: UUID;

		try {
			sourceId = resolveEntity(relationship.sourceEntityId, entities);
			target = resolveEntity(relationship.targetEntityId, entities);
		} catch (error) {
			runtime.logger.debug(
				{
					src: "plugin:advanced-capabilities:evaluator:reflection",
					agentId: runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
					relationship,
				},
				"Skipping reflection relationship with unresolved entity references",
			);
			continue; // Skip this relationship if we can't resolve the IDs
		}

		if (!isValidUuid(sourceId) || !isValidUuid(target)) {
			runtime.logger.debug(
				{
					src: "plugin:advanced-capabilities:evaluator:reflection",
					agentId: runtime.agentId,
					relationship,
					sourceId,
					target,
				},
				"Skipping reflection relationship with invalid resolved ids",
			);
			continue;
		}

		if (sourceId === target) {
			runtime.logger.debug(
				{
					src: "plugin:advanced-capabilities:evaluator:reflection",
					agentId: runtime.agentId,
					relationship,
					sourceId,
				},
				"Skipping self-referential reflection relationship",
			);
			continue;
		}

		let existingRelationship = relationshipByPair.get(`${sourceId}|${target}`);
		if (!existingRelationship) {
			const candidates = await runtime.getRelationships({
				entityIds: [sourceId],
			});
			existingRelationship = candidates.find(
				(r) => r.targetEntityId === target,
			);
			if (existingRelationship) {
				relationshipByPair.set(`${sourceId}|${target}`, existingRelationship);
			}
		}

		// Parse tags from comma-separated string
		const tags = Array.isArray(relationship.tags)
			? relationship.tags.map((tag) => tag.trim()).filter(Boolean)
			: relationship.tags
				? relationship.tags
						.split(",")
						.map((tag: string) => tag.trim())
						.filter(Boolean)
				: [];

		if (existingRelationship) {
			const updatedMetadata = {
				...existingRelationship.metadata,
				interactions:
					((existingRelationship.metadata?.interactions as
						| number
						| undefined) || 0) + 1,
			};

			const updatedTags = Array.from(
				new Set([...(existingRelationship.tags || []), ...tags]),
			);

			await runtime.updateRelationship({
				...existingRelationship,
				tags: updatedTags,
				metadata: updatedMetadata,
			});
			relationshipByPair.set(`${sourceId}|${target}`, {
				...existingRelationship,
				tags: updatedTags,
				metadata: updatedMetadata,
			});
		} else {
			await runtime.createRelationship({
				sourceEntityId: sourceId,
				targetEntityId: target,
				tags,
				metadata: {
					interactions: 1,
					...relationship.metadata,
				},
			});
		}
	}

	await runtime.setCache<string>(
		`${message.roomId}-reflection-last-processed`,
		message?.id || "",
	);

	return {
		success: true,
		text: formatTaskCompletionStatus(taskCompletion),
		values: {
			taskCompleted: taskCompletion.completed,
			taskCompletionAssessed: taskCompletion.assessed,
			taskCompletionReason: taskCompletion.reason,
		},
		data: {
			taskCompletion,
			relationshipCount: relationshipsArray.length,
		},
	};
}

const reflectionValidate = async (
	runtime: IAgentRuntime,
	message: Memory,
): Promise<boolean> => {
	if (!message.content?.text?.trim()) {
		return false;
	}
	const lastMessageId = await runtime.getCache<string>(
		`${message.roomId}-reflection-last-processed`,
	);
	return lastMessageId !== (message.id ?? "");
};

/**
 * Reflection as an `ALWAYS_AFTER` action. Replaces the legacy evaluator.
 *
 * Migration target: shrink the schema to just experience extraction +
 * 1–10 performance score once relationship updates and fact extraction
 * have been folded into Stage 1.
 */
export const reflectionAction: Action = {
	name: spec.name,
	description: spec.description,
	similes: spec.similes ? [...spec.similes] : [],
	mode: ActionMode.ALWAYS_AFTER,
	modePriority: 100,
	examples: [],
	validate: reflectionValidate as Action["validate"],
	handler: handler as Action["handler"],
};

/**
 * @deprecated Re-exported as an evaluator only so legacy registrations don't
 * break during migration. New code should register `reflectionAction`.
 */
export const reflectionEvaluator: Evaluator = {
	name: spec.name,
	description: spec.description,
	similes: spec.similes ? [...spec.similes] : [],
	alwaysRun: spec.alwaysRun ?? false,
	examples: (spec.examples ?? []) as EvaluationExample[],
	validate: reflectionValidate,
	handler,
};
