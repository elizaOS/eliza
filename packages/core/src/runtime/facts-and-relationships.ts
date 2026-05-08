import type {
	MessageHandlerExtract,
	MessageHandlerExtractedRelationship,
} from "../types/components";
import type { Relationship } from "../types/environment";
import type { Memory } from "../types/memory";
import type { ChatMessage, JSONSchema, ToolDefinition } from "../types/model";
import { ModelType } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import { parseJsonObject } from "./json-output";
import { buildCanonicalSystemPrompt } from "./system-prompt";

/**
 * Stage that runs in parallel with the planner whenever Stage 1
 * (messageHandler) extracts candidate facts or relationships from the user
 * message. It does NOT block the user reply: planner + facts run concurrently.
 *
 * Responsibilities:
 *   1. Vector-search the `facts` table for memories similar to each candidate
 *      so the model can see what's already known.
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

export const FACTS_AND_RELATIONSHIPS_TOOL_NAME =
	"FACTS_AND_RELATIONSHIPS_VALIDATE";

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
- normalize entity names to match the names already used in existing relationships or room entities when possible (do not invent new aliases)
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
	written: { facts: number; relationships: number };
}

export async function runFactsAndRelationshipsStage(
	args: FactsAndRelationshipsRunArgs,
): Promise<FactsAndRelationshipsRunResult> {
	const { runtime, message, extract } = args;
	const candidateFacts = extract.facts ?? [];
	const candidateRelationships = extract.relationships ?? [];
	if (candidateFacts.length === 0 && candidateRelationships.length === 0) {
		return {
			parsed: { facts: [], relationships: [], thought: "no candidates" },
			messages: [],
			tools: [],
			written: { facts: 0, relationships: 0 },
		};
	}

	const [similarFacts, existingRelationships] = await Promise.all([
		searchSimilarFacts(runtime, message, candidateFacts),
		fetchExistingRelationships(runtime, message),
	]);

	const tools = [createFactsAndRelationshipsTool()];
	const messages = buildFactsStageMessages({
		runtime,
		message,
		extract,
		similarFacts,
		existingRelationships,
		priorDialogue: args.priorDialogue ?? [],
		state: args.state,
	});

	const raw = await runtime.useModel(ModelType.TEXT_LARGE, {
		messages,
		tools,
		toolChoice: "required",
	});
	const parsed = parseFactsAndRelationshipsOutput(raw);

	const written = await persistFactsAndRelationships({
		runtime,
		message,
		parsed,
	});

	return { parsed, messages, tools, rawResponse: raw, written };
}

interface BuildMessagesArgs {
	runtime: IAgentRuntime;
	message: Memory;
	extract: MessageHandlerExtract;
	similarFacts: Memory[];
	existingRelationships: Relationship[];
	priorDialogue: readonly Memory[];
	state: State;
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
		.map((memory) => {
			const role = memory.entityId === args.runtime.agentId ? "agent" : "user";
			const text =
				typeof memory.content?.text === "string" ? memory.content.text : "";
			return text ? `${role}: ${text}` : "";
		})
		.filter(Boolean);
	if (dialogueLines.length > 0) {
		userBlocks.push(`recent_conversation:\n${dialogueLines.join("\n")}`);
	}

	const currentText =
		typeof args.message.content?.text === "string"
			? args.message.content.text
			: "";
	if (currentText) {
		userBlocks.push(`current_message:\n${currentText}`);
	}

	if (args.similarFacts.length > 0) {
		const lines = args.similarFacts
			.map((memory) =>
				typeof memory.content?.text === "string" ? memory.content.text : "",
			)
			.filter(Boolean)
			.map((text) => `- ${text}`);
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

	const roomEntities = readRoomEntities(args.state);
	if (roomEntities.length > 0) {
		userBlocks.push(`room_entities:\n${roomEntities.join("\n")}`);
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

function readRoomEntities(state: State): string[] {
	const providers = state.data?.providers;
	if (!providers || typeof providers !== "object") return [];
	const entitiesEntry = (providers as Record<string, unknown>).ENTITIES;
	if (!entitiesEntry || typeof entitiesEntry !== "object") return [];
	const data = (entitiesEntry as { data?: unknown }).data;
	if (!data || typeof data !== "object") return [];
	const entities = (data as { entities?: unknown }).entities;
	if (!Array.isArray(entities)) return [];
	return entities
		.map((entity) => {
			if (!entity || typeof entity !== "object") return "";
			const e = entity as { names?: unknown };
			if (Array.isArray(e.names) && e.names.length > 0) {
				const name = e.names.find((n) => typeof n === "string");
				return typeof name === "string" ? name : "";
			}
			return "";
		})
		.filter((name): name is string => name.length > 0)
		.map((name) => `- ${name}`);
}

function formatRelationshipForPrompt(relationship: Relationship): string {
	const tags = Array.isArray(relationship.tags)
		? relationship.tags.filter((t): t is string => typeof t === "string")
		: [];
	const predicate = tags[0] ?? "related_to";
	const source = String(relationship.sourceEntityId ?? "?");
	const target = String(relationship.targetEntityId ?? "?");
	return `${source} ${predicate} ${target}`;
}

async function searchSimilarFacts(
	runtime: IAgentRuntime,
	message: Memory,
	candidateFacts: readonly string[],
): Promise<Memory[]> {
	if (candidateFacts.length === 0) return [];
	if (typeof runtime.searchMemories !== "function") return [];

	const seed = candidateFacts.join("\n");
	let embedding: number[] | undefined;
	try {
		const result = (await runtime.useModel(ModelType.TEXT_EMBEDDING, {
			text: seed,
		})) as unknown;
		if (Array.isArray(result)) {
			embedding = result as number[];
		}
	} catch {
		return [];
	}
	if (!embedding) return [];

	try {
		const results = await runtime.searchMemories({
			tableName: "facts",
			embedding,
			roomId: message.roomId,
			limit: 8,
		});
		return Array.isArray(results) ? results : [];
	} catch {
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
	} catch {
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
			toolCalls?: Array<{ arguments?: unknown }>;
		};
		if (typeof r.text === "string" && r.text.trim()) return r.text;
		const tool = r.toolCalls?.[0];
		if (tool && typeof tool.arguments === "object" && tool.arguments !== null) {
			return JSON.stringify(tool.arguments);
		}
		if (typeof tool?.arguments === "string") {
			return tool.arguments;
		}
	}
	return "";
}

interface PersistArgs {
	runtime: IAgentRuntime;
	message: Memory;
	parsed: FactsAndRelationshipsResult;
}

async function persistFactsAndRelationships(
	args: PersistArgs,
): Promise<{ facts: number; relationships: number }> {
	const { runtime, message, parsed } = args;
	let factsWritten = 0;
	let relationshipsWritten = 0;

	if (parsed.facts.length > 0 && typeof runtime.createMemory === "function") {
		for (const factText of parsed.facts) {
			try {
				await runtime.createMemory(
					{
						entityId: message.entityId,
						agentId: runtime.agentId,
						roomId: message.roomId,
						content: { text: factText, type: "fact" },
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
			try {
				await runtime.createMemory(
					{
						entityId: message.entityId,
						agentId: runtime.agentId,
						roomId: message.roomId,
						content: {
							text: `${rel.subject} ${rel.predicate} ${rel.object}`,
							type: "relationship",
							subject: rel.subject,
							predicate: rel.predicate,
							object: rel.object,
						},
					} as Memory,
					"facts",
					true,
				);
				relationshipsWritten += 1;
			} catch {
				// best-effort persistence
			}
		}
	}

	return { facts: factsWritten, relationships: relationshipsWritten };
}
