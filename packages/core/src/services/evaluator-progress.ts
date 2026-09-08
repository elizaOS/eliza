/**
 * Revision-based progress for incremental post-turn extraction. The caller supplies
 * a complete authoritative room snapshot, not a page or an audience-filtered view.
 * Raw history is never modified. An absent checkpoint means a full eligible
 * backfill; edits and deletions are changes even when their timestamps are old.
 *
 * Validated model output is staged before reducers run. A retry restores that
 * exact batch/output while later messages remain pending for the next batch.
 * Progress commits only after every reducer succeeds. This is at-least-once:
 * reducers still need durable replay guards, and callers must retain room ordering.
 * Cache writes are not a transaction with reducer writes or a distributed lease.
 */
import { ElizaError } from "../errors.ts";
import { hashStableJson } from "../runtime/context-hash.ts";
import type {
	EvaluatorRunOptions,
	IAgentRuntime,
	Memory,
	UUID,
} from "../types/index.ts";
import { isPlainObject } from "../utils/type-guards.ts";

// Bump when extraction/progress semantics require an explicit new backfill.
const EXTRACTION_VERSION = 1;

/** Add-only reducers must explicitly hold edits/removals for reconciliation. */
export function assertExtractionSourcesUnchanged(
	extraction: EvaluatorRunOptions["extraction"],
): void {
	const changedCount = extraction?.changedMessageIds.length ?? 0;
	const removedCount = extraction?.removedMessageIds.length ?? 0;
	if (changedCount || removedCount)
		throw new ElizaError(
			"Edited or deleted extraction sources require reconciliation before add-only memory writes",
			{
				code: "EVALUATOR_SOURCE_REVIEW_REQUIRED",
				severity: "ephemeral",
				context: { changedCount, removedCount },
			},
		);
}

export interface EvaluatorProgressSnapshot {
	messages: Memory[];
	isBackfill: boolean;
	triggerMessage: Memory;
	sourceRevisions: Record<string, string>;
	changedMessageIds: UUID[];
	removedMessageIds: UUID[];
	evidenceId: string;
	/** Present only for a durably staged, validated model section. */
	pendingOutput?: unknown;
}

interface ProgressScope {
	agentId: UUID;
	roomId: UUID;
	entityId: UUID;
	evaluatorName: string;
	version: number;
}

interface EvidenceBatch {
	isBackfill: boolean;
	triggerMessageId: UUID;
	sourceRevisions: Record<string, string>;
	changedMessageIds: UUID[];
	removedMessageIds: UUID[];
	evidenceId: string;
	/** Full observed revision map; later arrivals must not be acknowledged. */
	retainedRevisions: Record<string, string>;
}

interface ProgressRecord {
	scope: ProgressScope;
	completed: Record<string, string>;
	pending?: EvidenceBatch & { output: unknown };
}

const snapshotState = new WeakMap<
	EvaluatorProgressSnapshot,
	{
		runtime: IAgentRuntime;
		key: string;
		scope: ProgressScope;
		expected: ProgressRecord | undefined;
		batch: EvidenceBatch;
	}
>();

function sourceMemory(
	memory: Memory,
	scope: Pick<ProgressScope, "agentId" | "roomId">,
): Memory {
	if (
		typeof memory.id !== "string" ||
		!memory.id.trim() ||
		memory.roomId !== scope.roomId ||
		(memory.agentId !== undefined && memory.agentId !== scope.agentId) ||
		!isPlainObject(memory.content)
	) {
		throw new ElizaError(
			"Incremental extraction requires persisted, room-scoped messages",
			{
				code: "EVALUATOR_PROGRESS_INVALID_SOURCE",
			},
		);
	}
	const source = structuredClone(memory);
	// These are retrieval-derived, not authored message revisions. BGE refreshes
	// must not re-extract an unchanged conversation or duplicate vector payloads.
	delete source.embedding;
	delete source.similarity;
	return source;
}

/** Fingerprint authored evidence, not inference/retrieval bookkeeping. Unknown
 * plugin-authored metadata is retained so meaningful extensions still count. */
function sourceRevision(memory: Memory): string {
	const source = structuredClone(memory);
	delete source.embedding;
	delete source.similarity;
	for (const key of [
		"providers",
		"responseId",
		"responseMessageId",
		"evalCallbacks",
		"chatIdempotency",
	])
		delete source.content[key];
	if (isPlainObject(source.metadata)) {
		for (const key of [
			"trajectoryStepId",
			"trajectoryId",
			"evaluatedAt",
			"lastEvaluatedAt",
			"embeddedAt",
			"embeddingUpdatedAt",
			"embeddingModel",
			"embeddingDimensions",
			"lastAccessedAt",
			"accessCount",
			"topics",
		])
			delete source.metadata[key];
		if (isPlainObject(source.metadata.session)) {
			const session = { ...source.metadata.session };
			delete session.updatedAt;
			delete session.usage;
			if (Object.keys(session).length) source.metadata.session = session;
			else delete source.metadata.session;
		}
		if (!Object.keys(source.metadata).length) delete source.metadata;
	}
	return hashStableJson(source);
}

/** Only captured evidence and the original trigger constrain replay. Later
 * arrivals and edits to other history remain work for the following batch. */
function assertBatchSourcesCurrent(
	batch: EvidenceBatch,
	current: Record<string, string>,
): void {
	const changed = Object.entries(batch.sourceRevisions)
		.filter(([id, revision]) => current[id] !== revision)
		.map(([id]) => id);
	const restored = batch.removedMessageIds.filter((id) =>
		Object.hasOwn(current, id),
	);
	const triggerId = batch.triggerMessageId;
	if (
		current[triggerId] !== batch.retainedRevisions[triggerId] &&
		!changed.includes(triggerId)
	)
		changed.push(triggerId);
	if (changed.length || restored.length)
		throw new ElizaError(
			"Staged evaluator evidence changed; reconciliation is required before replay",
			{
				code: "EVALUATOR_PROGRESS_STALE_EVIDENCE",
				severity: "ephemeral",
				context: {
					changedCount: changed.length,
					restoredCount: restored.length,
				},
			},
		);
}

function isRevisionMap(value: unknown): value is Record<string, string> {
	return (
		isPlainObject(value) &&
		Object.entries(value).every(
			([id, revision]) =>
				id.trim().length > 0 &&
				typeof revision === "string" &&
				/^[a-f0-9]{64}$/.test(revision),
		)
	);
}

function evidenceId(
	scope: ProgressScope,
	completed: Record<string, string>,
	batch: Pick<
		EvidenceBatch,
		"sourceRevisions" | "removedMessageIds" | "triggerMessageId" | "isBackfill"
	>,
): string {
	return hashStableJson({ scope, completed, ...batch });
}

function readRecord(
	value: unknown,
	scope: ProgressScope,
): ProgressRecord | undefined {
	if (value === undefined) return undefined;
	const invalid = () =>
		new ElizaError("Invalid incremental evaluator checkpoint", {
			code: "EVALUATOR_PROGRESS_INVALID_CHECKPOINT",
		});
	if (
		!isPlainObject(value) ||
		hashStableJson(value.scope) !== hashStableJson(scope) ||
		!isRevisionMap(value.completed)
	) {
		throw invalid();
	}
	if (value.pending !== undefined) {
		const pending = value.pending;
		if (
			!isPlainObject(pending) ||
			typeof pending.isBackfill !== "boolean" ||
			Object.hasOwn(pending, "messages") ||
			!isRevisionMap(pending.sourceRevisions) ||
			!isRevisionMap(pending.retainedRevisions) ||
			typeof pending.triggerMessageId !== "string" ||
			!Object.hasOwn(pending.retainedRevisions, pending.triggerMessageId) ||
			!Array.isArray(pending.changedMessageIds) ||
			!Array.isArray(pending.removedMessageIds) ||
			!Object.hasOwn(pending, "output") ||
			pending.output === undefined
		)
			throw invalid();
		const completed = value.completed;
		const retainedRevisions = pending.retainedRevisions;
		const expectedSources = Object.fromEntries(
			Object.entries(retainedRevisions).filter(
				([id, revision]) => completed[id] !== revision,
			),
		);
		const expectedRemovals = Object.keys(completed)
			.filter((id) => !Object.hasOwn(retainedRevisions, id))
			.sort();
		const expectedEdits = Object.keys(expectedSources)
			.filter((id) => Object.hasOwn(completed, id))
			.sort();
		if (
			hashStableJson(expectedSources) !==
				hashStableJson(pending.sourceRevisions) ||
			hashStableJson(expectedRemovals) !==
				hashStableJson(pending.removedMessageIds) ||
			hashStableJson(expectedEdits) !==
				hashStableJson(pending.changedMessageIds)
		)
			throw invalid();
		if (
			pending.evidenceId !==
			evidenceId(scope, value.completed, {
				isBackfill: pending.isBackfill,
				triggerMessageId: pending.triggerMessageId as UUID,
				sourceRevisions: pending.sourceRevisions,
				removedMessageIds: expectedRemovals as UUID[],
			})
		)
			throw invalid();
	}
	return structuredClone(value) as unknown as ProgressRecord;
}

/** All new/edited records and explicit removals, independently per extractor. */
export async function prepareEvaluatorProgress(
	runtime: IAgentRuntime,
	message: Memory,
	evaluatorNames: readonly string[],
	completeMessages: readonly Memory[],
): Promise<Map<string, EvaluatorProgressSnapshot>> {
	if (!message.id || !message.roomId || !message.entityId || !runtime.agentId) {
		throw new ElizaError(
			"Incremental extraction requires a persisted trigger and owner scope",
			{
				code: "EVALUATOR_PROGRESS_INVALID_SOURCE",
			},
		);
	}
	const sources = new Map<string, Memory>();
	for (const memory of completeMessages) {
		const source = sourceMemory(memory, {
			agentId: runtime.agentId,
			roomId: message.roomId,
		});
		const id = source.id as UUID;
		if (sources.has(id))
			throw new ElizaError("Duplicate message ID in extraction snapshot", {
				code: "EVALUATOR_PROGRESS_INVALID_SOURCE",
			});
		sources.set(id, source);
	}
	const retainedRevisions = Object.fromEntries(
		[...sources].map(([id, source]) => [id, sourceRevision(source)]),
	);
	const trigger = sources.get(message.id);
	if (!trigger || trigger.entityId !== message.entityId)
		throw new ElizaError(
			"Original extraction trigger is absent from authoritative room history",
			{
				code: "EVALUATOR_PROGRESS_INVALID_SOURCE",
			},
		);
	const snapshots = new Map<string, EvaluatorProgressSnapshot>();
	for (const evaluatorName of evaluatorNames) {
		if (!evaluatorName.trim() || snapshots.has(evaluatorName))
			throw new ElizaError("Invalid evaluator progress name", {
				code: "EVALUATOR_PROGRESS_INVALID_SCOPE",
			});
		const scope: ProgressScope = {
			agentId: runtime.agentId,
			roomId: message.roomId,
			entityId: message.entityId,
			evaluatorName,
			version: EXTRACTION_VERSION,
		};
		const key = `evaluator-progress:${hashStableJson(scope)}`;
		const record = readRecord(await runtime.getCache<unknown>(key), scope);
		const completed = record?.completed ?? {};
		let batch: EvidenceBatch;
		if (record?.pending) {
			assertBatchSourcesCurrent(record.pending, retainedRevisions);
			batch = record.pending;
		} else {
			const messages = [...sources.values()].filter(
				(source) =>
					completed[source.id as UUID] !== retainedRevisions[source.id as UUID],
			);
			const sourceRevisions = Object.fromEntries(
				messages.map((source) => [
					source.id as UUID,
					retainedRevisions[source.id as UUID],
				]),
			);
			const removedMessageIds = Object.keys(completed)
				.filter((id) => !sources.has(id))
				.sort() as UUID[];
			const changedMessageIds = Object.keys(sourceRevisions)
				.filter((id) => Object.hasOwn(completed, id))
				.sort() as UUID[];
			batch = {
				isBackfill: record === undefined,
				triggerMessageId: message.id,
				sourceRevisions,
				changedMessageIds,
				removedMessageIds,
				retainedRevisions,
				evidenceId: evidenceId(scope, completed, {
					isBackfill: record === undefined,
					triggerMessageId: message.id,
					sourceRevisions,
					removedMessageIds,
				}),
			};
		}
		const snapshot: EvaluatorProgressSnapshot = {
			messages: Object.keys(batch.sourceRevisions).map((id) =>
				structuredClone(sources.get(id) as Memory),
			),
			isBackfill: batch.isBackfill,
			triggerMessage: structuredClone(
				sources.get(batch.triggerMessageId) as Memory,
			),
			sourceRevisions: { ...batch.sourceRevisions },
			changedMessageIds: [...batch.changedMessageIds],
			removedMessageIds: [...batch.removedMessageIds],
			evidenceId: batch.evidenceId,
			...(record?.pending
				? { pendingOutput: structuredClone(record.pending.output) }
				: {}),
		};
		snapshotState.set(snapshot, {
			runtime,
			key,
			scope,
			expected: record,
			batch: structuredClone(batch),
		});
		snapshots.set(evaluatorName, snapshot);
	}
	return snapshots;
}

function requireSnapshot(
	runtime: IAgentRuntime,
	snapshot: EvaluatorProgressSnapshot,
) {
	const state = snapshotState.get(snapshot);
	if (!state || state.runtime !== runtime)
		throw new ElizaError("Unknown evaluator progress snapshot", {
			code: "EVALUATOR_PROGRESS_INVALID_SNAPSHOT",
		});
	return state;
}

async function assertCurrent(
	runtime: IAgentRuntime,
	state: ReturnType<typeof requireSnapshot>,
): Promise<void> {
	const current = readRecord(
		await runtime.getCache<unknown>(state.key),
		state.scope,
	);
	if (hashStableJson(current) !== hashStableJson(state.expected))
		throw new ElizaError(
			"Evaluator progress changed outside the ordered room lane",
			{
				code: "EVALUATOR_PROGRESS_CONFLICT",
				severity: "ephemeral",
			},
		);
}

/** Read through the adapter, explicitly bypassing runtime's default room-scan
 * memo. This catches source edits during inference and reducer execution. It is
 * validation, not an atomic transaction spanning source and reducer writes. */
async function assertSourcesCurrent(
	runtime: IAgentRuntime,
	state: ReturnType<typeof requireSnapshot>,
): Promise<void> {
	const rows = await runtime.getMemories({
		tableName: "messages",
		roomId: state.scope.roomId,
		agentId: state.scope.agentId,
		unique: false,
		orderDirection: "asc",
		includeEmbedding: false,
	});
	const revisions: Record<string, string> = {};
	for (const row of rows) {
		const source = sourceMemory(row, state.scope);
		const id = source.id as UUID;
		if (Object.hasOwn(revisions, id))
			throw new ElizaError(
				"Duplicate message ID in authoritative extraction evidence",
				{
					code: "EVALUATOR_PROGRESS_INVALID_SOURCE",
				},
			);
		revisions[id] = sourceRevision(source);
	}
	assertBatchSourcesCurrent(state.batch, revisions);
}

/** Caller must validate the model section before staging; no reducers run here. */
export async function stageEvaluatorOutput(
	runtime: IAgentRuntime,
	snapshot: EvaluatorProgressSnapshot,
	output: unknown,
): Promise<void> {
	const state = requireSnapshot(runtime, snapshot);
	if (output === undefined)
		throw new ElizaError("Cannot stage an absent evaluator output", {
			code: "EVALUATOR_PROGRESS_INVALID_OUTPUT",
		});
	await assertCurrent(runtime, state);
	await assertSourcesCurrent(runtime, state);
	if (state.expected?.pending) {
		if (
			hashStableJson(output) !== hashStableJson(state.expected.pending.output)
		)
			throw new ElizaError(
				"Cannot replace staged evaluator output before reconciliation",
				{
					code: "EVALUATOR_PROGRESS_CONFLICT",
				},
			);
		return;
	}
	const record: ProgressRecord = {
		scope: state.scope,
		completed: state.expected?.completed ?? {},
		pending: { ...state.batch, output: structuredClone(output) },
	};
	if (!(await runtime.setCache(state.key, record)))
		throw new ElizaError("Evaluator output was not durably staged", {
			code: "EVALUATOR_PROGRESS_WRITE_FAILED",
			severity: "ephemeral",
		});
	state.expected = structuredClone(record);
}

/** Call only after all this evaluator's durable reducers have succeeded. */
export async function commitEvaluatorProgress(
	runtime: IAgentRuntime,
	snapshot: EvaluatorProgressSnapshot,
): Promise<void> {
	const state = requireSnapshot(runtime, snapshot);
	await assertCurrent(runtime, state);
	if (!state.expected?.pending)
		throw new ElizaError(
			"Evaluator output must be staged before progress can commit",
			{
				code: "EVALUATOR_PROGRESS_NOT_STAGED",
			},
		);
	await assertSourcesCurrent(runtime, state);
	const record: ProgressRecord = {
		scope: state.scope,
		completed: state.batch.retainedRevisions,
	};
	if (!(await runtime.setCache(state.key, record)))
		throw new ElizaError("Evaluator progress was not durably committed", {
			code: "EVALUATOR_PROGRESS_WRITE_FAILED",
			severity: "ephemeral",
		});
	state.expected = structuredClone(record);
}
