/**
 * FactExtractorEvaluator
 *
 * Single-call replacement for the legacy two-pass pipeline (reflection
 * fact-extraction half + `factRefinement.ts`). For each new user message:
 *
 *   1. Embed the message text.
 *   2. Pull a wider similarity pool from the `facts` table and partition into
 *      `durable` and `current` lists in TS (the runtime search API does not
 *      filter on metadata).
 *   3. One LLM call (OBJECT_SMALL, temp=0) emits a JSON `ops` array validated
 *      by `ExtractorOutputSchema`. Legacy JSON responses are still accepted.
 *   4. Write-time embedding-similarity dedup upgrades near-duplicate
 *      `add_*` ops to `strengthen` against the closest existing fact in the
 *      same `kind` + `category`.
 *   5. Apply ops: insert/strengthen/decay against `facts`, queue
 *      contradictions to `fact_candidates` for human review.
 *
 * See `docs/architecture/fact-memory.md` for the design.
 */

import { v4 } from "uuid";
import type {
	ActionResult,
	Evaluator,
	IAgentRuntime,
	Memory,
	MemoryMetadata,
	State,
	UUID,
} from "../../../types/index.ts";
import { ModelType } from "../../../types/index.ts";
import type {
	CurrentFactCategory,
	CustomMetadata,
	DurableFactCategory,
	FactKind,
	FactMetadata,
	FactVerificationStatus,
} from "../../../types/memory.ts";
import { MemoryType } from "../../../types/memory.ts";
import { asUUID, type JsonValue } from "../../../types/primitives.ts";
import { composePrompt } from "../../../utils.ts";
import { recordFactCandidate } from "./_factCandidates.ts";
import {
	type AddCurrentOp,
	type AddDurableOp,
	type ContradictOp,
	type DecayOp,
	type ExtractorOp,
	ExtractorOutputSchema,
	type StrengthenOp,
} from "./factExtractor.schema.ts";

const MAX_KNOWN_PER_KIND = 15;
const CANDIDATE_POOL_SIZE = 30;
const STRENGTHEN_DELTA = 0.1;
const DECAY_DELTA = 0.15;
const FACT_DECAY_FLOOR = 0.2;
const NEW_FACT_CONFIDENCE = 0.7;
const DEDUP_SIMILARITY_THRESHOLD = 0.92;

const FACT_EXTRACTION_SCHEMA = {
	type: "object",
	properties: {
		ops: {
			type: "array",
			items: {
				type: "object",
				properties: {
					op: {
						type: "string",
						enum: [
							"add_durable",
							"add_current",
							"strengthen",
							"decay",
							"contradict",
						],
					},
					claim: { type: "string" },
					category: { type: "string" },
					structured_fields: { type: "object" },
					verification_status: { type: "string" },
					valid_at: { type: "string" },
					factId: { type: "string" },
					reason: { type: "string" },
					proposedText: { type: "string" },
				},
				required: ["op"],
			},
		},
	},
	required: ["ops"],
};

const FACT_EXTRACTION_JSON_TEMPLATE = `# Task: Classify and extract facts from this message

You maintain two fact stores for an AI assistant. Decide what to insert, strengthen, decay, or contradict. Return a JSON object matching the provided schema.

Stores:
- durable: stable identity-level claims that matter in a year.
  Categories: identity, health, relationship, life_event, business_role, preference, goal.
- current: time-bound state about right now or the near term.
  Categories: feeling, physical_state, working_on, going_through, schedule_context.

Rules:
- If a claim feels stale or surprising to retrieve in a year, use current.
- Empty output is right for small talk or questions with no new claim.
- Before add_durable/add_current, scan known facts. If meaning already exists, emit strengthen with that factId.
- Paraphrases count as duplicates. Match meaning, not surface form.

Ops:
- add_durable: claim, category, structured_fields; optional verification_status, reason.
- add_current: claim, category, structured_fields; optional valid_at, reason.
- strengthen: factId, optional reason.
- decay: factId, optional reason.
- contradict: factId, reason, optional proposedText.

Examples:

Message: "I have a flat cortisol curve confirmed via lab"
{
  "ops": [
    {
      "op": "add_durable",
      "claim": "flat cortisol curve",
      "category": "health",
      "structured_fields": { "condition": "flat cortisol curve", "source": "lab" },
      "verification_status": "confirmed"
    }
  ]
}

Message: "I'm anxious this morning"
{
  "ops": [
    {
      "op": "add_current",
      "claim": "anxious this morning",
      "category": "feeling",
      "structured_fields": { "emotion": "anxious", "window": "morning" }
    }
  ]
}

Known durable facts include: [fact_abc] (durable.identity) lives in Berlin
Message: "Berlin's been treating me well"
{ "ops": [{ "op": "strengthen", "factId": "fact_abc", "reason": "user reaffirmed living in Berlin" }] }

Known durable facts include: [fact_abc] (durable.identity) lives in Berlin
Message: "Actually I moved to Tokyo last month"
{
  "ops": [
    { "op": "contradict", "factId": "fact_abc", "proposedText": "lives in Tokyo", "reason": "user moved to Tokyo, contradicts Berlin" },
    { "op": "add_durable", "claim": "moved to Tokyo last month", "category": "life_event", "structured_fields": { "event": "relocation", "to": "Tokyo" } }
  ]
}

Inputs:
Agent Name: {{agentName}}
Message Sender: {{senderName}} (ID: {{senderId}})
Now: {{now}}

Recent messages:
{{recentMessages}}

Known durable facts (format: [factId] (durable.category) claim):
{{knownDurable}}

Known current facts (format: [factId] (current.category, since validAt) claim):
{{knownCurrent}}

Latest message:
{{message}}

Output:
Return exactly one JSON object. No prose, no fences, no XML, no <think>.
If nothing should change, return:
{ "ops": [] }`;

function nowIso(): string {
	return new Date().toISOString();
}

/**
 * Coerce an unknown-typed record into a JSON-safe object shape.
 *
 * The LLM emits `structured_fields` as `Record<string, unknown>` (zod's
 * `z.record(z.string(), z.unknown())`), but `FactMetadata` and the wider
 * `MemoryMetadata` index signature require values that fit `MetadataValue`
 * (which is JSON-serializable). A round-trip through JSON drops anything
 * non-serializable and gives us a value the type checker accepts.
 */
type JsonObject = { [key: string]: JsonValue };

function toJsonObject(value: Record<string, unknown>): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function cosineSimilarity(a: number[], b: number[]): number {
	if (!a.length || !b.length) return 0;
	const len = Math.min(a.length, b.length);
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < len; i += 1) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function readFactMetadata(memory: Memory): FactMetadata {
	const meta = memory.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	return meta as FactMetadata;
}

function pickFactConfidence(memory: Memory): number {
	const value = readFactMetadata(memory).confidence;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return NEW_FACT_CONFIDENCE;
}

/**
 * Resolve a fact's kind. Legacy facts written before the two-store model
 * carry no `kind` metadata; treat them as durable per the lazy
 * reclassification policy in `fact-memory.md`.
 */
function readFactKind(memory: Memory): FactKind {
	const kind = readFactMetadata(memory).kind;
	if (kind === "current") return "current";
	return "durable";
}

function readCategory(memory: Memory): string {
	const category = readFactMetadata(memory).category;
	if (typeof category === "string" && category.length > 0) return category;
	return "uncategorized";
}

function readEffectiveValidAt(memory: Memory): string | null {
	const validAt = readFactMetadata(memory).validAt;
	if (typeof validAt === "string" && validAt.length > 0) return validAt;
	if (
		typeof memory.createdAt === "number" &&
		Number.isFinite(memory.createdAt)
	) {
		return new Date(memory.createdAt).toISOString();
	}
	return null;
}

function partitionByKind(memories: Memory[]): {
	durable: Memory[];
	current: Memory[];
} {
	const durable: Memory[] = [];
	const current: Memory[] = [];
	for (const memory of memories) {
		if (readFactKind(memory) === "current") current.push(memory);
		else durable.push(memory);
	}
	return { durable, current };
}

function dedupeById(memories: Memory[]): Memory[] {
	const seen = new Set<string>();
	const out: Memory[] = [];
	for (const memory of memories) {
		const id = memory.id ?? "";
		if (!id) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(memory);
	}
	return out;
}

function formatKnownDurableLine(memory: Memory): string {
	const id = memory.id ?? "";
	const text = memory.content?.text ?? "";
	if (!id || !text) return "";
	return `[${id}] (durable.${readCategory(memory)}) ${text}`;
}

function formatKnownCurrentLine(memory: Memory): string {
	const id = memory.id ?? "";
	const text = memory.content?.text ?? "";
	if (!id || !text) return "";
	const since = readEffectiveValidAt(memory) ?? "unknown";
	return `[${id}] (current.${readCategory(memory)}, since ${since}) ${text}`;
}

function formatKnownLines(memories: Memory[], kind: FactKind): string {
	const lines: string[] = [];
	for (const memory of memories) {
		const line =
			kind === "durable"
				? formatKnownDurableLine(memory)
				: formatKnownCurrentLine(memory);
		if (line) lines.push(line);
	}
	if (lines.length === 0) return "(none)";
	return lines.join("\n");
}

interface EmbeddedMemory {
	memory: Memory;
	embedding: number[] | null;
}

async function embedText(
	runtime: IAgentRuntime,
	text: string,
): Promise<number[] | null> {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const result = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
		text: trimmed,
	});
	if (Array.isArray(result)) {
		return result as number[];
	}
	return null;
}

/**
 * Find the existing fact in the candidate pool whose embedding is most
 * similar to `targetEmbedding`, restricted to the same `kind` + `category`.
 * Returns `null` if no embeddings are available or no candidate clears the
 * threshold.
 */
function findDedupTarget(
	candidates: EmbeddedMemory[],
	targetEmbedding: number[],
	kind: FactKind,
	category: string,
): { memory: Memory; similarity: number } | null {
	let best: { memory: Memory; similarity: number } | null = null;
	for (const candidate of candidates) {
		if (!candidate.embedding) continue;
		if (readFactKind(candidate.memory) !== kind) continue;
		if (readCategory(candidate.memory) !== category) continue;
		const similarity = cosineSimilarity(candidate.embedding, targetEmbedding);
		if (similarity >= DEDUP_SIMILARITY_THRESHOLD) {
			if (!best || similarity > best.similarity) {
				best = { memory: candidate.memory, similarity };
			}
		}
	}
	return best;
}

function parseExtractorResponse(
	runtime: IAgentRuntime,
	raw: unknown,
): ExtractorOp[] | null {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const validated = ExtractorOutputSchema.safeParse(raw);
		if (!validated.success) {
			runtime.logger.warn(
				{
					src: "plugin:advanced-capabilities:evaluator:fact-extractor",
					agentId: runtime.agentId,
					issues: validated.error.issues,
				},
				"Fact extractor object output failed schema validation",
			);
			return null;
		}
		return validated.data.ops;
	}

	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;

	// JSON fallback for older mocks and providers that return object JSON as text.
	const start = trimmed.indexOf("{");
	if (start === -1) return null;
	const end = trimmed.lastIndexOf("}");
	if (end === -1 || end <= start) return null;
	const slice = trimmed.slice(start, end + 1);
	let parsed: unknown;
	try {
		parsed = JSON.parse(slice);
	} catch (error) {
		runtime.logger.warn(
			{
				src: "plugin:advanced-capabilities:evaluator:fact-extractor",
				agentId: runtime.agentId,
				error: error instanceof Error ? error.message : String(error),
			},
			"Fact extractor returned invalid structured output",
		);
		return null;
	}
	const validated = ExtractorOutputSchema.safeParse(parsed);
	if (!validated.success) {
		runtime.logger.warn(
			{
				src: "plugin:advanced-capabilities:evaluator:fact-extractor",
				agentId: runtime.agentId,
				issues: validated.error.issues,
			},
			"Fact extractor output failed schema validation",
		);
		return null;
	}
	return validated.data.ops;
}

interface ApplyContext {
	runtime: IAgentRuntime;
	message: Memory;
	candidatePool: EmbeddedMemory[];
	candidatesById: Map<string, Memory>;
	insertedThisRun: EmbeddedMemory[];
}

async function applyAddDurable(
	ctx: ApplyContext,
	op: AddDurableOp,
): Promise<{ added: boolean; strengthened: boolean }> {
	const proposedEmbedding = await embedText(ctx.runtime, op.claim);
	if (proposedEmbedding) {
		const dedupTarget = findDedupTarget(
			[...ctx.candidatePool, ...ctx.insertedThisRun],
			proposedEmbedding,
			"durable",
			op.category,
		);
		if (dedupTarget) {
			ctx.runtime.logger.debug(
				{
					src: "plugin:advanced-capabilities:evaluator:fact-extractor",
					agentId: ctx.runtime.agentId,
					factId: dedupTarget.memory.id,
					similarity: dedupTarget.similarity,
				},
				"Upgrading add_durable to strengthen via write-time dedup",
			);
			await applyStrengthenForMemory(ctx, dedupTarget.memory);
			return { added: false, strengthened: true };
		}
	}
	const factId = await insertFact(ctx, {
		claim: op.claim,
		kind: "durable",
		category: op.category,
		structuredFields: op.structured_fields,
		verificationStatus: op.verification_status,
		validAt: undefined,
	});
	if (factId && proposedEmbedding) {
		const inserted = await ctx.runtime.getMemoryById(factId);
		if (inserted) {
			ctx.insertedThisRun.push({
				memory: inserted,
				embedding: proposedEmbedding,
			});
			ctx.candidatesById.set(factId, inserted);
		}
	}
	return { added: factId != null, strengthened: false };
}

async function applyAddCurrent(
	ctx: ApplyContext,
	op: AddCurrentOp,
): Promise<{ added: boolean; strengthened: boolean }> {
	const proposedEmbedding = await embedText(ctx.runtime, op.claim);
	if (proposedEmbedding) {
		const dedupTarget = findDedupTarget(
			[...ctx.candidatePool, ...ctx.insertedThisRun],
			proposedEmbedding,
			"current",
			op.category,
		);
		if (dedupTarget) {
			ctx.runtime.logger.debug(
				{
					src: "plugin:advanced-capabilities:evaluator:fact-extractor",
					agentId: ctx.runtime.agentId,
					factId: dedupTarget.memory.id,
					similarity: dedupTarget.similarity,
				},
				"Upgrading add_current to strengthen via write-time dedup",
			);
			await applyStrengthenForMemory(ctx, dedupTarget.memory);
			return { added: false, strengthened: true };
		}
	}
	const validAt =
		typeof op.valid_at === "string" && op.valid_at.length > 0
			? op.valid_at
			: nowIso();
	const factId = await insertFact(ctx, {
		claim: op.claim,
		kind: "current",
		category: op.category,
		structuredFields: op.structured_fields,
		verificationStatus: undefined,
		validAt,
	});
	if (factId && proposedEmbedding) {
		const inserted = await ctx.runtime.getMemoryById(factId);
		if (inserted) {
			ctx.insertedThisRun.push({
				memory: inserted,
				embedding: proposedEmbedding,
			});
			ctx.candidatesById.set(factId, inserted);
		}
	}
	return { added: factId != null, strengthened: false };
}

interface InsertFactArgs {
	claim: string;
	kind: FactKind;
	category: DurableFactCategory | CurrentFactCategory | string;
	structuredFields: Record<string, unknown>;
	verificationStatus: FactVerificationStatus | undefined;
	validAt: string | undefined;
}

async function insertFact(
	ctx: ApplyContext,
	args: InsertFactArgs,
): Promise<UUID | null> {
	const factId = asUUID(v4());
	const verificationStatus: FactVerificationStatus =
		args.verificationStatus ?? "self_reported";
	const metadata: MemoryMetadata = {
		type: MemoryType.CUSTOM,
		source: "fact_extractor",
		confidence: NEW_FACT_CONFIDENCE,
		lastConfirmedAt: nowIso(),
		kind: args.kind,
		category: args.category,
		structuredFields: toJsonObject(args.structuredFields),
		verificationStatus,
		...(args.validAt ? { validAt: args.validAt } : {}),
	};
	const memory: Memory = {
		id: factId,
		entityId: ctx.message.entityId,
		agentId: ctx.runtime.agentId,
		roomId: ctx.message.roomId,
		content: { text: args.claim },
		metadata,
		createdAt: Date.now(),
	};
	const persistedId = await ctx.runtime.createMemory(memory, "facts", true);
	const persistedMemory: Memory = { ...memory, id: persistedId };
	await ctx.runtime.queueEmbeddingGeneration(persistedMemory, "low");
	return persistedId;
}

async function applyStrengthen(
	ctx: ApplyContext,
	op: StrengthenOp,
): Promise<boolean> {
	const fact = ctx.candidatesById.get(op.factId);
	if (!fact?.id) return false;
	await applyStrengthenForMemory(ctx, fact);
	return true;
}

/**
 * Copy a fact's stored metadata into a JSON-safe `MemoryMetadata` literal so
 * the typechecker is happy when we hand it back to `updateMemory`. The
 * stored shape already round-tripped through JSON in the adapter, but the
 * static type of `FactMetadata.structuredFields` is `Record<string,
 * unknown>` and that does not satisfy the metadata index signature directly.
 */
function preserveFactMetadata(fact: Memory): CustomMetadata {
	const meta = readFactMetadata(fact);
	const normalizedStructured =
		meta.structuredFields && typeof meta.structuredFields === "object"
			? toJsonObject(meta.structuredFields)
			: undefined;
	const next: CustomMetadata = {
		type: MemoryType.CUSTOM,
		...(typeof meta.confidence === "number"
			? { confidence: meta.confidence }
			: {}),
		...(typeof meta.lastReinforced === "string"
			? { lastReinforced: meta.lastReinforced }
			: {}),
		...(typeof meta.sourceTrajectoryId === "string"
			? { sourceTrajectoryId: meta.sourceTrajectoryId }
			: {}),
		...(meta.kind ? { kind: meta.kind } : {}),
		...(typeof meta.category === "string" ? { category: meta.category } : {}),
		...(normalizedStructured ? { structuredFields: normalizedStructured } : {}),
		...(typeof meta.validAt === "string" ? { validAt: meta.validAt } : {}),
		...(typeof meta.lastConfirmedAt === "string"
			? { lastConfirmedAt: meta.lastConfirmedAt }
			: {}),
		...(meta.verificationStatus
			? { verificationStatus: meta.verificationStatus }
			: {}),
	};
	return next;
}

async function applyStrengthenForMemory(
	ctx: ApplyContext,
	fact: Memory,
): Promise<void> {
	if (!fact.id) return;
	const nextConfidence = clamp01(pickFactConfidence(fact) + STRENGTHEN_DELTA);
	const nextMeta: CustomMetadata = {
		...preserveFactMetadata(fact),
		confidence: nextConfidence,
		lastConfirmedAt: nowIso(),
	};
	await ctx.runtime.updateMemory({ id: fact.id, metadata: nextMeta });
}

async function applyDecay(ctx: ApplyContext, op: DecayOp): Promise<boolean> {
	const fact = ctx.candidatesById.get(op.factId);
	if (!fact?.id) return false;
	const nextConfidence = clamp01(pickFactConfidence(fact) - DECAY_DELTA);
	if (nextConfidence < FACT_DECAY_FLOOR) {
		await ctx.runtime.deleteMemory(fact.id);
		return true;
	}
	const nextMeta: CustomMetadata = {
		...preserveFactMetadata(fact),
		confidence: nextConfidence,
	};
	await ctx.runtime.updateMemory({ id: fact.id, metadata: nextMeta });
	return true;
}

async function applyContradict(
	ctx: ApplyContext,
	op: ContradictOp,
): Promise<boolean> {
	const fact = ctx.candidatesById.get(op.factId);
	if (!fact || !ctx.message.entityId) return false;
	await recordFactCandidate(ctx.runtime, {
		entityId: ctx.message.entityId,
		kind: "contradict",
		existingFactId: asUuidOrUndefined(fact.id),
		proposedText: op.proposedText ?? fact.content?.text ?? "",
		reason: op.reason,
		evidenceMessageId: asUuidOrUndefined(ctx.message.id),
	});
	return true;
}

function asUuidOrUndefined(value: unknown): UUID | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return asUUID(value);
}

async function validate(
	runtime: IAgentRuntime,
	message: Memory,
	_state?: State,
): Promise<boolean> {
	if (!message.content?.text?.trim()) return false;
	if (!message.entityId || !message.roomId) return false;
	const cacheKey = `${message.roomId}-fact-extraction-last-processed`;
	const lastMessageId = await runtime.getCache<string>(cacheKey);
	return lastMessageId !== (message.id ?? "");
}

async function handler(
	runtime: IAgentRuntime,
	message: Memory,
	_state?: State,
): Promise<ActionResult | undefined> {
	if (!message.content?.text || !message.entityId || !message.roomId) {
		return undefined;
	}

	const messageEmbedding = await embedText(runtime, message.content.text);
	if (!messageEmbedding) {
		runtime.logger.debug(
			{
				src: "plugin:advanced-capabilities:evaluator:fact-extractor",
				agentId: runtime.agentId,
			},
			"Skipping fact extraction - empty embedding",
		);
		return undefined;
	}

	// Two parallel similarity searches, room- and entity-scoped, over the
	// `facts` table. Mirrors the read-path provider so the "what we already
	// know" view the LLM sees stays consistent with what it would later
	// retrieve. The runtime search API does not filter on metadata, so we
	// over-fetch and partition in TS.
	const [roomFacts, entityFacts] = await Promise.all([
		runtime.searchMemories({
			tableName: "facts",
			embedding: messageEmbedding,
			roomId: message.roomId,
			worldId: message.worldId,
			limit: CANDIDATE_POOL_SIZE,
		}),
		runtime.searchMemories({
			tableName: "facts",
			embedding: messageEmbedding,
			roomId: message.roomId,
			entityId: message.entityId,
			limit: CANDIDATE_POOL_SIZE,
		}),
	]);

	const dedupedPool = dedupeById([...roomFacts, ...entityFacts]);
	const { durable: durableCandidates, current: currentCandidates } =
		partitionByKind(dedupedPool);
	const knownDurable = durableCandidates.slice(0, MAX_KNOWN_PER_KIND);
	const knownCurrent = currentCandidates.slice(0, MAX_KNOWN_PER_KIND);

	// Snapshot embeddings for write-time dedup. Memories returned by
	// searchMemories already carry their stored embedding, so we read it
	// directly rather than re-embedding here.
	const candidatePool: EmbeddedMemory[] = dedupedPool.map((memory) => ({
		memory,
		embedding: Array.isArray(memory.embedding) ? memory.embedding : null,
	}));
	const candidatesById = new Map<string, Memory>();
	for (const memory of dedupedPool) {
		if (memory.id) candidatesById.set(memory.id, memory);
	}

	// Recent message context for the prompt — last 10 messages from the room,
	// rendered as bullet lines with sender name.
	const recentMessages = await runtime.getMemories({
		tableName: "messages",
		roomId: message.roomId,
		limit: 10,
		unique: false,
	});
	const recentLines: string[] = [];
	for (const memory of recentMessages) {
		const text = memory.content?.text;
		if (typeof text !== "string" || !text.trim()) continue;
		const senderName =
			(typeof memory.content?.senderName === "string" &&
				memory.content.senderName) ||
			(typeof memory.content?.name === "string" && memory.content.name) ||
			"someone";
		recentLines.push(`- ${senderName}: ${text}`);
	}
	const recentRendered =
		recentLines.length > 0 ? recentLines.join("\n") : "(none)";

	const agentName = runtime.character.name ?? "Agent";
	const senderName =
		(typeof message.content?.senderName === "string" &&
			message.content.senderName) ||
		(typeof message.content?.name === "string" && message.content.name) ||
		"the speaker";

	const prompt = composePrompt({
		state: {
			agentName,
			senderName,
			senderId: message.entityId,
			now: nowIso(),
			recentMessages: recentRendered,
			knownDurable: formatKnownLines(knownDurable, "durable"),
			knownCurrent: formatKnownLines(knownCurrent, "current"),
			message: message.content.text,
		},
		template: FACT_EXTRACTION_JSON_TEMPLATE,
	});

	const response = await runtime.useModel(ModelType.RESPONSE_HANDLER, {
		prompt,
		responseFormat: { type: "json_object" },
		responseSchema: FACT_EXTRACTION_SCHEMA,
		temperature: 0,
	});

	const ops = parseExtractorResponse(runtime, response);
	if (ops === null) {
		return undefined;
	}

	const ctx: ApplyContext = {
		runtime,
		message,
		candidatePool,
		candidatesById,
		insertedThisRun: [],
	};

	let added = 0;
	let strengthened = 0;
	let decayed = 0;
	let contradicted = 0;

	for (const op of ops) {
		if (op.op === "add_durable") {
			const result = await applyAddDurable(ctx, op);
			if (result.added) added += 1;
			if (result.strengthened) strengthened += 1;
			continue;
		}
		if (op.op === "add_current") {
			const result = await applyAddCurrent(ctx, op);
			if (result.added) added += 1;
			if (result.strengthened) strengthened += 1;
			continue;
		}
		if (op.op === "strengthen") {
			if (await applyStrengthen(ctx, op)) strengthened += 1;
			continue;
		}
		if (op.op === "decay") {
			if (await applyDecay(ctx, op)) decayed += 1;
			continue;
		}
		if (op.op === "contradict") {
			if (await applyContradict(ctx, op)) contradicted += 1;
		}
	}

	await runtime.setCache<string>(
		`${message.roomId}-fact-extraction-last-processed`,
		message.id ?? "",
	);

	runtime.logger.debug(
		{
			src: "plugin:advanced-capabilities:evaluator:fact-extractor",
			agentId: runtime.agentId,
			added,
			strengthened,
			decayed,
			contradicted,
		},
		"Fact extractor applied ops",
	);

	return {
		success: true,
		text: `Fact extractor: +${added} added, ${strengthened} strengthened, ${decayed} decayed, ${contradicted} contradicted.`,
		values: { added, strengthened, decayed, contradicted },
		data: { added, strengthened, decayed, contradicted },
	};
}

export const factExtractorEvaluator: Evaluator = {
	name: "FACT_EXTRACTOR",
	description:
		"Single-call fact extractor: classifies and reconciles user claims into the two-store fact memory (durable + current) per message.",
	similes: ["EXTRACT_FACTS", "FACT_CLASSIFIER", "FACT_OPS"],
	alwaysRun: false,
	examples: [],
	validate,
	handler,
};
