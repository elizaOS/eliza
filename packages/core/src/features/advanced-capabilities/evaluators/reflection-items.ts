import { v4 } from "uuid";
import z from "zod";
import { getEntityDetails } from "../../../entities.ts";
import { EvaluatorPriority } from "../../../services/evaluator-priorities.ts";
import type { RelationshipsService } from "../../../services/relationships.ts";
import type {
	Entity,
	Evaluator,
	IAgentRuntime,
	JSONSchema,
	Memory,
	MemoryMetadata,
	RegisteredEvaluator,
	State,
	UUID,
} from "../../../types/index.ts";
import { asUUID } from "../../../types/index.ts";
import type {
	CurrentFactCategory,
	CustomMetadata,
	DurableFactCategory,
	FactKind,
	FactMetadata,
	FactVerificationStatus,
} from "../../../types/memory.ts";
import { MemoryType } from "../../../types/memory.ts";
import type { JsonValue } from "../../../types/primitives.ts";
import { isSyntheticConversationArtifactMemory } from "../../../utils/synthetic-conversation-artifact.ts";
import {
	buildFactKeywordsForStorage,
	buildFactSearchText,
	factLexicalSimilarity,
	readStoredFactKeywords,
} from "../fact-keywords.ts";
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
const FACT_LOOKBACK_LIMIT = 60;
const RECENT_MESSAGES_LIMIT = 10;
const STRENGTHEN_DELTA = 0.1;
const DECAY_DELTA = 0.15;
const FACT_DECAY_FLOOR = 0.2;
const NEW_FACT_CONFIDENCE = 0.7;
const DEDUP_SIMILARITY_THRESHOLD = 0.42;
const IDENTITY_CONFIDENCE_THRESHOLD = 0.5;

const factOpsSchema: JSONSchema = {
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
					keywords: {
						type: "array",
						items: { type: "string" },
						maxItems: 16,
					},
					verification_status: { type: "string" },
					valid_at: { type: "string" },
					factId: { type: "string" },
					proposedText: { type: "string" },
					reason: { type: "string" },
				},
				required: ["op"],
				additionalProperties: true,
			},
		},
	},
	required: ["ops"],
	additionalProperties: false,
};

const relationshipSchema: JSONSchema = {
	type: "object",
	properties: {
		relationships: {
			type: "array",
			items: {
				type: "object",
				properties: {
					sourceEntityId: { type: "string" },
					targetEntityId: { type: "string" },
					tags: { type: "array", items: { type: "string" } },
					metadata: { type: "object" },
				},
				required: ["sourceEntityId", "targetEntityId"],
				additionalProperties: false,
			},
		},
	},
	required: ["relationships"],
	additionalProperties: false,
};

const identitySchema: JSONSchema = {
	type: "object",
	properties: {
		identities: {
			type: "array",
			items: {
				type: "object",
				properties: {
					entityId: { type: "string" },
					platform: { type: "string" },
					handle: { type: "string" },
					confidence: { type: "number" },
				},
				required: ["entityId", "platform", "handle", "confidence"],
				additionalProperties: false,
			},
		},
	},
	required: ["identities"],
	additionalProperties: false,
};

const successSchema: JSONSchema = {
	type: "object",
	properties: {
		completed: { type: "boolean" },
		reason: { type: "string" },
		thought: { type: "string" },
	},
	required: ["completed", "reason"],
	additionalProperties: false,
};

const RelationshipUpdateSchema = z.object({
	sourceEntityId: z.string().min(1),
	targetEntityId: z.string().min(1),
	tags: z.array(z.string()).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

const RelationshipOutputSchema = z.object({
	relationships: z.array(RelationshipUpdateSchema),
});

const IdentityUpdateSchema = z.object({
	entityId: z.string().min(1),
	platform: z.string().min(1),
	handle: z.string().min(1),
	confidence: z.number().min(0).max(1),
});

const IdentityOutputSchema = z.object({
	identities: z.array(IdentityUpdateSchema),
});

const SuccessOutputSchema = z.object({
	completed: z.boolean(),
	reason: z.string(),
	thought: z.string().optional(),
});

type RelationshipUpdate = z.infer<typeof RelationshipUpdateSchema>;
type IdentityUpdate = z.infer<typeof IdentityUpdateSchema>;
type SuccessOutput = z.infer<typeof SuccessOutputSchema>;

interface ReflectionPrepared {
	recentMessages: Memory[];
	entities: Entity[];
	existingRelationships: Awaited<ReturnType<IAgentRuntime["getRelationships"]>>;
}

interface FactPrepared extends ReflectionPrepared {
	knownFacts: Memory[];
}

interface SuccessPrepared extends ReflectionPrepared {
	actionResults: unknown[];
}

interface FactCandidate {
	memory: Memory;
	searchText: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

function toJsonObject(value: Record<string, unknown>): {
	[key: string]: JsonValue;
} {
	return JSON.parse(JSON.stringify(value)) as { [key: string]: JsonValue };
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function asUuidOrNull(value: unknown): UUID | null {
	if (typeof value !== "string") return null;
	try {
		return asUUID(value.trim());
	} catch {
		return null;
	}
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
	return lines.length > 0 ? lines.join("\n") : "(none)";
}

function formatRecentMessages(memories: Memory[]): string {
	const lines: string[] = [];
	for (const memory of memories) {
		if (isSyntheticConversationArtifactMemory(memory)) continue;
		const text = memory.content?.text;
		if (typeof text !== "string" || !text.trim()) continue;
		const senderName =
			(typeof memory.content?.senderName === "string" &&
				memory.content.senderName) ||
			(typeof memory.content?.name === "string" && memory.content.name) ||
			memory.entityId ||
			"someone";
		lines.push(`- ${senderName}: ${text}`);
	}
	return lines.length > 0 ? lines.join("\n") : "(none)";
}

function formatEntities(entities: Entity[]): string {
	if (entities.length === 0) return "(none)";
	return entities
		.map((entity) => {
			const names = Array.isArray(entity.names) ? entity.names.join(", ") : "";
			return `- ${names || "unknown"} (ID: ${entity.id ?? "unknown"})`;
		})
		.join("\n");
}

function formatRelationships(
	relationships: ReflectionPrepared["existingRelationships"],
): string {
	if (relationships.length === 0) return "(none)";
	return JSON.stringify(
		relationships.map((relationship) => ({
			sourceEntityId: relationship.sourceEntityId,
			targetEntityId: relationship.targetEntityId,
			tags: relationship.tags,
			relationshipType: (
				relationship.metadata as { relationshipType?: string } | undefined
			)?.relationshipType,
		})),
		null,
		2,
	);
}

function actionResultsFromState(state: State | undefined): unknown[] {
	const raw = state?.data?.actionResults;
	return Array.isArray(raw) ? raw : [];
}

async function prepareReflectionContext(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<ReflectionPrepared> {
	const agentId = message.agentId ?? runtime.agentId;
	const [recentMessagesRaw, existingRelationships, entities] =
		await Promise.all([
			runtime.getMemories({
				tableName: "messages",
				roomId: message.roomId,
				limit: RECENT_MESSAGES_LIMIT,
				unique: false,
			}),
			runtime.getRelationships({
				entityIds: message.entityId ? [message.entityId, agentId] : [agentId],
			}),
			getEntityDetails({ runtime, roomId: message.roomId }),
		]);
	const recentMessages = recentMessagesRaw.filter(
		(memory) => !isSyntheticConversationArtifactMemory(memory),
	);
	return { recentMessages, existingRelationships, entities };
}

async function prepareFacts(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<FactPrepared> {
	const [base, roomFacts, entityFacts] = await Promise.all([
		prepareReflectionContext(runtime, message),
		runtime.getMemories({
			tableName: "facts",
			roomId: message.roomId,
			worldId: message.worldId,
			limit: FACT_LOOKBACK_LIMIT,
			unique: false,
		}),
		message.entityId
			? runtime.getMemories({
					tableName: "facts",
					roomId: message.roomId,
					entityId: message.entityId,
					limit: FACT_LOOKBACK_LIMIT,
					unique: false,
				})
			: Promise.resolve([]),
	]);
	const seen = new Set<string>();
	const knownFacts: Memory[] = [];
	for (const fact of [...roomFacts, ...entityFacts]) {
		if (!fact.id || seen.has(fact.id)) continue;
		seen.add(fact.id);
		knownFacts.push(fact);
	}
	return { ...base, knownFacts };
}

function findDedupTarget(
	candidates: FactCandidate[],
	targetValues: unknown[],
	kind: FactKind,
	category: string,
): { memory: Memory; similarity: number } | null {
	let best: { memory: Memory; similarity: number } | null = null;
	for (const candidate of candidates) {
		if (readFactKind(candidate.memory) !== kind) continue;
		if (readCategory(candidate.memory) !== category) continue;
		const similarity = factLexicalSimilarity(targetValues, [
			candidate.searchText,
			readStoredFactKeywords(candidate.memory),
		]);
		if (similarity >= DEDUP_SIMILARITY_THRESHOLD) {
			if (!best || similarity > best.similarity) {
				best = { memory: candidate.memory, similarity };
			}
		}
	}
	return best;
}

interface ApplyContext {
	runtime: IAgentRuntime;
	message: Memory;
	candidatePool: FactCandidate[];
	candidatesById: Map<string, Memory>;
	insertedThisRun: FactCandidate[];
}

async function insertFact(
	ctx: ApplyContext,
	args: {
		claim: string;
		kind: FactKind;
		category: DurableFactCategory | CurrentFactCategory | string;
		structuredFields: Record<string, unknown>;
		keywords: string[];
		verificationStatus: FactVerificationStatus | undefined;
		validAt: string | undefined;
	},
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
		keywords: args.keywords,
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
	return persistedId;
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
		...(Array.isArray(meta.keywords) ? { keywords: [...meta.keywords] } : {}),
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

async function applyAddDurable(
	ctx: ApplyContext,
	op: AddDurableOp,
): Promise<{ added: boolean; strengthened: boolean }> {
	const keywords = buildFactKeywordsForStorage(
		op.keywords ?? [],
		op.claim,
		op.category,
		op.structured_fields,
	);
	const targetValues = [op.claim, op.category, op.structured_fields, keywords];
	const dedupTarget = findDedupTarget(
		[...ctx.candidatePool, ...ctx.insertedThisRun],
		targetValues,
		"durable",
		op.category,
	);
	if (dedupTarget) {
		await applyStrengthenForMemory(ctx, dedupTarget.memory);
		return { added: false, strengthened: true };
	}
	const factId = await insertFact(ctx, {
		claim: op.claim,
		kind: "durable",
		category: op.category,
		structuredFields: op.structured_fields,
		keywords,
		verificationStatus: op.verification_status,
		validAt: undefined,
	});
	if (factId) {
		const inserted = await ctx.runtime.getMemoryById(factId);
		if (inserted) {
			ctx.insertedThisRun.push({
				memory: inserted,
				searchText: buildFactSearchText(inserted),
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
	const keywords = buildFactKeywordsForStorage(
		op.keywords ?? [],
		op.claim,
		op.category,
		op.structured_fields,
	);
	const targetValues = [op.claim, op.category, op.structured_fields, keywords];
	const dedupTarget = findDedupTarget(
		[...ctx.candidatePool, ...ctx.insertedThisRun],
		targetValues,
		"current",
		op.category,
	);
	if (dedupTarget) {
		await applyStrengthenForMemory(ctx, dedupTarget.memory);
		return { added: false, strengthened: true };
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
		keywords,
		verificationStatus: undefined,
		validAt,
	});
	if (factId) {
		const inserted = await ctx.runtime.getMemoryById(factId);
		if (inserted) {
			ctx.insertedThisRun.push({
				memory: inserted,
				searchText: buildFactSearchText(inserted),
			});
			ctx.candidatesById.set(factId, inserted);
		}
	}
	return { added: factId != null, strengthened: false };
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
		existingFactId: asUuidOrNull(fact.id) ?? undefined,
		proposedText: op.proposedText ?? fact.content?.text ?? "",
		reason: op.reason,
		evidenceMessageId: asUuidOrNull(ctx.message.id) ?? undefined,
	});
	return true;
}

async function applyRelationshipUpdates(
	runtime: IAgentRuntime,
	relationships: RelationshipUpdate[],
	entities: Entity[],
): Promise<number> {
	if (relationships.length === 0) return 0;
	const knownEntityIds = new Set(
		entities.map((entity) => entity.id).filter((id): id is UUID => Boolean(id)),
	);
	let applied = 0;
	for (const relationship of relationships) {
		const sourceId = asUuidOrNull(relationship.sourceEntityId);
		const targetId = asUuidOrNull(relationship.targetEntityId);
		if (!sourceId || !targetId) continue;
		if (!knownEntityIds.has(sourceId) || !knownEntityIds.has(targetId))
			continue;
		if (sourceId === targetId) continue;

		const existing = (
			await runtime.getRelationships({ entityIds: [sourceId] })
		).find((candidate) => candidate.targetEntityId === targetId);
		const tags = Array.isArray(relationship.tags)
			? relationship.tags.map((tag) => tag.trim()).filter(Boolean)
			: [];

		if (existing) {
			const updatedMetadata = {
				...existing.metadata,
				interactions:
					((existing.metadata?.interactions as number | undefined) || 0) + 1,
				...(relationship.metadata ?? {}),
			};
			const updatedTags = Array.from(
				new Set([...(existing.tags || []), ...tags]),
			);
			await runtime.updateRelationship({
				...existing,
				tags: updatedTags,
				metadata: updatedMetadata,
			});
		} else {
			await runtime.createRelationship({
				sourceEntityId: sourceId,
				targetEntityId: targetId,
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
		return 0;
	}

	const knownEntityIds = new Set(
		entities.map((entity) => entity.id).filter((id): id is UUID => Boolean(id)),
	);
	const evidenceMessageIds: UUID[] = messageId ? [messageId] : [];
	let applied = 0;
	for (const identity of identities) {
		if (identity.confidence < IDENTITY_CONFIDENCE_THRESHOLD) continue;
		const entityId = asUuidOrNull(identity.entityId);
		if (!entityId || !knownEntityIds.has(entityId)) continue;
		const platform = identity.platform.trim().toLowerCase();
		const handle = identity.handle.trim();
		if (!platform || !handle) continue;
		await relationshipsService.upsertIdentity(
			entityId,
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

function normalizeTaskCompletion(
	task: SuccessOutput,
	messageId?: UUID,
): TaskCompletionAssessment {
	const reason = task.reason.trim();
	return {
		assessed: true,
		completed: task.completed,
		reason:
			reason ||
			(task.completed
				? "The task is complete."
				: "The task is not complete yet."),
		source: "reflection",
		evaluatedAt: Date.now(),
		messageId,
	};
}

async function storeTaskCompletionReflection(
	runtime: IAgentRuntime,
	message: Memory,
	task: SuccessOutput,
	taskCompletion: TaskCompletionAssessment,
): Promise<void> {
	const summaryText = `Task completion reflection: ${
		taskCompletion.completed ? "completed" : "incomplete"
	}. ${taskCompletion.reason}`;

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
				reflectionThought: task.thought ?? "",
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

function canEvaluateMessage(message: Memory): boolean {
	return Boolean(
		message.content?.text?.trim() &&
			message.entityId &&
			message.roomId &&
			!isSyntheticConversationArtifactMemory(message),
	);
}

export const factMemoryEvaluator: Evaluator<
	z.infer<typeof ExtractorOutputSchema>,
	FactPrepared
> = {
	name: "factMemory",
	description:
		"Extracts durable/current fact-store operations from the recent conversation.",
	priority: EvaluatorPriority.REFLECTION_FACTS,
	schema: factOpsSchema,
	async shouldRun({ message }) {
		return canEvaluateMessage(message);
	},
	async prepare({ runtime, message }) {
		return prepareFacts(runtime, message);
	},
	prompt({ prepared }) {
		const { durable, current } = partitionByKind(prepared.knownFacts);
		return `Evaluate whether the conversation contains stable or current facts about the speaker.

Fact stores:
- durable: stable identity-level claims that matter in a year. Categories: identity, health, relationship, life_event, business_role, preference, goal.
- current: time-bound state about right now or the near term. Categories: feeling, physical_state, working_on, going_through, schedule_context.

Rules:
- If no meaningful new or changed fact exists, return {"ops":[]}.
- If meaning already exists in known facts, emit strengthen with that factId.
- If the message contradicts a known fact, emit contradict with that factId and reason.
- Use only fact IDs shown below for strengthen, decay, and contradict.
- For add_durable/add_current, emit keywords: 3-8 lowercase retrieval terms
  from the claim, category, proper nouns, places, dates, projects, symptoms,
  and preferences. Omit stopwords and generic words.

Recent messages:
${formatRecentMessages(prepared.recentMessages)}

Known durable facts:
${formatKnownLines(durable.slice(0, MAX_KNOWN_PER_KIND), "durable")}

Known current facts:
${formatKnownLines(current.slice(0, MAX_KNOWN_PER_KIND), "current")}`;
	},
	parse(output) {
		const result = ExtractorOutputSchema.safeParse(output);
		return result.success ? result.data : null;
	},
	processors: [
		{
			name: "applyFactOps",
			async process({ runtime, message, prepared, output }) {
				const candidatePool: FactCandidate[] = prepared.knownFacts.map(
					(memory) => ({
						memory,
						searchText: buildFactSearchText(memory),
					}),
				);
				const candidatesById = new Map<string, Memory>();
				for (const memory of prepared.knownFacts) {
					if (memory.id) candidatesById.set(memory.id, memory);
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
				for (const op of output.ops as ExtractorOp[]) {
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
				return {
					success: true,
					values: { added, strengthened, decayed, contradicted },
					data: { added, strengthened, decayed, contradicted },
				};
			},
		},
	],
};

export const relationshipEvaluator: Evaluator<
	z.infer<typeof RelationshipOutputSchema>,
	ReflectionPrepared
> = {
	name: "relationships",
	description:
		"Extracts semantic relationship updates between known room participants.",
	priority: EvaluatorPriority.REFLECTION_RELATIONSHIPS,
	providers: ["CONVERSATION_PROXIMITY"],
	schema: relationshipSchema,
	async shouldRun({ message }) {
		return canEvaluateMessage(message);
	},
	async prepare({ runtime, message }) {
		return prepareReflectionContext(runtime, message);
	},
	prompt({ prepared }) {
		return `Evaluate semantic relationship changes between participants.

Rules:
- Return only relationships that are clearly supported by the conversation.
- Use exact UUIDs from Entities in Room. Do not use names or placeholders.
- Relationships are directional; sourceEntityId initiates the interaction, targetEntityId receives it.
- If nothing changed, return {"relationships":[]}.

Recent messages:
${formatRecentMessages(prepared.recentMessages)}

Entities in Room:
${formatEntities(prepared.entities)}

Existing relationships:
${formatRelationships(prepared.existingRelationships)}`;
	},
	parse(output) {
		const result = RelationshipOutputSchema.safeParse(output);
		return result.success ? result.data : null;
	},
	processors: [
		{
			name: "applyRelationshipUpdates",
			async process({ runtime, prepared, output }) {
				const relationshipCount = await applyRelationshipUpdates(
					runtime,
					output.relationships,
					prepared.entities,
				);
				return {
					success: true,
					values: { relationshipCount },
					data: { relationshipCount },
				};
			},
		},
	],
};

export const identityEvaluator: Evaluator<
	z.infer<typeof IdentityOutputSchema>,
	ReflectionPrepared
> = {
	name: "identities",
	description:
		"Extracts LLM-resolved platform identities for known room participants.",
	priority: EvaluatorPriority.REFLECTION_IDENTITY,
	schema: identitySchema,
	async shouldRun({ message }) {
		return canEvaluateMessage(message);
	},
	async prepare({ runtime, message }) {
		return prepareReflectionContext(runtime, message);
	},
	prompt({ prepared }) {
		return `Evaluate whether any known room participant explicitly claimed or attributed a platform identity.

Rules:
- Use exact UUIDs from Entities in Room.
- Only emit identities explicitly stated in the recent conversation.
- Do not invent identities or emit ambient public-figure mentions.
- platform is lowercase, such as twitter, github, telegram, discord, bluesky, farcaster, linkedin.
- confidence is 0 to 1. Use higher confidence for self-claims, lower for second-hand claims.
- If nothing was mentioned, return {"identities":[]}.

Recent messages:
${formatRecentMessages(prepared.recentMessages)}

Entities in Room:
${formatEntities(prepared.entities)}`;
	},
	parse(output) {
		const result = IdentityOutputSchema.safeParse(output);
		return result.success ? result.data : null;
	},
	processors: [
		{
			name: "applyIdentityUpdates",
			async process({ runtime, message, prepared, output }) {
				const identitiesUpserted = await applyIdentityUpdates(
					runtime,
					output.identities,
					prepared.entities,
					asUuidOrNull(message.id) ?? undefined,
				);
				return {
					success: true,
					values: { identitiesUpserted },
					data: { identitiesUpserted },
				};
			},
		},
	],
};

export const successEvaluator: Evaluator<SuccessOutput, SuccessPrepared> = {
	name: "success",
	description:
		"Evaluates whether the user's task is complete for this turn and stores the assessment.",
	priority: EvaluatorPriority.REFLECTION_SUCCESS,
	schema: successSchema,
	async shouldRun({ message }) {
		return canEvaluateMessage(message);
	},
	async prepare({ runtime, message, state }) {
		const cachedActionResults = message.id
			? runtime.getActionResults(message.id)
			: [];
		return {
			...(await prepareReflectionContext(runtime, message)),
			actionResults:
				cachedActionResults.length > 0
					? cachedActionResults
					: actionResultsFromState(state),
		};
	},
	prompt({ prepared, options }) {
		return `Evaluate whether the current user task is complete after the agent response.

Rules:
- completed=true only if the user no longer needs additional action or follow-up in this turn.
- If the agent asked a clarifying question, an action failed, work is still pending, or the request was only partially handled, completed=false.
- Ground the reason in the conversation and action results.

Did respond: ${options.didRespond === true ? "true" : "false"}

Recent messages:
${formatRecentMessages(prepared.recentMessages)}

Action results:
${JSON.stringify(prepared.actionResults, null, 2)}`;
	},
	parse(output) {
		const result = SuccessOutputSchema.safeParse(output);
		return result.success ? result.data : null;
	},
	processors: [
		{
			name: "storeSuccessAssessment",
			async process({ runtime, message, output }) {
				const taskCompletion = normalizeTaskCompletion(
					output,
					asUuidOrNull(message.id) ?? undefined,
				);
				await storeTaskCompletionReflection(
					runtime,
					message,
					output,
					taskCompletion,
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
						taskAssessed: taskCompletion.assessed,
						taskCompleted: taskCompletion.completed,
						taskCompletion,
					},
				};
			},
		},
	],
};

export const reflectionItems: RegisteredEvaluator[] = [
	factMemoryEvaluator,
	relationshipEvaluator,
	identityEvaluator,
	successEvaluator,
];
