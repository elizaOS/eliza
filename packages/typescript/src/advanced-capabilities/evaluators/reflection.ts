import { v4 } from "uuid";
import { z } from "zod";
import { getEntityDetails } from "../../entities.ts";
import { requireEvaluatorSpec } from "../../generated/spec-helpers.ts";
import { reflectionEvaluatorTemplate } from "../../prompts.ts";
import type {
	ActionResult,
	Entity,
	EvaluationExample,
	Evaluator,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../types/index.ts";
import { asUUID, ModelType } from "../../types/index.ts";
import { composePrompt, parseKeyValueXml } from "../../utils.ts";

// Get text content from centralized specs
const spec = requireEvaluatorSpec("REFLECTION");

/** Shape of a single fact in the XML response */
interface FactXml {
	claim?: string;
	type?: string;
	in_bio?: string;
	already_known?: string;
}

/** Shape of a single relationship in the XML response */
interface RelationshipXml {
	sourceEntityId?: string;
	targetEntityId?: string;
	tags?: string;
	metadata?: Record<string, unknown>;
}

/** Shape of the reflection XML response */
interface ReflectionXmlResult {
	facts?:
		| {
				fact?: FactXml | FactXml[];
		  }
		| FactXml[];
	relationships?:
		| {
				relationship?: RelationshipXml | RelationshipXml[];
		  }
		| RelationshipXml[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseXmlItems<T>(xml: string, tag: string): T[] {
	const results: T[] = [];
	const openTag = `<${tag}`;
	const closeTag = `</${tag}>`;
	let pos = 0;
	while (pos < xml.length) {
		const start = xml.indexOf(openTag, pos);
		if (start === -1) break;
		const end = xml.indexOf(closeTag, start);
		if (end === -1) break;
		const block = xml.slice(start, end + closeTag.length);
		const parsed = parseKeyValueXml<T>(block);
		if (parsed && isRecord(parsed)) results.push(parsed);
		pos = end + closeTag.length;
	}
	return results;
}

function normalizeFactEntries(value: unknown): FactXml[] {
	if (Array.isArray(value)) {
		return value.filter(isRecord) as FactXml[];
	}

	if (isRecord(value) && "fact" in value) {
		return normalizeFactEntries(value.fact);
	}

	if (typeof value === "string" && value.includes("<fact")) {
		return parseXmlItems<FactXml>(value, "fact");
	}

	return isRecord(value) ? [value as FactXml] : [];
}

function normalizeRelationshipEntries(value: unknown): RelationshipXml[] {
	if (Array.isArray(value)) {
		return value.filter(isRecord) as RelationshipXml[];
	}

	if (isRecord(value) && "relationship" in value) {
		return normalizeRelationshipEntries(value.relationship);
	}

	if (typeof value === "string" && value.includes("<relationship")) {
		return parseXmlItems<RelationshipXml>(value, "relationship");
	}

	return isRecord(value) ? [value as RelationshipXml] : [];
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

function isFalseLike(value: unknown): boolean {
	return value === false || value === "false";
}

// Best-effort guardrail for long-term memory: even if the model emits a fact,
// do not store obviously transient session/debug/status chatter.
const TEMPORARY_REFLECTION_FACT_PATTERNS = [
	/\b(today|tonight|tomorrow|yesterday|just now|right now|at the moment|this (morning|afternoon|evening|week|month|session|conversation|run|turn))\b/,
	/\b(currently|current|actively)\b.{0,24}\b(debugging|fixing|investigating|testing|triaging|iterating|working|trying)\b/,
	/\b(debugging|fixing|investigating|testing|triaging|iterating|working on|trying out|switching)\b.{0,24}\b(issue|bug|glitch|reply|response|route|settings?|api|status)\b/,
	/\b(stalled|blocked)\b.{0,24}\b(reply|response|chat|route|issue)\b/,
	/\b(thinks?|thought)\b.{0,24}\b(fixed|solved|working)\b/,
	/\bin one session\b/,
	/\b(appreciates?|praised?|complimented?|thanked)\b.{0,32}\b(attitude|tone|energy|vibe|style)\b/,
] as const;

function isDurableReflectionFactClaim(claim: string): boolean {
	const normalized = claim.trim().toLowerCase();
	if (!normalized) {
		return false;
	}

	return !TEMPORARY_REFLECTION_FACT_PATTERNS.some((pattern) =>
		pattern.test(normalized),
	);
}

const TOON_HEADER_PATTERN = /^TOON(?:\s+DOCUMENT)?[:\s-]*$/i;
const TOON_FIELD_PATTERN =
	/^[A-Za-z_][A-Za-z0-9_.-]*(?:\[[^\]\n]*\])?(?:\{[^\n]*\})?:/;

function extractEmbeddedToonDocument(text: string): string | null {
	const lines = text.trim().split(/\r?\n/);
	const startIndex = lines.findIndex((line) => {
		const trimmed = line.trim();
		return (
			TOON_HEADER_PATTERN.test(trimmed) || TOON_FIELD_PATTERN.test(trimmed)
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
		const isStructuredField = TOON_FIELD_PATTERN.test(trimmed);
		const isIndented = /^[\t ]+/.test(line);
		const isHeader = TOON_HEADER_PATTERN.test(trimmed);

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

function parseReflectionResponse(response: string): {
	reflection: ReflectionXmlResult | null;
	lookedStructured: boolean;
} {
	const trimmed = response.trim();
	if (!trimmed) {
		return { reflection: null, lookedStructured: false };
	}

	const candidates = new Set<string>([trimmed]);
	const fencedBlocks = trimmed.matchAll(
		/```(?:toon|xml|json)?\s*([\s\S]*?)\s*```/gi,
	);
	for (const block of fencedBlocks) {
		const candidate = block[1]?.trim();
		if (candidate) {
			candidates.add(candidate);
		}
	}

	const embeddedToon = extractEmbeddedToonDocument(trimmed);
	if (embeddedToon) {
		candidates.add(embeddedToon);
	}

	for (const candidate of candidates) {
		const parsed = parseKeyValueXml<ReflectionXmlResult>(candidate);
		if (parsed) {
			return { reflection: parsed, lookedStructured: true };
		}
	}

	const lookedStructured =
		candidates.size > 1 ||
		trimmed.includes("<response>") ||
		trimmed.includes("</response>") ||
		TOON_FIELD_PATTERN.test(trimmed) ||
		TOON_HEADER_PATTERN.test(trimmed);

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
function resolveEntity(entityId: string, entities: Entity[]): UUID {
	// First try exact UUID match
	if (
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			entityId,
		)
	) {
		return entityId as UUID;
	}

	let entity: Entity | undefined;

	// Try to match the entityId exactly
	entity = entities.find((a) => a.id === entityId);
	if (entity?.id) {
		return entity.id;
	}

	// Try partial UUID match with entityId
	entity = entities.find((a) => a.id?.includes(entityId));
	if (entity?.id) {
		return entity.id;
	}

	// Try name match as last resort
	entity = entities.find((a) =>
		a.names.some((n: string) =>
			n.toLowerCase().includes(entityId.toLowerCase()),
		),
	);
	if (entity?.id) {
		return entity.id;
	}

	throw new Error(`Could not resolve entityId "${entityId}" to a valid UUID`);
}
async function handler(
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
): Promise<ActionResult | undefined> {
	const { agentId, roomId } = message;

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

	// Run all queries in parallel
	const [existingRelationships, entities, knownFacts] = await Promise.all([
		runtime.getRelationships({
			entityIds: [message.entityId],
		}),
		getEntityDetails({ runtime, roomId }),
		runtime.getMemories({
			tableName: "facts",
			roomId,
			count: 30,
			unique: true,
		}),
	]);

	const prompt = composePrompt({
		state: {
			...(state?.values || {}),
			knownFacts: formatFacts(knownFacts),
			roomType: message.content.channelType as string,
			entitiesInRoom: JSON.stringify(entities),
			existingRelationships: JSON.stringify(existingRelationships),
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

	// Handle facts - parseKeyValueXml returns nested structures differently
	// Facts might be a single object or an array depending on the count
	const factsArray = normalizeFactEntries(reflection.facts);

	// Store new facts - filter for valid new facts with claim text
	const newFacts = factsArray.filter(
		(fact): fact is FactXml & { claim: string } =>
			fact != null &&
			isFalseLike(fact.already_known) &&
			isFalseLike(fact.in_bio) &&
			typeof fact.claim === "string" &&
			fact.claim.trim() !== "" &&
			isDurableReflectionFactClaim(fact.claim),
	);

	if (factsArray.length > newFacts.length) {
		runtime.logger.debug(
			{
				src: "plugin:advanced-capabilities:evaluator:reflection",
				agentId: runtime.agentId,
				discardedFacts: factsArray.length - newFacts.length,
			},
			"Skipping non-durable reflection facts",
		);
	}

	await Promise.all(
		newFacts.map(async (fact) => {
			const factMemory = {
				id: asUUID(v4()),
				entityId: agentId,
				agentId,
				content: { text: fact.claim },
				roomId,
				createdAt: Date.now(),
			};
			// Create memory first and capture the returned ID
			const createdMemoryId = await runtime.createMemory(
				factMemory,
				"facts",
				true,
			);
			// Update the memory object with the actual ID from the database
			const createdMemory = { ...factMemory, id: createdMemoryId };
			// Queue embedding generation asynchronously for the memory with correct ID
			await runtime.queueEmbeddingGeneration(createdMemory, "low");
			return createdMemory;
		}),
	);

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
			console.warn(
				"Skipping relationship with missing entity IDs:",
				relationship,
			);
			continue;
		}

		let sourceId: UUID;
		let target: UUID;

		try {
			sourceId = resolveEntity(relationship.sourceEntityId, entities);
			target = resolveEntity(relationship.targetEntityId, entities);
		} catch (error) {
			console.warn("Failed to resolve relationship entities:", error);
			console.warn("relationship:\n", relationship);
			continue; // Skip this relationship if we can't resolve the IDs
		}

		const existingRelationship = relationshipByPair.get(
			`${sourceId}|${target}`,
		);

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
		} else {
			await runtime.createRelationship({
				sourceEntityId: sourceId,
				targetEntityId: target,
				tags,
				metadata: {
					interactions: 1,
					...(relationship.metadata || {}),
				},
			});
		}
	}

	await runtime.setCache<string>(
		`${message.roomId}-reflection-last-processed`,
		message?.id || "",
	);
}

export const reflectionEvaluator: Evaluator = {
	name: spec.name,
	description: spec.description,
	similes: spec.similes ? [...spec.similes] : [],
	alwaysRun: spec.alwaysRun ?? false,
	examples: (spec.examples ?? []) as EvaluationExample[],
	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		const lastMessageId = await runtime.getCache<string>(
			`${message.roomId}-reflection-last-processed`,
		);
		const messages = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			count: runtime.getConversationLength(),
		});

		let remainingCount = messages.length;
		if (lastMessageId) {
			const lastMessageIndex = messages.findIndex(
				(msg) => msg.id === lastMessageId,
			);
			if (lastMessageIndex !== -1) {
				remainingCount = messages.length - (lastMessageIndex + 1);
			}
		}

		const reflectionInterval = Math.ceil(runtime.getConversationLength() / 4);

		return remainingCount > reflectionInterval;
	},
	handler,
};

// Helper function to format facts for context
function formatFacts(facts: Memory[]) {
	const result: string[] = [];
	for (let i = facts.length - 1; i >= 0; i -= 1) {
		result.push(facts[i]?.content.text ?? "");
	}
	return result.join("\n");
}
