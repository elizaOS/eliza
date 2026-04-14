import { v4 } from "uuid";
import YAML from "yaml";
import z from "zod";
import { getEntityDetails } from "../../../entities.ts";
import { reflectionEvaluatorTemplate } from "../../../prompts.ts";
import type {
	ActionResult,
	Entity,
	Evaluator,
	IAgentRuntime,
	Memory,
	State,
	TextGenerationModelType,
	UUID,
} from "../../../types/index.ts";
import { asUUID, ModelType } from "../../../types/index.ts";
import {
	composePrompt,
	parseJSONObjectFromText,
	parseKeyValueXml,
} from "../../../utils.ts";

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

const TEXT_GENERATION_MODEL_TYPES = new Set<TextGenerationModelType>([
	ModelType.TEXT_NANO,
	ModelType.TEXT_SMALL,
	ModelType.TEXT_MEDIUM,
	ModelType.TEXT_LARGE,
	ModelType.TEXT_MEGA,
	ModelType.RESPONSE_HANDLER,
	ModelType.ACTION_PLANNER,
	ModelType.TEXT_REASONING_SMALL,
	ModelType.TEXT_REASONING_LARGE,
	ModelType.TEXT_COMPLETION,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveConfiguredTextGenerationModelType(
	value: string | boolean | number | null,
): TextGenerationModelType | null {
	if (typeof value !== "string") {
		return null;
	}

	const normalized = value.trim() as TextGenerationModelType;
	return TEXT_GENERATION_MODEL_TYPES.has(normalized) ? normalized : null;
}

export function resolveReflectionModelType(
	runtime: IAgentRuntime,
): TextGenerationModelType {
	return (
		resolveConfiguredTextGenerationModelType(
			runtime.getSetting("MEMORY_REFLECTION_MODEL_TYPE") ??
				runtime.getSetting("REFLECTION_MODEL_TYPE") ??
				runtime.getSetting("MEMORY_MODEL_TYPE"),
		) ?? ModelType.TEXT_SMALL
	);
}

function normalizeStructuredScalarList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((entry) => normalizeStructuredScalarList(entry));
	}

	if (typeof value === "string") {
		const normalized = value.trim();
		return normalized ? [normalized] : [];
	}

	if (!isRecord(value)) {
		return [];
	}

	const dashEntries = Object.entries(value).filter(([key]) =>
		/^\s*-\s*/.test(key),
	);
	if (dashEntries.length > 0) {
		return dashEntries.flatMap(([, entryValue]) =>
			normalizeStructuredScalarList(entryValue),
		);
	}

	return Object.values(value).flatMap((entryValue) =>
		normalizeStructuredScalarList(entryValue),
	);
}

function sanitizeStructuredRecord(
	value: Record<string, unknown>,
): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};

	for (const [rawKey, rawValue] of Object.entries(value)) {
		const key = rawKey.replace(/^\s*-\s*/, "").trim();
		if (!key) {
			continue;
		}

		let nextValue: unknown = rawValue;
		if (Array.isArray(rawValue)) {
			nextValue = rawValue.map((entry) =>
				isRecord(entry) ? sanitizeStructuredRecord(entry) : entry,
			);
		} else if (isRecord(rawValue)) {
			nextValue = sanitizeStructuredRecord(rawValue);
		}

		if (key === "tags") {
			sanitized[key] = normalizeStructuredScalarList(rawValue);
			continue;
		}

		sanitized[key] = nextValue;
	}

	return sanitized;
}

function normalizeFactEntries(value: unknown): FactXml[] {
	if (Array.isArray(value)) {
		return value
			.filter(isRecord)
			.map((entry) => sanitizeStructuredRecord(entry) as FactXml);
	}

	if (isRecord(value) && "fact" in value) {
		return normalizeFactEntries(value.fact);
	}

	return isRecord(value) ? [sanitizeStructuredRecord(value) as FactXml] : [];
}

function normalizeRelationshipEntries(value: unknown): RelationshipXml[] {
	if (Array.isArray(value)) {
		return value
			.filter(isRecord)
			.map((entry) => sanitizeStructuredRecord(entry) as RelationshipXml);
	}

	if (isRecord(value) && "relationship" in value) {
		return normalizeRelationshipEntries(value.relationship);
	}

	return isRecord(value)
		? [sanitizeStructuredRecord(value) as RelationshipXml]
		: [];
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

function hasValidReflectionStructure(reflection: ReflectionXmlResult): boolean {
	return (
		hasValidStructuredList(reflection.facts, "fact", normalizeFactEntries) &&
		hasValidStructuredList(
			reflection.relationships,
			"relationship",
			normalizeRelationshipEntries,
		)
	);
}

function normalizeReflectionStructure(
	reflection: ReflectionXmlResult,
): ReflectionXmlResult {
	const normalized: ReflectionXmlResult = {};
	if (reflection.facts !== undefined) {
		normalized.facts = normalizeFactEntries(reflection.facts);
	}
	if (reflection.relationships !== undefined) {
		normalized.relationships = normalizeRelationshipEntries(
			reflection.relationships,
		);
	}
	return normalized;
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

function extractJsonReflectionRecord(
	value: Record<string, unknown>,
): ReflectionXmlResult | null {
	const candidates = [
		value,
		isRecord(value.response) ? value.response : null,
		isRecord(value.reflection) ? value.reflection : null,
	].filter(
		(candidate): candidate is Record<string, unknown> => candidate != null,
	);

	for (const candidate of candidates) {
		if (!("facts" in candidate) && !("relationships" in candidate)) {
			continue;
		}

		const reflection: ReflectionXmlResult = {};
		if ("facts" in candidate) {
			reflection.facts = candidate.facts as ReflectionXmlResult["facts"];
		}
		if ("relationships" in candidate) {
			reflection.relationships =
				candidate.relationships as ReflectionXmlResult["relationships"];
		}

		return reflection;
	}

	return null;
}

/** @internal Exported for tests. */
export function parseReflectionResponse(response: string): {
	reflection: ReflectionXmlResult | null;
	lookedStructured: boolean;
} {
	const trimmed = response.trim();
	if (!trimmed) {
		return { reflection: null, lookedStructured: false };
	}

	const candidates = new Set<string>([trimmed]);
	const fencedBlocks = trimmed.matchAll(
		/```(?:toon|xml|json|yaml|yml)?\s*([\s\S]*?)\s*```/gi,
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
		const parsedJson = parseJSONObjectFromText(candidate);
		if (parsedJson) {
			const reflection = extractJsonReflectionRecord(parsedJson);
			if (reflection) {
				return {
					reflection: normalizeReflectionStructure(reflection),
					lookedStructured: true,
				};
			}
		}

		try {
			const parsedYaml = YAML.parse(candidate) as unknown;
			if (isRecord(parsedYaml)) {
				const reflection = extractJsonReflectionRecord(parsedYaml);
				if (reflection) {
					return {
						reflection: normalizeReflectionStructure(reflection),
						lookedStructured: true,
					};
				}
			}
		} catch {
			// Ignore invalid YAML and continue scanning other structured candidates.
		}

		const parsed = parseKeyValueXml<ReflectionXmlResult>(candidate);
		if (parsed) {
			const normalized = normalizeReflectionStructure(parsed);
			if (hasValidReflectionStructure(normalized)) {
				return { reflection: normalized, lookedStructured: true };
			}
		}
	}

	const lookedStructured =
		candidates.size > 1 ||
		trimmed.includes("<response>") ||
		trimmed.includes("</response>") ||
		trimmed.startsWith("{") ||
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
	const agentId = message.agentId ?? runtime.agentId;
	const { roomId } = message;

	if (!agentId || !roomId) {
		runtime.logger.warn(
			{
				src: "plugin:core:evaluator:reflection",
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
	const response = await runtime.useModel(resolveReflectionModelType(runtime), {
		prompt,
	});

	if (!response) {
		runtime.logger.warn(
			{
				src: "plugin:core:evaluator:reflection",
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
				src: "plugin:core:evaluator:reflection",
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
				src: "plugin:core:evaluator:reflection",
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
				src: "plugin:core:evaluator:reflection",
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
				src: "plugin:core:evaluator:reflection",
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

		const existingRelationship = existingRelationships.find((r) => {
			return r.sourceEntityId === sourceId && r.targetEntityId === target;
		});

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
	name: "REFLECTION",
	similes: [
		"REFLECT",
		"SELF_REFLECT",
		"EVALUATE_INTERACTION",
		"ASSESS_SITUATION",
	],
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

		if (lastMessageId) {
			const lastMessageIndex = messages.findIndex(
				(msg) => msg.id === lastMessageId,
			);
			if (lastMessageIndex !== -1) {
				messages.splice(0, lastMessageIndex + 1);
			}
		}

		const reflectionInterval = Math.ceil(runtime.getConversationLength() / 4);

		return messages.length > reflectionInterval;
	},
	description:
		"Generate a self-reflective thought on the conversation, then extract facts and relationships between entities in the conversation.",
	handler,
	examples: [
		{
			prompt: `Agent Name: Sarah
Agent Role: Community Manager
Room Type: group
Current Room: general-chat
Message Sender: John (user-123)`,
			messages: [
				{
					name: "John",
					content: { text: "Hey everyone, I'm new here!" },
				},
				{
					name: "Sarah",
					content: { text: "Welcome John! How did you find our community?" },
				},
				{
					name: "John",
					content: { text: "Through a friend who's really into AI" },
				},
			],
			outcome: `thought: "I'm engaging appropriately with a new community member, maintaining a welcoming and professional tone. My questions are helping to learn more about John and make him feel welcome."
facts[0]:
  claim: John is new to the community
  type: fact
  in_bio: false
  already_known: false
facts[1]:
  claim: John found the community through a friend interested in AI
  type: fact
  in_bio: false
  already_known: false
relationships[0]:
  sourceEntityId: sarah-agent
  targetEntityId: user-123
  tags[0]: group_interaction
relationships[1]:
  sourceEntityId: user-123
  targetEntityId: sarah-agent
  tags[0]: group_interaction`,
		},
		{
			prompt: `Agent Name: Alex
Agent Role: Tech Support
Room Type: group
Current Room: tech-help
Message Sender: Emma (user-456)`,
			messages: [
				{
					name: "Emma",
					content: { text: "My app keeps crashing when I try to upload files" },
				},
				{
					name: "Alex",
					content: { text: "Have you tried clearing your cache?" },
				},
				{
					name: "Emma",
					content: { text: "No response..." },
				},
				{
					name: "Alex",
					content: {
						text: "Emma, are you still there? We can try some other troubleshooting steps.",
					},
				},
			],
			outcome: `thought: "I'm not sure if I'm being helpful or if Emma is frustrated with my suggestions. The lack of response is concerning - maybe I should have asked for more details about the issue first before jumping to solutions."
facts[0]:
  claim: Emma is having technical issues with file uploads
  type: fact
  in_bio: false
  already_known: false
facts[1]:
  claim: Emma stopped responding after the first troubleshooting suggestion
  type: fact
  in_bio: false
  already_known: false
relationships[0]:
  sourceEntityId: alex-agent
  targetEntityId: user-456
  tags[0]: group_interaction
  tags[1]: support_interaction
  tags[2]: incomplete_interaction`,
		},
		{
			prompt: `Agent Name: Max
Agent Role: Discussion Facilitator 
Room Type: group
Current Room: book-club
Message Sender: Lisa (user-789)`,
			messages: [
				{
					name: "Lisa",
					content: { text: "What did everyone think about chapter 5?" },
				},
				{
					name: "Max",
					content: {
						text: "The symbolism was fascinating! The red door clearly represents danger.",
					},
				},
				{
					name: "Max",
					content: {
						text: "And did anyone notice how the author used weather to reflect the protagonist's mood?",
					},
				},
				{
					name: "Max",
					content: {
						text: "Plus the foreshadowing in the first paragraph was brilliant!",
					},
				},
				{
					name: "Max",
					content: {
						text: "I also have thoughts about the character development...",
					},
				},
			],
			outcome: `thought: "I'm dominating the conversation and not giving others a chance to share their perspectives. I've sent multiple messages in a row without waiting for responses. I need to step back and create space for other members to participate."
facts[0]:
  claim: The discussion is about chapter 5 of a book
  type: fact
  in_bio: false
  already_known: false
facts[1]:
  claim: Max has sent 4 consecutive messages without user responses
  type: fact
  in_bio: false
  already_known: false
relationships[0]:
  sourceEntityId: max-agent
  targetEntityId: user-789
  tags[0]: group_interaction
  tags[1]: excessive_interaction`,
		},
	],
};

// Helper function to format facts for context
function formatFacts(facts: Memory[]) {
	return facts
		.reverse()
		.map((fact: Memory) => fact.content.text)
		.join("\n");
}
