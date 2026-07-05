/**
 * Stage that runs in parallel with the planner whenever Stage 1
 * (messageHandler) extracts candidate facts or relationships from the user
 * message. It does NOT block the user reply: planner + facts run concurrently.
 *
 * Responsibilities:
 *   1. Keyword/BM25-search the `facts` table for memories similar to each
 *      candidate so the model can see what's already known.
 *   2. Pull existing relationships for the user/agent so duplicates can be
 *      filtered.
 *   3. Surface room entities so the model can ground subject/object names.
 *   4. Ask the model which candidates are NEW + WORTH WRITING. The model emits
 *      cleaned text and drops anything that's a near-duplicate of existing
 *      facts/relationships.
 *   5. Persist the kept entries via `runtime.createMemory` (facts table) and
 *      `runtime.createRelationship` (relationships table).
 *
 * The trajectory recorder logs this as a `facts_and_relationships` stage so
 * extraction quality can be reviewed offline.
 */
import { getEntityDetails } from "../entities.ts";
import {
	buildFactKeywordsForStorage,
	scoreFactKeywordRelevance,
} from "../features/advanced-capabilities/fact-keywords.ts";
import { isMobilePlatform } from "../runtime-env";
import type {
	MessageHandlerExtract,
	MessageHandlerExtractedRelationship,
} from "../types/components";
import type { Relationship } from "../types/environment";
import {
	type FactKind,
	type FactVerificationStatus,
	type Memory,
	MemoryType,
} from "../types/memory";
import type { ChatMessage, JSONSchema, ToolDefinition } from "../types/model";
import { ModelType } from "../types/model";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import { isSyntheticConversationArtifactMemory } from "../utils/synthetic-conversation-artifact";
import { parseJsonObject } from "./json-output";
import { buildCanonicalSystemPrompt } from "./system-prompt";

export const FACTS_AND_RELATIONSHIPS_TOOL_NAME =
	"FACTS_AND_RELATIONSHIPS_VALIDATE";

/**
 * Confidence assigned to Stage-1 extracted facts. These are unverified,
 * single-message extractions, so they sit below the reflection pass's
 * confirmed-durable facts (0.7) and match the read-path default for
 * unclassified facts (FACTS provider's DEFAULT_FACT_CONFIDENCE).
 */
const DEFAULT_STAGE_FACT_CONFIDENCE = 0.6;

export const factsAndRelationshipsSchema: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		facts: {
			type: "array",
			items: { type: "string" },
		},
		relationships: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					subject: { type: "string" },
					predicate: { type: "string" },
					object: { type: "string" },
				},
				required: ["subject", "predicate", "object"],
			},
		},
		thought: { type: "string" },
	},
	required: ["facts", "relationships", "thought"],
};

export function createFactsAndRelationshipsTool(): ToolDefinition {
	return {
		name: FACTS_AND_RELATIONSHIPS_TOOL_NAME,
		description:
			"Return ONLY the candidate facts/relationships that are unique and worth persisting. Drop anything already covered by existing facts or relationships.",
		type: "function",
		strict: true,
		parameters: factsAndRelationshipsSchema,
	};
}

export const factsAndRelationshipsInstructions = `task: Validate candidate facts and relationships extracted from the latest user message. Persist only what is genuinely new.

rules:
- drop any candidate that is a paraphrase or trivial restatement of an existing fact or relationship
- drop candidates that are speculative, agent-generated, or not stated by the user
- drop credentials, API keys, passwords, raw tokens, and other secrets; never persist their values
- drop synthetic summaries, compaction artifacts, generic chat filler, and one-off task requests
- normalize entity names to match the names already used in existing relationships or room entities when possible (do not invent new aliases)
- when an entity UUID is shown in room_entities, prefer that UUID for relationship subject/object; otherwise use the canonical display name
- relationships use snake_case predicates ("works_with", "lives_in", "manages")
- if every candidate is a duplicate, return empty arrays
- thought is a one-line internal note about the dedup decision`;

export interface FactsAndRelationshipsResult {
	facts: string[];
	relationships: MessageHandlerExtractedRelationship[];
	thought: string;
}

export interface FactsAndRelationshipsRunArgs {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	extract: MessageHandlerExtract;
	priorDialogue?: readonly Memory[];
}

export interface FactsAndRelationshipsRunResult {
	parsed: FactsAndRelationshipsResult;
	messages: ChatMessage[];
	tools: ToolDefinition[];
	rawResponse?: unknown;
	/**
	 * The provider that actually served THIS facts/relationships TEXT_LARGE call,
	 * captured synchronously right after the call resolved (before any other
	 * TEXT_LARGE call can overwrite the runtime-wide last-resolved-provider).
	 * Carried with the result so the trajectory stage recorder attributes the
	 * facts stage to the real provider instead of a stale shared value or the
	 * fabricated `"default"` literal (#13623).
	 */
	provider?: string;
	written: { facts: number; relationships: number };
}

export async function runFactsAndRelationshipsStage(
	args: FactsAndRelationshipsRunArgs,
): Promise<FactsAndRelationshipsRunResult> {
	const { runtime, message, extract } = args;
	// On mobile (single on-device GPU context, single-threaded agent) the facts
	// stage is another blocking TEXT_LARGE generation that serializes on the
	// same engine as the reply and is awaited before endTrajectory, stalling the
	// next turn. Skip it on android/ios — the on-device knowledge-graph value at
	// the 2B tier doesn't justify the per-turn latency. Desktop/server keep it.
	if (isMobilePlatform()) {
		return {
			parsed: {
				facts: [],
				relationships: [],
				thought: "skipped on mobile",
			},
			messages: [],
			tools: [],
			written: { facts: 0, relationships: 0 },
		};
	}
	if (isSyntheticMemory(message)) {
		return {
			parsed: {
				facts: [],
				relationships: [],
				thought: "synthetic message skipped",
			},
			messages: [],
			tools: [],
			written: { facts: 0, relationships: 0 },
		};
	}

	const candidateFacts = filterCandidateFacts(runtime, extract.facts ?? []);
	const candidateRelationships = filterCandidateRelationships(
		extract.relationships ?? [],
	);
	if (candidateFacts.length === 0 && candidateRelationships.length === 0) {
		return {
			parsed: {
				facts: [],
				relationships: [],
				thought: "no candidates after filtering",
			},
			messages: [],
			tools: [],
			written: { facts: 0, relationships: 0 },
		};
	}

	const candidateEntityNames = candidateRelationships.flatMap((rel) => [
		rel.subject,
		rel.object,
	]);
	const [similarFacts, existingRelationships, roomEntities] = await Promise.all(
		[
			searchSimilarFacts(runtime, message, candidateFacts),
			fetchExistingRelationships(runtime, message),
			fetchRoomEntities(runtime, message, candidateEntityNames),
		],
	);

	const tools = [createFactsAndRelationshipsTool()];
	const messages = buildFactsStageMessages({
		runtime,
		message,
		extract: {
			...extract,
			facts: candidateFacts,
			relationships: candidateRelationships,
		},
		similarFacts,
		existingRelationships,
		roomEntities,
		priorDialogue: args.priorDialogue ?? [],
	});

	const raw = await runtime.useModel(ModelType.TEXT_LARGE, {
		messages,
		tools,
		toolChoice: "required",
	});
	// Capture the provider that served THIS call immediately — reading it later
	// (after the stage completes, in message.ts) could race a parallel/subsequent
	// TEXT_LARGE call that overwrites the runtime-wide last-resolved value (#13623).
	const provider = runtime.getLastResolvedModelProvider?.(ModelType.TEXT_LARGE);
	const parsed = parseFactsAndRelationshipsOutput(raw);

	const written = await persistFactsAndRelationships({
		runtime,
		message,
		roomEntities,
		parsed,
	});

	return { parsed, messages, tools, rawResponse: raw, provider, written };
}

interface BuildMessagesArgs {
	runtime: IAgentRuntime;
	message: Memory;
	extract: MessageHandlerExtract;
	similarFacts: Memory[];
	existingRelationships: Relationship[];
	roomEntities: RoomEntityRef[];
	priorDialogue: readonly Memory[];
}

function buildFactsStageMessages(args: BuildMessagesArgs): ChatMessage[] {
	const systemContent = [
		buildCanonicalSystemPrompt({ character: args.runtime.character }),
		`facts_and_relationships_stage:\n${factsAndRelationshipsInstructions}`,
	]
		.filter(Boolean)
		.join("\n\n");

	const userBlocks: string[] = [];

	const dialogueLines = args.priorDialogue
		.filter((memory) => !isSyntheticMemory(memory))
		.map((memory) => {
			const role = memory.entityId === args.runtime.agentId ? "agent" : "user";
			const text =
				typeof memory.content.text === "string" ? memory.content.text : "";
			return text ? `${role}: ${args.runtime.redactSecrets(text)}` : "";
		})
		.filter(Boolean);
	if (dialogueLines.length > 0) {
		userBlocks.push(`recent_conversation:\n${dialogueLines.join("\n")}`);
	}

	const currentText =
		typeof args.message.content.text === "string"
			? args.message.content.text
			: "";
	if (currentText) {
		userBlocks.push(
			`current_message:\n${args.runtime.redactSecrets(currentText)}`,
		);
	}

	if (args.similarFacts.length > 0) {
		const lines = args.similarFacts
			.map((memory) =>
				typeof memory.content.text === "string" ? memory.content.text : "",
			)
			.filter(Boolean)
			.map((text) => `- ${args.runtime.redactSecrets(text)}`);
		if (lines.length > 0) {
			userBlocks.push(`existing_similar_facts:\n${lines.join("\n")}`);
		}
	}

	if (args.existingRelationships.length > 0) {
		const lines = args.existingRelationships
			.map((rel) => formatRelationshipForPrompt(rel))
			.filter(Boolean)
			.map((text) => `- ${text}`);
		if (lines.length > 0) {
			userBlocks.push(`existing_relationships:\n${lines.join("\n")}`);
		}
	}

	const roomEntityLines = args.roomEntities.map((entity) =>
		formatRoomEntityRef(entity),
	);
	if (roomEntityLines.length > 0) {
		userBlocks.push(`room_entities:\n${roomEntityLines.join("\n")}`);
	}

	const candidateLines: string[] = [];
	for (const fact of args.extract.facts ?? []) {
		candidateLines.push(`- fact: ${fact}`);
	}
	for (const rel of args.extract.relationships ?? []) {
		candidateLines.push(
			`- relationship: ${rel.subject} ${rel.predicate} ${rel.object}`,
		);
	}
	userBlocks.push(`candidates:\n${candidateLines.join("\n")}`);

	return [
		{ role: "system", content: systemContent },
		{ role: "user", content: userBlocks.join("\n\n") },
	];
}

type RoomEntityRef = {
	id?: UUID;
	names: string[];
};

// Hard cap on how many room entities we ground into the validation prompt.
// `getEntityDetails` returns EVERY room participant (it does not apply the
// display cap `formatEntities` uses), so a busy Discord/Slack room could
// otherwise flood the `room_entities:` block with hundreds/thousands of lines
// and blow up TEXT_LARGE latency/context before a single candidate is
// validated. We only need enough to resolve the candidate relationship
// subject/object names to their room UUIDs, so we prioritize name-matched
// participants and fill any remaining slots up to this bound.
const MAX_GROUNDING_ROOM_ENTITIES = 12;

/**
 * Fetch the room's participant entities directly for facts-stage grounding.
 *
 * Previously this scraped the Stage-1 `state.data.providers.ENTITIES` entry,
 * which was doubly broken: (1) it read `data.entities` but the ENTITIES
 * provider publishes its payload under `data.entitiesData`, so the read
 * silently returned `[]` on develop (#13196); and (2) after #13195 deferred the
 * ENTITIES provider off the Stage-1 execution path, the state no longer carries
 * an ENTITIES entry at all, so a key rename alone could not revive it. We now
 * source the entities from the same `getEntityDetails({ runtime, roomId })` the
 * provider itself uses — the authoritative room-participant list — so the
 * grounding (`room_entities:` prompt block + persist-time name->UUID
 * resolution) works regardless of provider execution order. The stage only runs
 * on fact-bearing turns, and getEntityDetails is per-runtime cached, so the
 * added read is bounded; we additionally cap the grounding set (see
 * MAX_GROUNDING_ROOM_ENTITIES) so a large room can't flood the prompt.
 *
 * `candidateNames` are the subject/object strings from the candidate
 * relationships; entities whose names match one of them are prioritized so the
 * bounded set keeps the ones the model actually needs to resolve.
 */
async function fetchRoomEntities(
	runtime: IAgentRuntime,
	message: Memory,
	candidateNames: readonly string[],
): Promise<RoomEntityRef[]> {
	const roomId = message.roomId;
	if (!roomId) return [];
	try {
		const details = await getEntityDetails({ runtime, roomId });
		if (!Array.isArray(details)) return [];
		const refs = details
			.map((entity): RoomEntityRef | null => {
				if (!entity || typeof entity !== "object") return null;
				const names = Array.isArray(entity.names)
					? entity.names.filter(
							(name: unknown): name is string => typeof name === "string",
						)
					: [];
				const id =
					typeof entity.id === "string" ? asUuidOrNull(entity.id) : null;
				if (!id && names.length === 0) return null;
				return { ...(id ? { id } : {}), names };
			})
			.filter((entity): entity is RoomEntityRef => entity !== null);
		return boundGroundingEntities(refs, candidateNames);
	} catch (error) {
		// error-policy:J7 diagnostics-must-not-kill-the-loop — failing to load
		// room entities disables name->UUID grounding for this turn (relationship
		// endpoints fall back to non-room resolution, and the room_entities: block
		// is omitted from the prompt). Degrade to no grounding, but surface the
		// read failure via reportError so a broken getEntityDetails / room-entity
		// pipeline reaches the agent rather than silently disappearing.
		runtime.reportError("FactsAndRelationships.fetchRoomEntities", error, {
			roomId,
		});
		return [];
	}
}

/**
 * Bound the room-entity grounding set to MAX_GROUNDING_ROOM_ENTITIES,
 * prioritizing entities whose names match a candidate relationship
 * subject/object (those are the ones the model needs to resolve to a UUID),
 * then filling any remaining slots with other participants for context. Keeps
 * the `room_entities:` prompt block small in busy rooms without dropping the
 * entities that actually matter for this turn.
 */
function boundGroundingEntities(
	refs: readonly RoomEntityRef[],
	candidateNames: readonly string[],
): RoomEntityRef[] {
	if (refs.length <= MAX_GROUNDING_ROOM_ENTITIES) return [...refs];
	const wanted = new Set(
		candidateNames
			.map((name) => normalizeForComparison(name))
			.filter((name) => name.length > 0),
	);
	const matched: RoomEntityRef[] = [];
	const rest: RoomEntityRef[] = [];
	for (const ref of refs) {
		const isMatch = ref.names.some((name) =>
			wanted.has(normalizeForComparison(name)),
		);
		(isMatch ? matched : rest).push(ref);
	}
	return [...matched, ...rest].slice(0, MAX_GROUNDING_ROOM_ENTITIES);
}

function formatRoomEntityRef(entity: RoomEntityRef): string {
	const names = entity.names.join(", ") || "(unnamed)";
	return entity.id ? `- ${names} (id: ${entity.id})` : `- ${names}`;
}

function formatRelationshipForPrompt(relationship: Relationship): string {
	const tags = Array.isArray(relationship.tags)
		? relationship.tags.filter((t): t is string => typeof t === "string")
		: [];
	const predicate = tags[0] ?? "related_to";
	const source = String(relationship.sourceEntityId);
	const target = String(relationship.targetEntityId);
	return `${source} ${predicate} ${target}`;
}

async function searchSimilarFacts(
	runtime: IAgentRuntime,
	message: Memory,
	candidateFacts: readonly string[],
): Promise<Memory[]> {
	if (candidateFacts.length === 0) return [];
	if (typeof runtime.getMemories !== "function") return [];

	try {
		const results = await runtime.getMemories({
			tableName: "facts",
			roomId: message.roomId,
			count: 80,
			unique: false,
		});
		if (!Array.isArray(results)) return [];
		return scoreFactKeywordRelevance(candidateFacts.join("\n"), results)
			.filter((entry) => entry.relevance > 0)
			.sort((left, right) => right.relevance - left.relevance)
			.slice(0, 8)
			.map((entry) => entry.memory);
	} catch (error) {
		// error-policy:J7 diagnostics-must-not-kill-the-loop — failing to load
		// existing facts disables dedup for this turn (risking duplicate facts),
		// so degrade to no dedup, but surface the read failure via reportError so a
		// broken `getMemories` pipeline reaches the agent, not just the log.
		runtime.reportError("FactsAndRelationships.searchSimilarFacts", error, {
			roomId: message.roomId,
		});
		return [];
	}
}

async function fetchExistingRelationships(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<Relationship[]> {
	if (typeof runtime.getRelationships !== "function") return [];
	const entityIds = [message.entityId, runtime.agentId].filter(
		(id): id is `${string}-${string}-${string}-${string}-${string}` =>
			typeof id === "string" && id.length > 0,
	);
	if (entityIds.length === 0) return [];
	try {
		const results = await runtime.getRelationships({
			entityIds,
			limit: 16,
		});
		return Array.isArray(results) ? results : [];
	} catch (error) {
		// error-policy:J7 diagnostics-must-not-kill-the-loop — failing to load
		// existing relationships disables dedup for this turn (risking duplicate
		// relationships), so degrade to no dedup, but surface the read failure via
		// reportError so a broken `getRelationships` pipeline reaches the agent.
		runtime.reportError(
			"FactsAndRelationships.fetchExistingRelationships",
			error,
			{
				entityIds,
			},
		);
		return [];
	}
}

export function parseFactsAndRelationshipsOutput(
	raw: unknown,
): FactsAndRelationshipsResult {
	const empty: FactsAndRelationshipsResult = {
		facts: [],
		relationships: [],
		thought: "",
	};
	const text = extractText(raw);
	if (!text) return empty;
	const parsed = parseJsonObject<Record<string, unknown>>(text);
	if (!parsed) return empty;

	const facts = Array.isArray(parsed.facts)
		? parsed.facts
				.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
				.filter((entry): entry is string => entry.length > 0)
		: [];
	const relationships = Array.isArray(parsed.relationships)
		? parsed.relationships
				.map((entry): MessageHandlerExtractedRelationship | null => {
					if (!entry || typeof entry !== "object") return null;
					const rel = entry as Record<string, unknown>;
					const subject =
						typeof rel.subject === "string" ? rel.subject.trim() : "";
					const predicate =
						typeof rel.predicate === "string" ? rel.predicate.trim() : "";
					const object =
						typeof rel.object === "string" ? rel.object.trim() : "";
					if (!subject || !predicate || !object) return null;
					return { subject, predicate, object };
				})
				.filter(
					(entry): entry is MessageHandlerExtractedRelationship =>
						entry !== null,
				)
		: [];
	const thought = typeof parsed.thought === "string" ? parsed.thought : "";
	return { facts, relationships, thought };
}

function extractText(raw: unknown): string {
	if (typeof raw === "string") return raw;
	if (raw && typeof raw === "object") {
		const r = raw as {
			text?: unknown;
			toolCalls?: Array<{
				arguments?: unknown;
				args?: unknown;
				input?: unknown;
				params?: unknown;
			}>;
		};
		if (typeof r.text === "string" && r.text.trim()) return r.text;
		const tool = r.toolCalls?.[0];
		// Tool-call args land under different keys across model providers /
		// SDK versions: AI SDK v5 + Cerebras gpt-oss-120b use `input`, older
		// shapes use `arguments`/`args`/`params`. Read all of them or the
		// extracted facts get silently dropped (the validate model returns a
		// proper tool call but `arguments` is undefined -> empty parse ->
		// nothing persisted). Mirrors the accessor in services/message.ts.
		const toolArgs =
			tool?.arguments ?? tool?.args ?? tool?.input ?? tool?.params;
		if (typeof toolArgs === "object" && toolArgs !== null) {
			return JSON.stringify(toolArgs);
		}
		if (typeof toolArgs === "string") {
			return toolArgs;
		}
	}
	return "";
}

interface PersistArgs {
	runtime: IAgentRuntime;
	message: Memory;
	roomEntities: RoomEntityRef[];
	parsed: FactsAndRelationshipsResult;
}

async function persistFactsAndRelationships(
	args: PersistArgs,
): Promise<{ facts: number; relationships: number }> {
	const { runtime, message, parsed } = args;
	const roomEntities = args.roomEntities;
	let factsWritten = 0;
	let relationshipsWritten = 0;

	if (parsed.facts.length > 0 && typeof runtime.createMemory === "function") {
		for (const factText of parsed.facts) {
			const sanitized = sanitizePersistedFact(runtime, factText);
			if (!sanitized) continue;
			const keywords = buildFactKeywordsForStorage(sanitized);
			try {
				await runtime.createMemory(
					{
						entityId: message.entityId,
						agentId: runtime.agentId,
						roomId: message.roomId,
						content: { text: sanitized, type: "fact" },
						metadata: {
							type: MemoryType.CUSTOM,
							source: "facts_and_relationships_stage",
							messageId: message.id,
							tags: ["fact", "extracted", "stage1"],
							keywords,
							extractedAt: Date.now(),
							// Stage-1 extraction is a single-message, unverified pass.
							// Classify as `current` (time-decaying) with default
							// confidence so the read path treats these as transient
							// claims rather than permanent durable identity facts (the
							// reader otherwise defaults missing `kind` to `durable`).
							// The reflection pass promotes confirmed facts to durable.
							kind: "current" as FactKind,
							category: "uncategorized",
							confidence: DEFAULT_STAGE_FACT_CONFIDENCE,
							verificationStatus: "self_reported" as FactVerificationStatus,
							validAt: new Date().toISOString(),
						},
					} as Memory,
					"facts",
					true,
				);
				factsWritten += 1;
			} catch {
				// best-effort persistence — failures land in the trajectory thought.
			}
		}
	}

	if (
		parsed.relationships.length > 0 &&
		typeof runtime.createMemory === "function"
	) {
		for (const rel of parsed.relationships) {
			const normalized = normalizeRelationshipForPersistence(rel);
			if (!normalized) continue;
			const sourceEntityId = resolveRelationshipEntityId(
				normalized.subject,
				roomEntities,
				runtime,
				message,
			);
			const targetEntityId = resolveRelationshipEntityId(
				normalized.object,
				roomEntities,
				runtime,
				message,
			);
			const echoText = `${normalized.subject} ${normalized.predicate} ${normalized.object}`;
			try {
				await runtime.createMemory(
					{
						entityId: message.entityId,
						agentId: runtime.agentId,
						roomId: message.roomId,
						content: {
							text: echoText,
							type: "relationship",
							subject: normalized.subject,
							predicate: normalized.predicate,
							object: normalized.object,
						},
						metadata: {
							type: MemoryType.CUSTOM,
							source: "facts_and_relationships_stage",
							messageId: message.id,
							sourceEntityId,
							targetEntityId,
							tags: ["relationship", "extracted", "stage1"],
							keywords: buildFactKeywordsForStorage(echoText),
							extractedAt: Date.now(),
							// Same stage-1 classification as the fact branch above: this
							// echo lands in the `facts` table, and the reader defaults a
							// missing `kind` to `durable` — an unkinded echo therefore
							// resurfaces as a permanent durable fact (live symptom: the
							// same claim shown twice, once durable, once current).
							kind: "current" as FactKind,
							category: "relationship",
							confidence: DEFAULT_STAGE_FACT_CONFIDENCE,
							verificationStatus: "self_reported" as FactVerificationStatus,
							validAt: new Date().toISOString(),
						},
					} as Memory,
					"facts",
					true,
				);
				if (
					sourceEntityId &&
					targetEntityId &&
					sourceEntityId !== targetEntityId &&
					typeof runtime.createRelationship === "function"
				) {
					await runtime
						.createRelationship({
							sourceEntityId,
							targetEntityId,
							tags: [normalized.predicate],
							metadata: {
								source: "facts_and_relationships_stage",
								messageId: message.id,
								lastInteractionAt: new Date().toISOString(),
							},
						})
						.catch(() => false);
				}
				relationshipsWritten += 1;
			} catch {
				// best-effort persistence
			}
		}
	}

	return { facts: factsWritten, relationships: relationshipsWritten };
}

function filterCandidateFacts(
	runtime: IAgentRuntime,
	facts: readonly string[],
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const fact of facts) {
		const sanitized = sanitizePersistedFact(runtime, fact);
		if (!sanitized || isLowSignalCandidate(sanitized)) continue;
		const key = normalizeForComparison(sanitized);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(sanitized);
	}
	return out.slice(0, 12);
}

function filterCandidateRelationships(
	relationships: readonly MessageHandlerExtractedRelationship[],
): MessageHandlerExtractedRelationship[] {
	const seen = new Set<string>();
	const out: MessageHandlerExtractedRelationship[] = [];
	for (const relationship of relationships) {
		const normalized = normalizeRelationshipForPersistence(relationship);
		if (!normalized) continue;
		const key = normalizeForComparison(
			`${normalized.subject}:${normalized.predicate}:${normalized.object}`,
		);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(normalized);
	}
	return out.slice(0, 12);
}

function normalizeRelationshipForPersistence(
	relationship: MessageHandlerExtractedRelationship,
): MessageHandlerExtractedRelationship | null {
	const subject = cleanText(relationship.subject);
	const object = cleanText(relationship.object);
	const predicate = cleanPredicate(relationship.predicate);
	if (!subject || !object || !predicate) return null;
	if (
		containsSecretSignal(subject) ||
		containsSecretSignal(object) ||
		containsSecretSignal(predicate)
	) {
		return null;
	}
	if (isLowSignalCandidate(subject) || isLowSignalCandidate(object))
		return null;
	return { subject, predicate, object };
}

function sanitizePersistedFact(runtime: IAgentRuntime, value: string): string {
	const cleaned = cleanText(value);
	if (!cleaned) return "";
	if (containsSecretSignal(cleaned)) return "";
	return runtime.redactSecrets(cleaned).trim();
}

function cleanText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function cleanPredicate(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9_ -]/g, "")
		.replace(/[\s-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

function normalizeForComparison(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function containsSecretSignal(value: string): boolean {
	return (
		/\b(?:api[_\s-]?key|secret|password|access[_\s-]?token|refresh[_\s-]?token|private[_\s-]?key)\b/i.test(
			value,
		) ||
		/\b(?:sk|csk|pk|ghp|gho|ghu|ghs|github_pat)-[A-Za-z0-9_-]{16,}\b/.test(
			value,
		)
	);
}

function isLowSignalCandidate(value: string): boolean {
	const normalized = normalizeForComparison(value);
	return (
		normalized.length < 4 ||
		/^(?:by the way|remind me|can you|could you|please|thanks|thank you)\b/.test(
			normalized,
		) ||
		/\b(?:conversation summary|compacted prior planner|compactor|summary mode)\b/.test(
			normalized,
		) ||
		/\b(?:ordinary chat|small talk|chitchat)\b/.test(normalized)
	);
}

function isSyntheticMemory(memory: Memory): boolean {
	return isSyntheticConversationArtifactMemory(memory);
}

function resolveRelationshipEntityId(
	value: string,
	entities: readonly RoomEntityRef[],
	runtime: IAgentRuntime,
	message: Memory,
): UUID | undefined {
	const direct = asUuidOrNull(value);
	if (direct) return direct;
	const normalized = normalizeForComparison(value);
	if (!normalized) return undefined;
	if (
		normalized === "user" ||
		normalized === "current user" ||
		normalized === "sender"
	) {
		return message.entityId;
	}
	if (
		normalized === "agent" ||
		normalized === "assistant" ||
		normalized === normalizeForComparison(runtime.character.name ?? "")
	) {
		return runtime.agentId;
	}
	for (const entity of entities) {
		if (!entity.id) continue;
		for (const name of entity.names) {
			if (normalizeForComparison(name) === normalized) return entity.id;
		}
	}
	return undefined;
}

function asUuidOrNull(value: string): UUID | null {
	if (
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			value,
		)
	) {
		return value as UUID;
	}
	return null;
}
