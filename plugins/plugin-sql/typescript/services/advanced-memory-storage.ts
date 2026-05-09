import {
  ChannelType,
  type IAgentRuntime,
  type JsonValue,
  type Memory,
  type MemoryMetadata,
  type MemoryStorageProvider,
  type Room,
  Service,
  type ServiceTypeName,
  type UUID,
  type World,
} from "@elizaos/core";
import { stringToUuid } from "../utils/string-to-uuid";

/** Plugin-registered service; widen core ServiceTypeName for dynamic keys. */
const ENTITY_RESOLUTION_SERVICE = "entity_resolution" as ServiceTypeName;

type LongTermMemoryRecord = Awaited<ReturnType<MemoryStorageProvider["storeLongTermMemory"]>>;
type LongTermMemoryInput = Parameters<MemoryStorageProvider["storeLongTermMemory"]>[0];
type LongTermMemoryCategory = LongTermMemoryRecord["category"];
type SessionSummaryRecord = Awaited<ReturnType<MemoryStorageProvider["storeSessionSummary"]>>;
type SessionSummaryInput = Parameters<MemoryStorageProvider["storeSessionSummary"]>[0];
type UnknownRecord = Record<string, unknown>;
type JsonRecord = Record<string, JsonValue>;

type EntityLink = {
  entityA: UUID;
  entityB: UUID;
  status?: string;
};

type EntityResolutionService = {
  getConfirmedLinks: (entityId: UUID) => Promise<EntityLink[]>;
};

function isEntityResolutionService(service: unknown): service is EntityResolutionService {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as { getConfirmedLinks?: unknown }).getConfirmedLinks === "function"
  );
}

type AdvancedMemoryEnvelope = {
  kind: "long_term_memory" | "session_summary";
  originalEntityId?: UUID;
  anchorEntityId?: UUID;
  category?: LongTermMemoryCategory;
  confidence?: number;
  source?: string;
  semanticMetadata?: JsonRecord;
  messageCount?: number;
  lastMessageOffset?: number;
  startTime?: string;
  endTime?: string;
  topics?: string[];
  summaryMetadata?: JsonRecord;
  updatedAt?: string;
  lastAccessedAt?: string;
  accessCount?: number;
};

const LONG_TERM_MEMORY_TABLE = "long_term_memories";
const SESSION_SUMMARY_TABLE = "session_summaries";
const ADVANCED_MEMORY_SOURCE = "advanced-memory";

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => toJsonValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
  }

  if (isRecord(value)) {
    const entries = Object.entries(value)
      .map(([key, entry]) => {
        const jsonValue = toJsonValue(entry);
        return jsonValue === undefined ? null : ([key, jsonValue] as const);
      })
      .filter((entry): entry is readonly [string, JsonValue] => entry !== null);
    return Object.fromEntries(entries) as JsonRecord;
  }

  return undefined;
}

function toJsonRecord(value: unknown): JsonRecord | undefined {
  const jsonValue = toJsonValue(value);
  return isRecord(jsonValue) ? (jsonValue as JsonRecord) : undefined;
}

function buildCustomMemoryMetadata(params: {
  scope: "shared" | "room";
  timestamp: number;
  source?: string;
  advancedMemory: JsonRecord;
  existing?: UnknownRecord | null;
}): MemoryMetadata {
  const metadata: MemoryMetadata = {
    ...(params.existing ?? {}),
    type: "custom",
    scope: params.scope,
    timestamp: params.timestamp,
    advancedMemory: params.advancedMemory,
  };

  if (params.source) {
    metadata.source = params.source;
  }

  return metadata;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((entry): entry is string => typeof entry === "string");
  return values.length > 0 ? values : undefined;
}

function toDate(value: unknown, fallback?: Date): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return fallback ?? new Date();
}

function getMemoryText(memory: Memory): string {
  return typeof memory.content?.text === "string" ? memory.content.text : "";
}

function getAdvancedMemoryEnvelope(memory: Memory): AdvancedMemoryEnvelope | null {
  const metadata = asRecord(memory.metadata);
  const advancedMemory = asRecord(metadata?.advancedMemory);
  if (!advancedMemory) {
    return null;
  }
  const kind = asString(advancedMemory.kind);
  if (kind !== "long_term_memory" && kind !== "session_summary") {
    return null;
  }

  return {
    kind,
    originalEntityId: asString(advancedMemory.originalEntityId) as UUID | undefined,
    anchorEntityId: asString(advancedMemory.anchorEntityId) as UUID | undefined,
    category: asString(advancedMemory.category) as LongTermMemoryCategory | undefined,
    confidence: asNumber(advancedMemory.confidence),
    source: asString(advancedMemory.source),
    semanticMetadata: toJsonRecord(advancedMemory.semanticMetadata),
    messageCount: asNumber(advancedMemory.messageCount),
    lastMessageOffset: asNumber(advancedMemory.lastMessageOffset),
    startTime: asString(advancedMemory.startTime),
    endTime: asString(advancedMemory.endTime),
    topics: asStringArray(advancedMemory.topics),
    summaryMetadata: toJsonRecord(advancedMemory.summaryMetadata),
    updatedAt: asString(advancedMemory.updatedAt),
    lastAccessedAt: asString(advancedMemory.lastAccessedAt),
    accessCount: asNumber(advancedMemory.accessCount),
  };
}

export class AdvancedMemoryStorageService extends Service implements MemoryStorageProvider {
  static serviceType = "memoryStorage" as const;

  capabilityDescription = "Persistent advanced-memory storage backed by SQL memory tables";

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    return service;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
  }

  async stop(): Promise<void> {}

  private getMemoryWorldId(): UUID {
    return stringToUuid(`advanced-memory:world:${this.runtime.agentId}`);
  }

  private getLongTermRoomId(entityId: UUID): UUID {
    return stringToUuid(`advanced-memory:long-term:${this.runtime.agentId}:${entityId}`);
  }

  private async ensureMemoryWorld(): Promise<UUID> {
    const worldId = this.getMemoryWorldId();
    const world: World = {
      id: worldId,
      agentId: this.runtime.agentId,
      name: "Advanced Memory",
      metadata: {
        purpose: ADVANCED_MEMORY_SOURCE,
      },
      createdAt: new Date(),
    } as World & { createdAt: Date };
    await this.runtime.ensureWorldExists(world);
    return worldId;
  }

  private async ensureLongTermRoom(entityId: UUID, worldId: UUID): Promise<UUID> {
    const roomId = this.getLongTermRoomId(entityId);
    const room: Room = {
      id: roomId,
      agentId: this.runtime.agentId,
      worldId,
      source: ADVANCED_MEMORY_SOURCE,
      type: ChannelType.SELF,
      name: `Advanced Memory ${entityId.slice(0, 8)}`,
      metadata: {
        purpose: "long_term_memory",
        entityId,
      },
      createdAt: new Date(),
    } as Room & { createdAt: Date };
    await this.runtime.ensureRoomExists(room);
    return roomId;
  }

  private async getEntityResolutionService(): Promise<EntityResolutionService | null> {
    const existing = this.runtime.getService(ENTITY_RESOLUTION_SERVICE);
    if (isEntityResolutionService(existing)) {
      return existing;
    }
    if (!this.runtime.hasService(ENTITY_RESOLUTION_SERVICE)) {
      return null;
    }
    try {
      const loaded = await this.runtime.getServiceLoadPromise(ENTITY_RESOLUTION_SERVICE);
      return isEntityResolutionService(loaded) ? loaded : null;
    } catch {
      return null;
    }
  }

  private async getIdentityGroup(entityId: UUID): Promise<Set<UUID>> {
    const resolution = await this.getEntityResolutionService();
    if (!resolution) {
      return new Set<UUID>([entityId]);
    }

    const group = new Set<UUID>([entityId]);
    const queue: UUID[] = [entityId];

    while (queue.length > 0) {
      const current = queue.shift() as UUID;
      const links = await resolution.getConfirmedLinks(current);
      for (const link of links) {
        const other = link.entityA === current ? link.entityB : link.entityA;
        if (!group.has(other)) {
          group.add(other);
          queue.push(other);
        }
      }
    }

    return group;
  }

  private async getAnchorEntityId(entityId: UUID): Promise<UUID> {
    const group = await this.getIdentityGroup(entityId);
    return Array.from(group).sort()[0] as UUID;
  }

  private parseLongTermMemory(memory: Memory): LongTermMemoryRecord | null {
    const envelope = getAdvancedMemoryEnvelope(memory);
    if (!envelope || envelope.kind !== "long_term_memory" || !memory.id || !memory.agentId) {
      return null;
    }

    return {
      id: memory.id,
      agentId: memory.agentId,
      entityId: envelope.originalEntityId ?? envelope.anchorEntityId ?? (memory.entityId as UUID),
      category: (envelope.category ?? "semantic") as LongTermMemoryCategory,
      content: getMemoryText(memory),
      metadata: envelope.semanticMetadata,
      embedding: Array.isArray(memory.embedding) ? memory.embedding : undefined,
      confidence: envelope.confidence,
      source: envelope.source,
      createdAt: toDate(memory.createdAt),
      updatedAt: toDate(envelope.updatedAt, toDate(memory.createdAt)),
      lastAccessedAt: envelope.lastAccessedAt ? toDate(envelope.lastAccessedAt) : undefined,
      accessCount: envelope.accessCount ?? 0,
    };
  }

  private parseSessionSummary(memory: Memory): SessionSummaryRecord | null {
    const envelope = getAdvancedMemoryEnvelope(memory);
    if (
      !envelope ||
      envelope.kind !== "session_summary" ||
      !memory.id ||
      !memory.agentId ||
      !memory.roomId
    ) {
      return null;
    }

    return {
      id: memory.id,
      agentId: memory.agentId,
      roomId: memory.roomId,
      entityId: envelope.originalEntityId ?? (memory.entityId as UUID | undefined),
      summary: getMemoryText(memory),
      messageCount: envelope.messageCount ?? 0,
      lastMessageOffset: envelope.lastMessageOffset ?? 0,
      startTime: toDate(envelope.startTime, toDate(memory.createdAt)),
      endTime: toDate(envelope.endTime, toDate(memory.createdAt)),
      topics: envelope.topics,
      metadata: envelope.summaryMetadata,
      embedding: Array.isArray(memory.embedding) ? memory.embedding : undefined,
      createdAt: toDate(memory.createdAt),
      updatedAt: toDate(envelope.updatedAt, toDate(memory.createdAt)),
    };
  }

  private sortLongTermMemories(memories: LongTermMemoryRecord[]): LongTermMemoryRecord[] {
    return [...memories].sort((left, right) => {
      const leftUpdated = left.updatedAt.getTime();
      const rightUpdated = right.updatedAt.getTime();
      if (rightUpdated !== leftUpdated) {
        return rightUpdated - leftUpdated;
      }
      const leftConfidence = left.confidence ?? 0;
      const rightConfidence = right.confidence ?? 0;
      if (rightConfidence !== leftConfidence) {
        return rightConfidence - leftConfidence;
      }
      return right.createdAt.getTime() - left.createdAt.getTime();
    });
  }

  private sortSessionSummaries(summaries: SessionSummaryRecord[]): SessionSummaryRecord[] {
    return [...summaries].sort((left, right) => {
      const leftUpdated = left.updatedAt.getTime();
      const rightUpdated = right.updatedAt.getTime();
      if (rightUpdated !== leftUpdated) {
        return rightUpdated - leftUpdated;
      }
      return right.createdAt.getTime() - left.createdAt.getTime();
    });
  }

  async storeLongTermMemory(memory: LongTermMemoryInput): Promise<LongTermMemoryRecord> {
    const now = new Date();
    const anchorEntityId = await this.getAnchorEntityId(memory.entityId);
    const worldId = await this.ensureMemoryWorld();
    const roomId = await this.ensureLongTermRoom(anchorEntityId, worldId);
    const advancedMemory = toJsonRecord({
      kind: "long_term_memory",
      originalEntityId: memory.entityId,
      anchorEntityId,
      category: memory.category,
      confidence: memory.confidence,
      source: memory.source,
      semanticMetadata: memory.metadata,
      updatedAt: now.toISOString(),
      accessCount: 0,
    });
    if (!advancedMemory) {
      throw new Error("Long-term memory metadata is not JSON-serializable");
    }
    const id = await this.runtime.createMemory(
      {
        agentId: this.runtime.agentId,
        entityId: anchorEntityId,
        roomId,
        worldId,
        content: { text: memory.content },
        metadata: buildCustomMemoryMetadata({
          scope: "shared",
          timestamp: now.getTime(),
          source: memory.source,
          advancedMemory,
        }),
        embedding: memory.embedding,
        createdAt: now.getTime(),
        unique: false,
      },
      LONG_TERM_MEMORY_TABLE,
      false
    );

    const stored = await this.runtime.getMemoryById(id);
    const parsed = stored ? this.parseLongTermMemory(stored) : null;
    if (!parsed) {
      throw new Error("Failed to persist long-term memory");
    }
    return parsed;
  }

  async getLongTermMemories(
    agentId: UUID,
    entityId: UUID,
    opts?: { category?: LongTermMemoryCategory; limit?: number }
  ): Promise<LongTermMemoryRecord[]> {
    const group = await this.getIdentityGroup(entityId);
    const roomIds = Array.from(group).map((memberEntityId) =>
      this.getLongTermRoomId(memberEntityId)
    );
    if (roomIds.length === 0) {
      return [];
    }

    const memories = await this.runtime.getMemoriesByRoomIds({
      tableName: LONG_TERM_MEMORY_TABLE,
      roomIds,
      limit: Math.max((opts?.limit ?? 20) * roomIds.length * 4, 80),
    });

    const filtered = memories
      .filter((memory) => memory.agentId === agentId)
      .map((memory) => this.parseLongTermMemory(memory))
      .filter((memory): memory is LongTermMemoryRecord => memory !== null)
      .filter((memory) => (opts?.category ? memory.category === opts.category : true));

    return this.sortLongTermMemories(filtered).slice(0, opts?.limit ?? 20);
  }

  async updateLongTermMemory(
    id: UUID,
    agentId: UUID,
    entityId: UUID,
    updates: Partial<Omit<LongTermMemoryRecord, "id" | "agentId" | "entityId" | "createdAt">>
  ): Promise<void> {
    const existing = await this.runtime.getMemoryById(id);
    const parsed = existing ? this.parseLongTermMemory(existing) : null;
    if (!existing || !parsed || existing.agentId !== agentId) {
      throw new Error(`Long-term memory ${id} not found`);
    }

    const allowedGroup = await this.getIdentityGroup(entityId);
    if (!allowedGroup.has(parsed.entityId)) {
      throw new Error(`Long-term memory ${id} does not belong to entity ${entityId}`);
    }

    const currentEnvelope = getAdvancedMemoryEnvelope(existing);
    const updatedAt = new Date();
    const advancedMemory = toJsonRecord({
      ...(currentEnvelope ?? {}),
      kind: "long_term_memory",
      originalEntityId: currentEnvelope?.originalEntityId ?? entityId,
      anchorEntityId: parsed.entityId,
      category: updates.category ?? parsed.category,
      confidence: updates.confidence ?? parsed.confidence,
      source: updates.source ?? parsed.source,
      semanticMetadata: updates.metadata ?? parsed.metadata,
      updatedAt: updatedAt.toISOString(),
      lastAccessedAt: updates.lastAccessedAt?.toISOString(),
      accessCount: updates.accessCount ?? parsed.accessCount ?? 0,
    });
    if (!advancedMemory) {
      throw new Error("Updated long-term memory metadata is not JSON-serializable");
    }
    await this.runtime.updateMemory({
      id,
      content: {
        text: updates.content ?? parsed.content,
      },
      metadata: buildCustomMemoryMetadata({
        existing: asRecord(existing.metadata),
        scope: "shared",
        timestamp: updatedAt.getTime(),
        source: updates.source ?? parsed.source,
        advancedMemory,
      }),
      ...(updates.embedding ? { embedding: updates.embedding } : {}),
    });
  }

  async deleteLongTermMemory(id: UUID, agentId: UUID, entityId: UUID): Promise<void> {
    const existing = await this.runtime.getMemoryById(id);
    const parsed = existing ? this.parseLongTermMemory(existing) : null;
    if (!existing || !parsed || existing.agentId !== agentId) {
      throw new Error(`Long-term memory ${id} not found`);
    }
    const allowedGroup = await this.getIdentityGroup(entityId);
    if (!allowedGroup.has(parsed.entityId)) {
      throw new Error(`Long-term memory ${id} does not belong to entity ${entityId}`);
    }
    await this.runtime.deleteMemory(id);
  }

  async storeSessionSummary(summary: SessionSummaryInput): Promise<SessionSummaryRecord> {
    const now = new Date();
    const advancedMemory = toJsonRecord({
      kind: "session_summary",
      originalEntityId: summary.entityId,
      messageCount: summary.messageCount,
      lastMessageOffset: summary.lastMessageOffset,
      startTime: summary.startTime.toISOString(),
      endTime: summary.endTime.toISOString(),
      topics: summary.topics,
      summaryMetadata: summary.metadata,
      updatedAt: now.toISOString(),
    });
    if (!advancedMemory) {
      throw new Error("Session summary metadata is not JSON-serializable");
    }
    const id = await this.runtime.createMemory(
      {
        agentId: this.runtime.agentId,
        entityId: summary.entityId ?? this.runtime.agentId,
        roomId: summary.roomId,
        worldId: this.getMemoryWorldId(),
        content: { text: summary.summary },
        metadata: buildCustomMemoryMetadata({
          scope: "room",
          timestamp: now.getTime(),
          advancedMemory,
        }),
        embedding: summary.embedding,
        createdAt: now.getTime(),
        unique: false,
      },
      SESSION_SUMMARY_TABLE,
      false
    );

    const stored = await this.runtime.getMemoryById(id);
    const parsed = stored ? this.parseSessionSummary(stored) : null;
    if (!parsed) {
      throw new Error("Failed to persist session summary");
    }
    return parsed;
  }

  async getCurrentSessionSummary(
    agentId: UUID,
    roomId: UUID
  ): Promise<SessionSummaryRecord | null> {
    const summaries = await this.getSessionSummaries(agentId, roomId, 1);
    return summaries[0] ?? null;
  }

  async updateSessionSummary(
    id: UUID,
    agentId: UUID,
    roomId: UUID,
    updates: Partial<
      Omit<SessionSummaryRecord, "id" | "agentId" | "roomId" | "createdAt" | "updatedAt">
    >
  ): Promise<void> {
    const existing = await this.runtime.getMemoryById(id);
    const parsed = existing ? this.parseSessionSummary(existing) : null;
    if (!existing || !parsed || existing.agentId !== agentId || existing.roomId !== roomId) {
      throw new Error(`Session summary ${id} not found`);
    }

    const currentEnvelope = getAdvancedMemoryEnvelope(existing);
    const updatedAt = new Date();
    const advancedMemory = toJsonRecord({
      ...(currentEnvelope ?? {}),
      kind: "session_summary",
      originalEntityId: currentEnvelope?.originalEntityId ?? parsed.entityId,
      messageCount: updates.messageCount ?? parsed.messageCount,
      lastMessageOffset: updates.lastMessageOffset ?? parsed.lastMessageOffset,
      startTime: (updates.startTime ?? parsed.startTime).toISOString(),
      endTime: (updates.endTime ?? parsed.endTime).toISOString(),
      topics: updates.topics ?? parsed.topics,
      summaryMetadata: updates.metadata ?? parsed.metadata,
      updatedAt: updatedAt.toISOString(),
    });
    if (!advancedMemory) {
      throw new Error("Updated session summary metadata is not JSON-serializable");
    }
    await this.runtime.updateMemory({
      id,
      content: {
        text: updates.summary ?? parsed.summary,
      },
      metadata: buildCustomMemoryMetadata({
        existing: asRecord(existing.metadata),
        scope: "room",
        timestamp: updatedAt.getTime(),
        advancedMemory,
      }),
      ...(updates.embedding ? { embedding: updates.embedding } : {}),
    });
  }

  async getSessionSummaries(
    agentId: UUID,
    roomId: UUID,
    limit = 5
  ): Promise<SessionSummaryRecord[]> {
    if (limit <= 0) {
      return [];
    }
    const memories = await this.runtime.getMemories({
      agentId,
      roomId,
      tableName: SESSION_SUMMARY_TABLE,
      count: Math.max(limit * 4, 20),
      unique: false,
    });

    return this.sortSessionSummaries(
      memories
        .map((memory) => this.parseSessionSummary(memory))
        .filter((memory): memory is SessionSummaryRecord => memory !== null)
    ).slice(0, limit);
  }
}
