import { randomUUID as uuidv4 } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ElizaError } from "../errors";
import type { Content } from "../types/primitives.js";
import {
	buildMessageContentProjection,
	collectMessageContentSegmentIds,
	messageContentRequiresSegments,
} from "./message-content-segments";
/** Owns database mutations and their room, entity, and relationship cache invalidation using the canonical adapter and original runtime hooks. */

import { redactWithSecrets } from "../security/redact.js";
import type { Service } from "../types/service.ts";

/** Optional evidence-maintenance service supplied by an extraction plugin. */
type EvidenceMutationService = Service & {
	mutateSourceEvidence<T>(
		ids: UUID[],
		updates: Array<Partial<Memory> & { id: UUID }> | undefined,
		write: () => Promise<T>,
	): Promise<T>;
};

import type { PatchOp } from "../types/database.js";
import type {
	Component,
	Entity,
	Participant,
	Relationship,
	Room,
} from "../types/environment.js";
import type { Memory, MemoryMetadata } from "../types/memory.js";
import { afterMemoryPersistedPipelineHookContext } from "../types/pipeline-hooks";
import type { Metadata, UUID } from "../types/primitives.js";
import type { IAgentRuntime } from "../types/runtime.js";
import {
	findEquivalentFact,
	mergeStrongerFactMetadata,
} from "./fact-write-dedupe";
import type { SingleFlightMemo } from "./single-flight-memo";

export interface RuntimeDataMutationsHost {
	invalidateTurnEntityDetails(): void;
	invalidateTurnIdentityClusters(): void;
	getSecretsForRedaction(): Record<string, string>;
	roomMessagesMemo(): SingleFlightMemo<Memory[], number>;
	roomReadMemo(): SingleFlightMemo<Room | null>;
}

export class RuntimeDataMutations {
	constructor(
		private readonly runtime: IAgentRuntime,
		private readonly host: RuntimeDataMutationsHost,
	) {}

	private async mutateSourceEvidence<T>(
		ids: UUID[],
		updates: Array<Partial<Memory> & { id: UUID }> | undefined,
		write: () => Promise<T>,
	): Promise<T> {
		const evaluator =
			this.runtime.getService<EvidenceMutationService>("evaluator");
		return evaluator
			? evaluator.mutateSourceEvidence(ids, updates, write)
			: write();
	}

	async updateEntities(entities: Entity[]): Promise<void> {
		await this.runtime.adapter.updateEntities(entities);
		this.host.invalidateTurnEntityDetails();
	}

	async deleteEntities(entityIds: UUID[]): Promise<void> {
		await this.runtime.adapter.deleteEntities(entityIds);
		this.host.invalidateTurnEntityDetails();
		this.host.invalidateTurnIdentityClusters();
	}

	// Single-item entity wrapper
	async updateEntity(entity: Entity): Promise<void> {
		await this.runtime.adapter.updateEntities([entity]);
		this.host.invalidateTurnEntityDetails();
	}

	// Batch component methods
	async createComponents(components: Component[]): Promise<UUID[]> {
		const ids = await this.runtime.adapter.createComponents(components);
		this.host.invalidateTurnEntityDetails();
		return ids;
	}

	async updateComponents(components: Component[]): Promise<void> {
		await this.runtime.adapter.updateComponents(components);
		this.host.invalidateTurnEntityDetails();
	}

	async deleteComponents(componentIds: UUID[]): Promise<void> {
		await this.runtime.adapter.deleteComponents(componentIds);
		this.host.invalidateTurnEntityDetails();
	}

	// Single-item component wrappers
	async createComponent(component: Component): Promise<boolean> {
		const ids = await this.runtime.adapter.createComponents([component]);
		this.host.invalidateTurnEntityDetails();
		return ids.length > 0;
	}

	async updateComponent(component: Component): Promise<void> {
		await this.runtime.adapter.updateComponents([component]);
		this.host.invalidateTurnEntityDetails();
	}

	async deleteComponent(componentId: UUID): Promise<void> {
		await this.runtime.adapter.deleteComponents([componentId]);
		this.host.invalidateTurnEntityDetails();
	}

	async upsertComponent(component: Component): Promise<void> {
		await this.runtime.adapter.upsertComponents([component]);
		this.host.invalidateTurnEntityDetails();
	}

	async upsertComponents(
		components: Component[],
		options?: { entityContext?: UUID },
	): Promise<void> {
		await this.runtime.adapter.upsertComponents(components, options);
		this.host.invalidateTurnEntityDetails();
	}

	async patchComponent(
		componentId: UUID,
		ops: PatchOp[],
		options?: { entityContext?: UUID },
	): Promise<void> {
		await this.runtime.adapter.patchComponents([{ componentId, ops }], options);
		this.host.invalidateTurnEntityDetails();
	}

	async patchComponents(
		updates: Array<{ componentId: UUID; ops: PatchOp[] }>,
		options?: { entityContext?: UUID },
	): Promise<void> {
		await this.runtime.adapter.patchComponents(updates, options);
		this.host.invalidateTurnEntityDetails();
	}

	async patchComponentField(
		componentId: UUID,
		op: PatchOp,
		options?: { entityContext?: UUID },
	): Promise<void> {
		await this.runtime.adapter.patchComponents(
			[{ componentId, ops: [op] }],
			options,
		);
		this.host.invalidateTurnEntityDetails();
	}

	async upsertMemory(
		memory: Memory,
		tableName: string,
		options?: { entityContext?: UUID },
	): Promise<void> {
		// Apply secret redaction (same as createMemory) to prevent plaintext secrets
		const secrets = this.host.getSecretsForRedaction();
		if (Object.keys(secrets).length > 0 && memory.content.text) {
			memory = {
				...memory,
				content: {
					...memory.content,
					text: redactWithSecrets(memory.content.text, {
						secrets,
						applyPatterns: true,
					}),
				},
			};
		}
		return this.upsertMemories([{ memory, tableName }], options);
	}

	async upsertMemories(
		memories: Array<{ memory: Memory; tableName: string }>,
		options?: { entityContext?: UUID },
	): Promise<void> {
		const messages = memories
			.filter((entry) => entry.tableName === "messages" && entry.memory.id)
			.map((entry) => entry.memory as Memory & { id: UUID });
		return this.mutateSourceEvidence(
			messages.map((row) => row.id),
			messages,
			async () => {
				await this.runtime.adapter.upsertMemories(memories, options);
				for (const message of messages)
					this.host.roomMessagesMemo().invalidate(message.roomId);
			},
		);
	}

	// Batch relationship methods
	async createRelationships(
		relationships: Array<{
			sourceEntityId: UUID;
			targetEntityId: UUID;
			tags?: string[];
			metadata?: Metadata;
		}>,
	): Promise<UUID[]> {
		const ids = await this.runtime.adapter.createRelationships(relationships);
		this.host.invalidateTurnIdentityClusters();
		return ids;
	}

	async updateRelationships(relationships: Relationship[]): Promise<void> {
		await this.runtime.adapter.updateRelationships(relationships);
		this.host.invalidateTurnIdentityClusters();
	}

	async deleteRelationships(relationshipIds: UUID[]): Promise<void> {
		await this.runtime.adapter.deleteRelationships(relationshipIds);
		this.host.invalidateTurnIdentityClusters();
	}

	// Single-item relationship wrappers
	async createRelationship(params: {
		sourceEntityId: UUID;
		targetEntityId: UUID;
		tags?: string[];
		metadata?: Metadata;
	}): Promise<boolean> {
		const ids = await this.runtime.adapter.createRelationships([params]);
		this.host.invalidateTurnIdentityClusters();
		return ids.length > 0;
	}

	async updateRelationship(relationship: Relationship): Promise<void> {
		await this.runtime.adapter.updateRelationships([relationship]);
		this.host.invalidateTurnIdentityClusters();
	}

	// ── Batch memory passthroughs ────────────────────────────────────────
	// These go straight to the adapter with no transformation.
	// WHY no redaction here: batch callers are responsible for their own
	// content. The single-item createMemory() wrapper below handles
	// redaction for the common case.
	async createMemories(
		memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>,
	): Promise<UUID[]> {
		const ids = await this.runtime.adapter.createMemories(
			memories.map((entry) => ({
				...entry,
				memory: {
					...entry.memory,
					agentId: entry.memory.agentId ?? this.runtime.agentId,
				},
			})),
		);
		for (const entry of memories) {
			if (entry.tableName === "messages" && entry.memory.roomId) {
				this.host.roomMessagesMemo().invalidate(entry.memory.roomId);
			}
		}
		return ids;
	}

	async updateMemories(
		memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>,
	): Promise<void> {
		await this.mutateSourceEvidence(
			memories.map((row) => row.id),
			memories,
			async () => {
				await this.runtime.adapter.updateMemories(memories);
				this.host.roomMessagesMemo().invalidate();
			},
		);
		// Partial updates carry no table/room; drop every cached window rather
		// than risk serving a pre-update snapshot.
		this.host.roomMessagesMemo().invalidate();
	}

	async updateMemoryEmbedding(
		update: import("../types/database").MemoryEmbeddingUpdate,
	): Promise<boolean> {
		// A vector-only write does not change source evidence. Keep it outside the
		// reconciliation lease (including during shutdown); the adapter owns CAS.
		if (update.expected.agentId !== this.runtime.agentId) return false;
		const written = await this.runtime.adapter.updateMemoryEmbedding(update);
		if (written)
			this.host.roomMessagesMemo().invalidate(update.expected.roomId);
		return written;
	}

	async deleteMemories(memoryIds: UUID[]): Promise<void> {
		await this.mutateSourceEvidence(memoryIds, undefined, async () => {
			await this.runtime.adapter.deleteMemories(memoryIds);
			this.host.roomMessagesMemo().invalidate();
		});
	}

	private redactMessageContentForStorage(content: Content): Content {
		const secrets = this.host.getSecretsForRedaction();
		if (Object.keys(secrets).length === 0) return content;
		const redact = (value: string | undefined): string | undefined =>
			typeof value === "string"
				? redactWithSecrets(value, { secrets, applyPatterns: true })
				: value;
		return {
			...content,
			...(typeof content.text === "string"
				? { text: redact(content.text) }
				: {}),
			...(content.attachments
				? {
						attachments: content.attachments.map((attachment) => ({
							...attachment,
							...(typeof attachment.text === "string"
								? { text: redact(attachment.text) }
								: {}),
							...(typeof attachment.description === "string"
								? { description: redact(attachment.description) }
								: {}),
						})),
					}
				: {}),
		};
	}

	/** Atomically publishes a message's immutable sources before its parent. */
	async createMessageMemory(memory: Memory, unique?: boolean): Promise<UUID> {
		const id = memory.id ?? (uuidv4() as UUID);
		const parent: Memory & { id: UUID } = {
			...memory,
			agentId: memory.agentId ?? this.runtime.agentId,
			id,
			...(unique !== undefined ? { unique } : {}),
			content: this.redactMessageContentForStorage(memory.content),
		};
		const projection = buildMessageContentProjection(parent);
		const projectedParent = { ...parent, content: projection.content };
		const publish = this.runtime.adapter.publishMessageContentSegments;
		if (
			!publish ||
			this.runtime.adapter.messageContentSegmentCapability !== 1
		) {
			if (projection.segments.length > 0) {
				throw new ElizaError(
					"Database adapter cannot publish bounded message content",
					{
						code: "MESSAGE_CONTENT_SEGMENT_STORAGE_UNAVAILABLE",
						context: { messageId: id },
					},
				);
			}
			return this.createMemory(projectedParent, "messages", unique);
		}
		const result = await publish.call(this.runtime.adapter, {
			mode: "create",
			parent: projectedParent,
			segments: projection.segments,
		});
		if (result.status !== "created") {
			// Hosts can durably admit the incoming message before assistant ingress.
			// Accept only an exact replay, never a collision with different evidence.
			const existing = await this.runtime.adapter.getMemoriesByIds(
				[id],
				"messages",
			);
			const sameEvidence = (
				stored: Memory | undefined,
				expected: Memory,
			): boolean =>
				stored !== undefined &&
				stored.id === expected.id &&
				stored.agentId === expected.agentId &&
				stored.roomId === expected.roomId &&
				stored.entityId === expected.entityId &&
				// Adapters assign timestamps when callers omit them.
				(expected.createdAt === undefined ||
					stored.createdAt === expected.createdAt) &&
				isDeepStrictEqual(stored.metadata ?? {}, expected.metadata ?? {}) &&
				isDeepStrictEqual(stored.content, expected.content);
			if (sameEvidence(existing[0], projectedParent)) {
				const segments = projection.segments.length
					? await this.runtime.adapter.getMemoriesByIds(
							projection.segments.map((segment) => segment.id as UUID),
							"message_content_segments",
						)
					: [];
				if (
					projection.segments.every((segment) => {
						const stored = segments.find((entry) => entry.id === segment.id);
						return sameEvidence(stored, segment);
					})
				)
					return id;
			}

			throw new ElizaError("Message content publication conflicted", {
				code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT",
				context: { messageId: id },
			});
		}
		this.host.roomMessagesMemo().invalidate(parent.roomId);
		await this.runtime.applyPipelineHooks(
			"after_memory_persisted",
			afterMemoryPersistedPipelineHookContext(projectedParent, "messages", id),
		);
		return id;
	}

	/** Compare-and-swap replacement that preserves manifest-last publication. */
	async replaceMessageMemoryContent(id: UUID, content: Content): Promise<void> {
		const existing = await this.runtime.getMemoryById(id);
		if (!existing) {
			throw new ElizaError("Message memory was not found", {
				code: "MESSAGE_CONTENT_PARENT_NOT_FOUND",
				context: { messageId: id },
			});
		}
		const replacement: Memory & { id: UUID } = {
			...existing,
			id,
			content: this.redactMessageContentForStorage(content),
		};
		const projection = buildMessageContentProjection(replacement);
		const oldSegmentIds = collectMessageContentSegmentIds(id, existing.content);
		const retainedIds = new Set(
			collectMessageContentSegmentIds(id, projection.content).map(String),
		);
		const oldIds = new Set(oldSegmentIds.map(String));
		const removeSegmentIds = oldSegmentIds.filter(
			(segmentId) => !retainedIds.has(String(segmentId)),
		);
		const newSegments = projection.segments.filter(
			(segment) => !oldIds.has(String(segment.id)),
		);
		const publish = this.runtime.adapter.publishMessageContentSegments;
		if (
			!publish ||
			this.runtime.adapter.messageContentSegmentCapability !== 1
		) {
			if (
				newSegments.length > 0 ||
				messageContentRequiresSegments(existing.content)
			) {
				throw new ElizaError(
					"Database adapter cannot replace bounded message content",
					{
						code: "MESSAGE_CONTENT_SEGMENT_STORAGE_UNAVAILABLE",
						context: { messageId: id },
					},
				);
			}
			await this.updateMemory({ id, content: projection.content });
			return;
		}
		const result = await this.mutateSourceEvidence(
			[id],
			[{ id, content: projection.content }],
			() =>
				publish.call(this.runtime.adapter, {
					mode: "replace",
					agentId: this.runtime.agentId,
					messageId: id,
					expectedContent: existing.content,
					replacementContent: projection.content,
					segments: newSegments,
					removeSegmentIds,
				}),
		);
		if (result.status === "not_found") {
			throw new ElizaError("Message memory was not found", {
				code: "MESSAGE_CONTENT_PARENT_NOT_FOUND",
				context: { messageId: id },
			});
		}
		if (result.status !== "updated") {
			throw new ElizaError("Message content replacement conflicted", {
				code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT",
				context: { messageId: id },
			});
		}
		this.host.roomMessagesMemo().invalidate(existing.roomId);
	}

	// WHY createMemory is special: it performs secret redaction before
	// delegating to the adapter. This is the ONLY place where API keys,
	// tokens, and other secrets are scrubbed from memory content. Internal
	// runtime code deliberately calls this wrapper (not adapter.createMemories
	// directly) to ensure redaction always happens.
	async createMemory(
		memory: Memory,
		tableName: string,
		unique?: boolean,
	): Promise<UUID> {
		if (unique !== undefined) memory.unique = unique;
		// Match SQL's default ownership in every adapter, including the ephemeral
		// fallback, so omitted caller identity still produces a scoped source.
		memory = { ...memory, agentId: memory.agentId ?? this.runtime.agentId };

		// Redact any secrets from memory content before storing
		const secrets = this.host.getSecretsForRedaction();
		if (Object.keys(secrets).length > 0 && memory.content.text) {
			memory = {
				...memory,
				content: {
					...memory.content,
					text: redactWithSecrets(memory.content.text, {
						secrets,
						applyPatterns: true,
					}),
				},
			};
		}

		// Facts are structurally deduped at write time: when an equivalent row
		// (same normalized text + room + entity) already exists, skip the insert
		// and hand back the existing id. The adapter cannot do this — its
		// similarity check needs an embedding (absent inline on fact writes) and
		// is bypassed whenever callers pass `unique` — so without this guard the
		// same claim lands as multiple rows (see runtime/fact-write-dedupe.ts).
		// A dedupe hit may still carry new information: stronger metadata on the
		// incoming occurrence (higher confidence, an explicit kind, a fresher
		// validity timestamp) upgrades the kept row instead of being dropped.
		if (tableName === "facts") {
			const equivalent = await findEquivalentFact(this.runtime, memory);
			if (equivalent?.id) {
				const upgraded = mergeStrongerFactMetadata(equivalent, memory);
				if (upgraded) {
					await this.updateMemory({ id: equivalent.id, metadata: upgraded });
				}
				return equivalent.id;
			}
		}

		const ids = await this.runtime.adapter.createMemories([
			{ memory, tableName, unique },
		]);
		// The intake path persists the user message immediately before
		// composeState reads the room window; busting the key here makes the
		// coalesced messages-scan self-enforcing — a stale window can never
		// drop the message currently being answered.
		if (tableName === "messages" && memory.roomId) {
			this.host.roomMessagesMemo().invalidate(memory.roomId);
		}
		const memoryId = ids[0];
		await this.runtime.applyPipelineHooks(
			"after_memory_persisted",
			afterMemoryPersistedPipelineHookContext(memory, tableName, memoryId),
		);
		return memoryId;
	}

	async updateMemory(
		memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata },
	): Promise<boolean> {
		await this.updateMemories([memory]);
		return true; // Successfully updated if no error thrown
	}

	async deleteMemory(memoryId: UUID): Promise<void> {
		await this.deleteMemories([memoryId]);
	}

	// ── Participant passthroughs & wrappers ──────────────────────────────
	async deleteParticipants(
		participants: Array<{ entityId: UUID; roomId: UUID }>,
	): Promise<boolean> {
		const deleted = await this.runtime.adapter.deleteParticipants(participants);
		this.host.invalidateTurnEntityDetails();
		return deleted;
	}

	async updateParticipants(
		participants: Array<{
			entityId: UUID;
			roomId: UUID;
			updates: Partial<Participant>;
		}>,
	): Promise<void> {
		await this.runtime.adapter.updateParticipants(participants);
		this.host.invalidateTurnEntityDetails();
	}

	async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
		const deleted = await this.runtime.adapter.deleteParticipants([
			{ entityId, roomId },
		]);
		this.host.invalidateTurnEntityDetails();
		return deleted;
	}

	// ── Room passthroughs & wrappers ────────────────────────────────────
	async updateRooms(rooms: Room[]): Promise<void> {
		await this.runtime.adapter.updateRooms(rooms);
		for (const room of rooms) {
			if (room.id) this.host.roomReadMemo().invalidate(room.id);
		}
	}

	async deleteRooms(roomIds: UUID[]): Promise<void> {
		await this.runtime.adapter.deleteRooms(roomIds);
		for (const roomId of roomIds) {
			this.host.roomReadMemo().invalidate(roomId);
			this.host.roomMessagesMemo().invalidate(roomId);
		}
	}

	// Single-item room wrappers
	async updateRoom(room: Room): Promise<void> {
		return this.updateRooms([room]);
	}

	async deleteRoom(roomId: UUID): Promise<void> {
		return this.deleteRooms([roomId]);
	}

	// ── Batch pass-throughs required by IDatabaseAdapter ────────────────

	async deleteRoomsByWorldIds(worldIds: UUID[]): Promise<void> {
		await this.runtime.adapter.deleteRoomsByWorldIds(worldIds);
		// Room ids under these worlds are unknown here; drop everything.
		this.host.roomReadMemo().invalidate();
		this.host.roomMessagesMemo().invalidate();
	}
}
