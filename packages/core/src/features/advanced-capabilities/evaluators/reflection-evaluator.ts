/**
 * ConsolidatedReflectionAction
 *
 * Single post-response LLM call that replaces the previous evaluator stack
 * (factExtractor + reflection + relationshipExtraction). One prompt asks
 * the model for:
 *
 *   - `thought`: a short self-reflection
 *   - `facts.ops[]`: durable/current fact ops (insert / strengthen / decay /
 *     contradict) over the two-store fact memory
 *   - `relationships[]`: entity-pair relationship updates (tags + interaction
 *     metadata)
 *   - `identities[]`: platform identities (twitter / github / telegram / etc.)
 *     mentioned by participants in the recent conversation
 *   - `task`: completion assessment for the current turn
 *
 * The handler then applies each branch independently. Fact-application
 * (write-time embedding dedup, candidate-pool fetching, contradiction
 * queueing), relationship upsert, identity upsert via
 * `RelationshipsService.upsertIdentity`, and task-completion persistence are
 * each handled in dedicated branches.
 *
 * Identity extraction is fully LLM-driven — no regex, no hard-coded patterns.
 * The model resolves participant mentions against the entity list passed in
 * the prompt and emits structured identity records that go straight into the
 * `entity_identities` table.
 */

import { v4 } from "uuid";
import z from "zod";
import { getEntityDetails } from "../../../entities.ts";
import type { RelationshipsService } from "../../../services/relationships.ts";
import type {
	Action,
	ActionResult,
	Entity,
	IAgentRuntime,
	Memory,
	MemoryMetadata,
	State,
	UUID,
} from "../../../types/index.ts";
import { ActionMode, asUUID, ModelType } from "../../../types/index.ts";
import type {
	CurrentFactCategory,
	CustomMetadata,
	DurableFactCategory,
	FactKind,
	FactMetadata,
	FactVerificationStatus,
} from "../../../types/memory.ts";
import { MemoryType } from "../../../types/memory.ts";
import { type JsonValue } from "../../../types/primitives.ts";
import { composePrompt, parseJSONObjectFromText } from "../../../utils.ts";
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
import {
	formatTaskCompletionStatus,
	getTaskCompletionCacheKey,
	type TaskCompletionAssessment,
} from "./task-completion.ts";

const MAX_KNOWN_PER_KIND = 15;
const CANDIDATE_POOL_SIZE = 30;
const RECENT_MESSAGES_LIMIT = 10;
const STRENGTHEN_DELTA = 0.1;
const DECAY_DELTA = 0.15;
const FACT_DECAY_FLOOR = 0.2;
const NEW_FACT_CONFIDENCE = 0.7;
const DEDUP_SIMILARITY_THRESHOLD = 0.92;
const IDENTITY_CONFIDENCE_THRESHOLD = 0.5;

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_ENTITY_REFERENCE_PATTERN =
	/^(entity_(initiating|being)_interaction|user(?:-\d+)?|scenarioagent(?:-agent)?|[a-z]+-agent|clinic|sms-message)$/i;

const CONSOLIDATED_REFLECTION_TEMPLATE = `# Task: Post-response reflection

You just helped {{agentName}} respond. Now produce ONE JSON object that captures, in a single pass:
  1. a short self-reflective thought,
  2. fact-store operations on the agent's two-store fact memory,
  3. relationship updates between participants,
  4. platform identities mentioned in the conversation,
  5. whether the user's task is complete this turn.

Return exactly one JSON object. No prose, no fences, no XML, no <think>.

## Fact stores

- durable: stable identity-level claims that matter in a year.
  Categories: identity, health, relationship, life_event, business_role, preference, goal.
- current: time-bound state about right now or the near term.
  Categories: feeling, physical_state, working_on, going_through, schedule_context.

Rules:
- If a claim feels stale or surprising to retrieve in a year, use current.
- Empty ops list is right for small talk or messages with no new claim.
- Before add_durable/add_current, scan known facts. If meaning already exists, emit strengthen with that factId.
- Paraphrases count as duplicates. Match meaning, not surface form.

Ops:
- add_durable: claim, category, structured_fields; optional verification_status, reason.
- add_current: claim, category, structured_fields; optional valid_at, reason.
- strengthen: factId, optional reason.
- decay: factId, optional reason.
- contradict: factId, reason, optional proposedText.

## Relationships

- sourceEntityId is the UUID of the entity initiating the interaction.
- targetEntityId is the UUID of the entity being interacted with.
- Relationships are one-direction; a mutual friendship is two entries.
- Use only entity UUIDs that appear in "Entities in Room". Skip placeholders.
- tags is an array of short strings (e.g. ["dm_interaction", "colleague"]).
- metadata may carry small structured fields (e.g. interactions count, sentiment).
- Omit relationships entirely if nothing changed.

## Identities

- entityId is the UUID of the entity the identity belongs to. It MUST be one of the UUIDs listed in "Entities in Room".
- platform is a short lowercase string: "twitter", "github", "telegram", "discord", "bluesky", "farcaster", "linkedin", etc.
- handle is the platform-specific handle. Strip leading "@" for platforms that don't require it (twitter, github, bluesky, farcaster). Keep "@" only when the platform's canonical form includes it (e.g. some telegram refs).
- confidence is between 0 and 1. Use 0.9 when the speaker explicitly claims their own handle ("my github is X"), 0.7-0.85 for clear self-claims with slight ambiguity, lower for second-hand mentions.
- Only emit identities that a participant explicitly states or claims for themselves OR for another known participant in the recent conversation. Do not invent.
- If the speaker mentions a third party by name, resolve that name against "Entities in Room". If you cannot resolve it to a listed entity UUID, OMIT the identity entirely.
- Do not emit identities for ambient mentions of public figures who aren't participants in the room.
- Omit the identities array entirely (or return []) when nothing was mentioned.

## Task completion

- Set task.completed=true only if the user no longer needs additional action or follow-up from you in this turn.
- If you asked a clarifying question, an action failed, work is still pending, or you only partially completed the request, set task.completed=false.
- Always include a short task.reason grounded in the conversation and action results.

## Examples

Message: "I have a flat cortisol curve confirmed via lab"
{
  "thought": "User shared a verified health detail; nothing else to do.",
  "facts": { "ops": [
    { "op": "add_durable", "claim": "flat cortisol curve", "category": "health",
      "structured_fields": { "condition": "flat cortisol curve", "source": "lab" },
      "verification_status": "confirmed" }
  ] },
  "relationships": [],
  "identities": [],
  "task": { "completed": true, "reason": "User reported a fact; no follow-up required." }
}

Message: "I'm anxious this morning"
{
  "thought": "Acknowledged the user's current state.",
  "facts": { "ops": [
    { "op": "add_current", "claim": "anxious this morning", "category": "feeling",
      "structured_fields": { "emotion": "anxious", "window": "morning" } }
  ] },
  "relationships": [],
  "identities": [],
  "task": { "completed": true, "reason": "User shared a feeling; conversation is in a stable state." }
}

Known durable facts include: [fact_abc] (durable.identity) lives in Berlin
Message: "Actually I moved to Tokyo last month"
{
  "thought": "Need to reconcile the existing Berlin fact with the user's update.",
  "facts": { "ops": [
    { "op": "contradict", "factId": "fact_abc", "proposedText": "lives in Tokyo",
      "reason": "user moved to Tokyo, contradicts Berlin" },
    { "op": "add_durable", "claim": "moved to Tokyo last month", "category": "life_event",
      "structured_fields": { "event": "relocation", "to": "Tokyo" } }
  ] },
  "relationships": [],
  "identities": [],
  "task": { "completed": true, "reason": "Information update acknowledged." }
}

Sender: Shaw (ID: 11111111-1111-1111-1111-111111111111)
Message: "fyi my github is shawmakesmusic and I'm @shawwalters on twitter"
{
  "thought": "User shared two platform handles for themselves.",
  "facts": { "ops": [] },
  "relationships": [],
  "identities": [
    { "entityId": "11111111-1111-1111-1111-111111111111", "platform": "github",
      "handle": "shawmakesmusic", "confidence": 0.9 },
    { "entityId": "11111111-1111-1111-1111-111111111111", "platform": "twitter",
      "handle": "shawwalters", "confidence": 0.85 }
  ],
  "task": { "completed": true, "reason": "Acknowledged shared identities." }
}

Entities in Room include Bob (ID: 22222222-2222-2222-2222-222222222222)
Sender: Alice (ID: 33333333-3333-3333-3333-333333333333)
Message: "Bob is on telegram as @bobby btw"
{
  "thought": "Alice attributed a telegram handle to Bob, who is in the room.",
  "facts": { "ops": [] },
  "relationships": [],
  "identities": [
    { "entityId": "22222222-2222-2222-2222-222222222222", "platform": "telegram",
      "handle": "@bobby", "confidence": 0.7 }
  ],
  "task": { "completed": true, "reason": "Identity recorded for known participant." }
}

## Inputs

Agent Name: {{agentName}}
Room Type: {{roomType}}
Message Sender: {{senderName}} (ID: {{senderId}})
Now: {{now}}

Recent messages:
{{recentMessages}}

Entities in Room:
{{entitiesInRoom}}

Existing Relationships:
{{existingRelationships}}

Latest Action Results:
{{actionResults}}

Known durable facts (format: [factId] (durable.category) claim):
{{knownDurable}}

Known current facts (format: [factId] (current.category, since validAt) claim):
{{knownCurrent}}

Latest message:
{{message}}

## Output schema

{
  "thought": string,
  "facts": { "ops": [ ...op objects per the rules above... ] },
  "relationships": [
    { "sourceEntityId": "<uuid>", "targetEntityId": "<uuid>",
      "tags": [string, ...], "metadata": { ... } }
  ],
  "identities": [
    { "entityId": "<uuid>", "platform": string, "handle": string, "confidence": number }
  ],
  "task": { "completed": boolean, "reason": string }
}

If nothing should change, return:
{ "thought": "", "facts": { "ops": [] }, "relationships": [], "identities": [], "task": { "completed": true, "reason": "..." } }`;

// Schema for the relationships + identities + task portion of the output.
// Facts use the existing ExtractorOutputSchema unchanged.
const RelationshipUpdateSchema = z.object({
	sourceEntityId: z.string().min(1),
	targetEntityId: z.string().min(1),
	tags: z.array(z.string()).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

const IdentityUpdateSchema = z.object({
	entityId: z.string().min(1),
	platform: z.string().min(1),
	handle: z.string().min(1),
	confidence: z.number().min(0).max(1),
});

const TaskAssessmentSchema = z.object({
	completed: z.boolean().optional(),
	reason: z.string().optional(),
});

const ReflectionExtraSchema = z.object({
	thought: z.string().optional(),
	relationships: z.array(RelationshipUpdateSchema).optional(),
	identities: z.array(IdentityUpdateSchema).optional(),
	task: TaskAssessmentSchema.optional(),
});

type RelationshipUpdate = z.infer<typeof RelationshipUpdateSchema>;
type IdentityUpdate = z.infer<typeof IdentityUpdateSchema>;
type TaskAssessment = z.infer<typeof TaskAssessmentSchema>;

interface ConsolidatedOutput {
	thought: string;
	ops: ExtractorOp[];
	relationships: RelationshipUpdate[];
	identities: IdentityUpdate[];
	task: TaskAssessment | null;
}

function nowIso(): string {
	return new Date().toISOString();
}

function formatPromptData(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function actionResultsFromState(state: State | undefined): ActionResult[] {
	const raw = state?.data?.actionResults;
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.filter((entry): entry is ActionResult => isRecord(entry));
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

function parseConsolidatedResponse(
	runtime: IAgentRuntime,
	raw: unknown,
): ConsolidatedOutput | null {
	let parsed: unknown = raw;
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) return null;
		const directParse = parseJSONObjectFromText(trimmed);
		if (directParse) {
			parsed = directParse;
		} else {
			const start = trimmed.indexOf("{");
			const end = trimmed.lastIndexOf("}");
			if (start === -1 || end === -1 || end <= start) return null;
			try {
				parsed = JSON.parse(trimmed.slice(start, end + 1));
			} catch (error) {
				runtime.logger.warn(
					{
						src: "plugin:advanced-capabilities:evaluator:reflection",
						agentId: runtime.agentId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Consolidated reflection returned invalid JSON",
				);
				return null;
			}
		}
	}

	if (!isRecord(parsed)) return null;

	// Facts portion.
	const factsValue = parsed.facts;
	const factsCandidate = isRecord(factsValue)
		? factsValue
		: Array.isArray(factsValue)
			? { ops: factsValue }
			: { ops: [] };
	const factsValidated = ExtractorOutputSchema.safeParse(factsCandidate);
	if (!factsValidated.success) {
		runtime.logger.warn(
			{
				src: "plugin:advanced-capabilities:evaluator:reflection",
				agentId: runtime.agentId,
				issues: factsValidated.error.issues,
			},
			"Consolidated reflection facts portion failed schema validation",
		);
		return null;
	}

	// Reflection extras (thought + relationships + task).
	const extrasValidated = ReflectionExtraSchema.safeParse(parsed);
	if (!extrasValidated.success) {
		runtime.logger.warn(
			{
				src: "plugin:advanced-capabilities:evaluator:reflection",
				agentId: runtime.agentId,
				issues: extrasValidated.error.issues,
			},
			"Consolidated reflection relationship/task portion failed validation",
		);
		return null;
	}

	return {
		thought: extrasValidated.data.thought ?? "",
		ops: factsValidated.data.ops,
		relationships: extrasValidated.data.relationships ?? [],
		identities: extrasValidated.data.identities ?? [],
		task: extrasValidated.data.task ?? null,
	};
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
					src: "plugin:advanced-capabilities:evaluator:reflection",
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
					src: "plugin:advanced-capabilities:evaluator:reflection",
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
	if (UUID_PATTERN.test(normalizedId)) {
		return normalizedId as UUID;
	}

	let entity: Entity | undefined;

	entity = entities.find((a) => a.id === normalizedId);
	if (entity?.id) {
		return entity.id;
	}

	entity = entities.find((a) => a.id?.includes(normalizedId));
	if (entity?.id) {
		return entity.id;
	}

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
	return UUID_PATTERN.test(value);
}

function normalizeTaskCompletion(
	thought: string,
	task: TaskAssessment | null,
	messageId?: UUID,
): TaskCompletionAssessment {
	const completed = task?.completed ?? false;
	const reason = (task?.reason ?? "").trim();
	const assessed = task != null;

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
	thought: string,
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
				reflectionThought: thought,
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

async function applyIdentityUpdates(
	runtime: IAgentRuntime,
	identities: IdentityUpdate[],
	entities: Entity[],
	messageId: UUID | undefined,
): Promise<number> {
	if (identities.length === 0) return 0;

	const relationshipsService = runtime.getService(
		"relationships",
	) as RelationshipsService | null;
	if (
		!relationshipsService ||
		typeof relationshipsService.upsertIdentity !== "function"
	) {
		runtime.logger.debug(
			{
				src: "plugin:advanced-capabilities:evaluator:reflection",
				agentId: runtime.agentId,
			},
			"RelationshipsService.upsertIdentity unavailable; skipping identities",
		);
		return 0;
	}

	const evidenceMessageIds: UUID[] = messageId ? [messageId] : [];
	const knownEntityIds = new Set<string>();
	for (const entity of entities) {
		if (entity.id) knownEntityIds.add(entity.id);
	}

	let applied = 0;
	for (const identity of identities) {
		if (identity.confidence < IDENTITY_CONFIDENCE_THRESHOLD) continue;
		const entityIdRaw = normalizeEntityReference(identity.entityId);
		if (!isValidUuid(entityIdRaw)) continue;
		if (!knownEntityIds.has(entityIdRaw)) continue;
		const platform = identity.platform.trim().toLowerCase();
		const handle = identity.handle.trim();
		if (!platform || !handle) continue;
		await relationshipsService.upsertIdentity(
			entityIdRaw as UUID,
			{
				platform,
				handle,
				verified: false,
				confidence: identity.confidence,
				source: "reflection",
			},
			evidenceMessageIds,
		);
		applied += 1;
	}

	return applied;
}

async function applyRelationshipUpdates(
	runtime: IAgentRuntime,
	relationships: RelationshipUpdate[],
	entities: Entity[],
	agentId: UUID,
	senderEntityId: UUID,
): Promise<number> {
	if (relationships.length === 0) return 0;

	const existingRelationships = await runtime.getRelationships({
		entityIds: [senderEntityId, agentId],
	});
	const relationshipByPair = new Map<
		string,
		(typeof existingRelationships)[number]
	>();
	for (const rel of existingRelationships) {
		relationshipByPair.set(`${rel.sourceEntityId}|${rel.targetEntityId}`, rel);
	}

	let applied = 0;
	for (const relationship of relationships) {
		if (!relationship.sourceEntityId || !relationship.targetEntityId) continue;
		if (
			isPlaceholderEntityReference(relationship.sourceEntityId) ||
			isPlaceholderEntityReference(relationship.targetEntityId)
		) {
			continue;
		}

		let sourceId: UUID;
		let target: UUID;
		try {
			sourceId = resolveEntity(relationship.sourceEntityId, entities);
			target = resolveEntity(relationship.targetEntityId, entities);
		} catch {
			continue;
		}

		if (!isValidUuid(sourceId) || !isValidUuid(target)) continue;
		if (sourceId === target) continue;

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

		const tags = Array.isArray(relationship.tags)
			? relationship.tags.map((tag) => tag.trim()).filter(Boolean)
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
					...(relationship.metadata ?? {}),
				},
			});
		}
		applied += 1;
	}

	return applied;
}

async function validate(
	runtime: IAgentRuntime,
	message: Memory,
	_state?: State,
): Promise<boolean> {
	if (!message.content?.text?.trim()) return false;
	if (!message.entityId || !message.roomId) return false;
	const cacheKey = `${message.roomId}-reflection-last-processed`;
	const lastMessageId = await runtime.getCache<string>(cacheKey);
	return lastMessageId !== (message.id ?? "");
}

async function handler(
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
): Promise<ActionResult | undefined> {
	if (!message.content?.text || !message.entityId || !message.roomId) {
		return {
			success: true,
			text: "Consolidated reflection skipped: missing message context.",
			data: {
				skipped: true,
				reason: "missing_message_context",
				added: 0,
				strengthened: 0,
				decayed: 0,
				contradicted: 0,
				relationshipCount: 0,
				identitiesUpserted: 0,
				taskAssessed: false,
				taskCompleted: false,
			},
		};
	}

	const agentId = message.agentId ?? runtime.agentId;
	const { roomId } = message;

	const messageEmbedding = await embedText(runtime, message.content.text);
	if (!messageEmbedding) {
		return {
			success: true,
			text: "Consolidated reflection skipped: empty embedding.",
			data: {
				skipped: true,
				reason: "empty_embedding",
				added: 0,
				strengthened: 0,
				decayed: 0,
				contradicted: 0,
				relationshipCount: 0,
				identitiesUpserted: 0,
				taskAssessed: false,
				taskCompleted: false,
			},
		};
	}

	const cachedActionResults = message.id
		? runtime.getActionResults(message.id)
		: [];
	const actionResults =
		cachedActionResults.length > 0
			? cachedActionResults
			: actionResultsFromState(state);

	// Parallel fetch: fact candidates (room + entity scoped), recent
	// dialogue, existing relationships, room entities. Mirrors the
	// individual evaluators' read paths so the model sees a consistent view
	// of what the agent already knows.
	const [
		roomFacts,
		entityFacts,
		recentMessages,
		existingRelationships,
		entities,
	] = await Promise.all([
		runtime.searchMemories({
			tableName: "facts",
			embedding: messageEmbedding,
			roomId,
			worldId: message.worldId,
			limit: CANDIDATE_POOL_SIZE,
		}),
		runtime.searchMemories({
			tableName: "facts",
			embedding: messageEmbedding,
			roomId,
			entityId: message.entityId,
			limit: CANDIDATE_POOL_SIZE,
		}),
		runtime.getMemories({
			tableName: "messages",
			roomId,
			limit: RECENT_MESSAGES_LIMIT,
			unique: false,
		}),
		runtime.getRelationships({
			entityIds: [message.entityId, agentId],
		}),
		getEntityDetails({ runtime, roomId }),
	]);

	const dedupedPool = dedupeById([...roomFacts, ...entityFacts]);
	const { durable: durableCandidates, current: currentCandidates } =
		partitionByKind(dedupedPool);
	const knownDurable = durableCandidates.slice(0, MAX_KNOWN_PER_KIND);
	const knownCurrent = currentCandidates.slice(0, MAX_KNOWN_PER_KIND);

	const candidatePool: EmbeddedMemory[] = dedupedPool.map((memory) => ({
		memory,
		embedding: Array.isArray(memory.embedding) ? memory.embedding : null,
	}));
	const candidatesById = new Map<string, Memory>();
	for (const memory of dedupedPool) {
		if (memory.id) candidatesById.set(memory.id, memory);
	}

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

	// Strip bloated metadata from the relationship list to keep the prompt
	// bounded — only the fields the model needs to dedupe pairs.
	const slimRelationships = existingRelationships.map((r) => ({
		sourceEntityId: r.sourceEntityId,
		targetEntityId: r.targetEntityId,
		tags: r.tags,
		relationshipType: (r.metadata as { relationshipType?: string } | undefined)
			?.relationshipType,
	}));

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
			roomType: (message.content.channelType as string) ?? "",
			recentMessages: recentRendered,
			entitiesInRoom: formatPromptData({ entities }),
			existingRelationships: formatPromptData({
				relationships: slimRelationships,
			}),
			actionResults: formatActionResults(actionResults),
			knownDurable: formatKnownLines(knownDurable, "durable"),
			knownCurrent: formatKnownLines(knownCurrent, "current"),
			message: message.content.text,
		},
		template: CONSOLIDATED_REFLECTION_TEMPLATE,
	});

	const response = await runtime.useModel(ModelType.RESPONSE_HANDLER, {
		prompt,
		responseFormat: { type: "json_object" },
		temperature: 0,
	});

	const parsed = parseConsolidatedResponse(runtime, response);
	if (!parsed) {
		return {
			success: true,
			text: "Consolidated reflection skipped: model output did not validate.",
			data: {
				skipped: true,
				reason: "invalid_model_response",
				added: 0,
				strengthened: 0,
				decayed: 0,
				contradicted: 0,
				relationshipCount: 0,
				identitiesUpserted: 0,
				taskAssessed: false,
				taskCompleted: false,
			},
		};
	}

	// 1. Apply fact ops.
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

	for (const op of parsed.ops) {
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

	// 2. Apply relationship updates.
	const relationshipCount = await applyRelationshipUpdates(
		runtime,
		parsed.relationships,
		entities,
		agentId,
		message.entityId,
	);

	// 3. Apply identity updates (LLM-extracted platform handles).
	const identitiesUpserted = await applyIdentityUpdates(
		runtime,
		parsed.identities,
		entities,
		message.id as UUID | undefined,
	);

	// 4. Apply task completion.
	const taskCompletion = normalizeTaskCompletion(
		parsed.thought,
		parsed.task,
		message.id as UUID | undefined,
	);
	await storeTaskCompletionReflection(
		runtime,
		message,
		parsed.thought,
		taskCompletion,
	);

	await runtime.setCache<string>(
		`${roomId}-reflection-last-processed`,
		message.id ?? "",
	);

	runtime.logger.debug(
		{
			src: "plugin:advanced-capabilities:evaluator:reflection",
			agentId: runtime.agentId,
			added,
			strengthened,
			decayed,
			contradicted,
			relationshipCount,
			identitiesUpserted,
			taskAssessed: taskCompletion.assessed,
			taskCompleted: taskCompletion.completed,
		},
		"Consolidated reflection applied",
	);

	return {
		success: true,
		text: formatTaskCompletionStatus(taskCompletion),
		values: {
			added,
			strengthened,
			decayed,
			contradicted,
			relationshipCount,
			identitiesUpserted,
			taskCompleted: taskCompletion.completed,
			taskCompletionAssessed: taskCompletion.assessed,
			taskCompletionReason: taskCompletion.reason,
		},
		data: {
			added,
			strengthened,
			decayed,
			contradicted,
			relationshipCount,
			identitiesUpserted,
			taskAssessed: taskCompletion.assessed,
			taskCompleted: taskCompletion.completed,
			taskCompletion,
		},
	};
}

/**
 * Consolidated post-response reflection. One LLM call extracts facts,
 * relationship updates, platform identities, and task completion in a single
 * pass.
 */
export const reflectionEvaluator: Action = {
	name: "REFLECTION",
	description:
		"Post-response reflection: extracts facts, semantic relationship details, platform identities, and task completion in a single LLM call. Runs only after the agent has actually responded.",
	similes: [
		"REFLECT",
		"SELF_REFLECT",
		"EVALUATE_INTERACTION",
		"ASSESS_SITUATION",
		"EXTRACT_FACTS",
		"FACT_CLASSIFIER",
		"FACT_OPS",
	],
	mode: ActionMode.ALWAYS_AFTER,
	modePriority: 100,
	examples: [],
	validate: validate as Action["validate"],
	handler: handler as Action["handler"],
};
