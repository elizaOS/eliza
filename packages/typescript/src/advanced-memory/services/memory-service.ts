import { and, desc, eq, type SQL } from "drizzle-orm";
import type { PgTable, TableConfig } from "drizzle-orm/pg-core";
import { logger } from "../../logger.ts";
import {
  type IAgentRuntime,
  Service,
  type ServiceTypeName,
  type UUID,
} from "../../types/index.ts";
import { longTermMemories, sessionSummaries } from "../schemas/index.ts";
import type {
  JsonValue,
  LongTermMemory,
  LongTermMemoryCategory,
  MemoryConfig,
  SessionSummary,
} from "../types.ts";

type DbPrimitive = string | number | boolean | null | Date;
type DbValue = DbPrimitive | DbValue[] | { [key: string]: DbValue };

function requireSql(condition: SQL | undefined, context: string): SQL {
  if (!condition) {
    throw new Error(`Missing SQL condition: ${context}`);
  }
  return condition;
}

interface DrizzleDb {
  insert<T extends PgTable<TableConfig>>(
    table: T,
  ): {
    values(data: Record<string, DbValue>): Promise<void>;
  };
  select<T extends Record<string, DbValue>>(
    columns?: T,
  ): {
    from<TTable extends PgTable<TableConfig>>(
      table: TTable,
    ): {
      where(condition: SQL): {
        orderBy(...args: SQL[]): {
          limit(n: number): Promise<Array<Record<string, DbValue>>>;
        };
      };
    };
  };
  update<T extends PgTable<TableConfig>>(
    table: T,
  ): {
    set(data: Record<string, DbValue>): {
      where(condition: SQL): Promise<void>;
    };
  };
  delete<T extends PgTable<TableConfig>>(
    table: T,
  ): {
    where(condition: SQL): Promise<void>;
  };
}

export class MemoryService extends Service {
  static serviceType: ServiceTypeName = "memory" as ServiceTypeName;

  private sessionMessageCounts: Map<UUID, number>;
  private memoryConfig: MemoryConfig;
  private lastExtractionCheckpoints: Map<string, number>;

  capabilityDescription =
    "Memory management with short-term summarization and long-term persistent facts";

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.sessionMessageCounts = new Map();
    this.lastExtractionCheckpoints = new Map();
    this.memoryConfig = {
      shortTermSummarizationThreshold: 16,
      shortTermRetainRecent: 6,
      shortTermSummarizationInterval: 10,
      longTermExtractionEnabled: true,
      longTermVectorSearchEnabled: false,
      longTermConfidenceThreshold: 0.85,
      longTermExtractionThreshold: 30,
      longTermExtractionInterval: 10,
      summaryModelType: "TEXT_LARGE",
      summaryMaxTokens: 2500,
      summaryMaxNewMessages: 20,
    };
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new MemoryService(runtime);
    await service.initialize(runtime);
    return service;
  }

  async stop(): Promise<void> {
    logger.info({ src: "service:memory" }, "MemoryService stopped");
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;

    const threshold = runtime.getSetting("MEMORY_SUMMARIZATION_THRESHOLD");
    if (threshold) {
      this.memoryConfig.shortTermSummarizationThreshold = Number.parseInt(
        String(threshold),
        10,
      );
    }

    const retainRecent = runtime.getSetting("MEMORY_RETAIN_RECENT");
    if (retainRecent) {
      this.memoryConfig.shortTermRetainRecent = Number.parseInt(
        String(retainRecent),
        10,
      );
    }

    const summarizationInterval = runtime.getSetting(
      "MEMORY_SUMMARIZATION_INTERVAL",
    );
    if (summarizationInterval) {
      this.memoryConfig.shortTermSummarizationInterval = Number.parseInt(
        String(summarizationInterval),
        10,
      );
    }

    const maxNewMessages = runtime.getSetting("MEMORY_MAX_NEW_MESSAGES");
    if (maxNewMessages) {
      this.memoryConfig.summaryMaxNewMessages = Number.parseInt(
        String(maxNewMessages),
        10,
      );
    }

    const longTermEnabled = runtime.getSetting("MEMORY_LONG_TERM_ENABLED");
    if (longTermEnabled === "false" || longTermEnabled === false) {
      this.memoryConfig.longTermExtractionEnabled = false;
    } else if (longTermEnabled === "true" || longTermEnabled === true) {
      this.memoryConfig.longTermExtractionEnabled = true;
    }

    const confidenceThreshold = runtime.getSetting(
      "MEMORY_CONFIDENCE_THRESHOLD",
    );
    if (confidenceThreshold) {
      this.memoryConfig.longTermConfidenceThreshold = Number.parseFloat(
        String(confidenceThreshold),
      );
    }

    const extractionThreshold = runtime.getSetting(
      "MEMORY_EXTRACTION_THRESHOLD",
    );
    if (extractionThreshold) {
      this.memoryConfig.longTermExtractionThreshold = Number.parseInt(
        String(extractionThreshold),
        10,
      );
    }

    const extractionInterval = runtime.getSetting("MEMORY_EXTRACTION_INTERVAL");
    if (extractionInterval) {
      this.memoryConfig.longTermExtractionInterval = Number.parseInt(
        String(extractionInterval),
        10,
      );
    }

    logger.debug(
      {
        summarizationThreshold:
          this.memoryConfig.shortTermSummarizationThreshold,
        summarizationInterval: this.memoryConfig.shortTermSummarizationInterval,
        maxNewMessages: this.memoryConfig.summaryMaxNewMessages,
        retainRecent: this.memoryConfig.shortTermRetainRecent,
        longTermEnabled: this.memoryConfig.longTermExtractionEnabled,
        extractionThreshold: this.memoryConfig.longTermExtractionThreshold,
        extractionInterval: this.memoryConfig.longTermExtractionInterval,
        confidenceThreshold: this.memoryConfig.longTermConfidenceThreshold,
      },
      "MemoryService initialized",
      { src: "service:memory" },
    );
  }

  private getDb(): DrizzleDb {
    const db = (this.runtime as IAgentRuntime & { db?: DrizzleDb }).db;
    if (!db) {
      throw new Error("Database not available");
    }
    return db;
  }

  getConfig(): MemoryConfig {
    return { ...this.memoryConfig };
  }

  updateConfig(updates: Partial<MemoryConfig>): void {
    this.memoryConfig = { ...this.memoryConfig, ...updates };
  }

  incrementMessageCount(roomId: UUID): number {
    const current = this.sessionMessageCounts.get(roomId) || 0;
    const newCount = current + 1;
    this.sessionMessageCounts.set(roomId, newCount);
    return newCount;
  }

  resetMessageCount(roomId: UUID): void {
    this.sessionMessageCounts.set(roomId, 0);
  }

  async shouldSummarize(roomId: UUID): Promise<boolean> {
    const count = await this.runtime.countMemories(roomId, false, "messages");
    return count >= this.memoryConfig.shortTermSummarizationThreshold;
  }

  private getExtractionKey(entityId: UUID, roomId: UUID): string {
    return `memory:extraction:${entityId}:${roomId}`;
  }

  async getLastExtractionCheckpoint(
    entityId: UUID,
    roomId: UUID,
  ): Promise<number> {
    const key = this.getExtractionKey(entityId, roomId);

    const cached = this.lastExtractionCheckpoints.get(key);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const checkpoint = await this.runtime.getCache<number>(key);
      const messageCount = checkpoint ?? 0;
      this.lastExtractionCheckpoints.set(key, messageCount);
      return messageCount;
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.warn(
        { src: "service:memory", err },
        "Failed to get extraction checkpoint from cache",
      );
      return 0;
    }
  }

  async setLastExtractionCheckpoint(
    entityId: UUID,
    roomId: UUID,
    messageCount: number,
  ): Promise<void> {
    const key = this.getExtractionKey(entityId, roomId);
    this.lastExtractionCheckpoints.set(key, messageCount);

    try {
      await this.runtime.setCache(key, messageCount);
      logger.debug(
        { src: "service:memory" },
        `Set extraction checkpoint for ${entityId} in room ${roomId} at count ${messageCount}`,
      );
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error(
        { src: "service:memory", err },
        "Failed to persist extraction checkpoint to cache",
      );
    }
  }

  async shouldRunExtraction(
    entityId: UUID,
    roomId: UUID,
    currentMessageCount: number,
  ): Promise<boolean> {
    const threshold = this.memoryConfig.longTermExtractionThreshold;
    const interval = this.memoryConfig.longTermExtractionInterval;

    if (currentMessageCount < threshold) {
      return false;
    }

    const lastCheckpoint = await this.getLastExtractionCheckpoint(
      entityId,
      roomId,
    );
    const currentCheckpoint =
      Math.floor(currentMessageCount / interval) * interval;
    const shouldRun =
      currentMessageCount >= threshold && currentCheckpoint > lastCheckpoint;

    logger.debug(
      {
        entityId,
        roomId,
        currentMessageCount,
        threshold,
        interval,
        lastCheckpoint,
        currentCheckpoint,
        shouldRun,
      },
      "Extraction check",
      { src: "service:memory" },
    );

    return shouldRun;
  }

  async storeLongTermMemory(
    memory: Omit<
      LongTermMemory,
      "id" | "createdAt" | "updatedAt" | "accessCount"
    >,
  ): Promise<LongTermMemory> {
    const db = this.getDb();

    const id = crypto.randomUUID() as UUID;
    const now = new Date();

    const newMemory: LongTermMemory = {
      id,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      ...memory,
    };

    await db.insert(longTermMemories).values({
      id: newMemory.id,
      agentId: newMemory.agentId,
      entityId: newMemory.entityId,
      category: newMemory.category,
      content: newMemory.content,
      metadata: (newMemory.metadata ?? {}) as Record<string, DbValue>,
      embedding: newMemory.embedding ?? null,
      confidence: newMemory.confidence ?? 1.0,
      source: newMemory.source ?? null,
      accessCount: newMemory.accessCount ?? 0,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: newMemory.lastAccessedAt ?? null,
    });

    logger.info(
      { src: "service:memory" },
      `Stored long-term memory: ${newMemory.category} for entity ${newMemory.entityId}`,
    );
    return newMemory;
  }

  async getLongTermMemories(
    entityId: UUID,
    category?: LongTermMemoryCategory,
    limit = 10,
  ): Promise<LongTermMemory[]> {
    if (limit <= 0) return [];
    const db = this.getDb();

    const conditions: SQL[] = [
      eq(longTermMemories.agentId, this.runtime.agentId),
      eq(longTermMemories.entityId, entityId),
    ];

    if (category) {
      conditions.push(eq(longTermMemories.category, category));
    }

    const whereClause = requireSql(
      and(...conditions),
      "getLongTermMemories(where)",
    );
    const results = await db
      .select()
      .from(longTermMemories)
      .where(whereClause)
      .orderBy(
        desc(longTermMemories.confidence),
        desc(longTermMemories.updatedAt),
      )
      .limit(limit);

    return results.map((row) => ({
      id: row.id as UUID,
      agentId: row.agentId as UUID,
      entityId: row.entityId as UUID,
      category: row.category as LongTermMemoryCategory,
      content: row.content as string,
      metadata: (row.metadata as Record<string, JsonValue>) ?? {},
      embedding: (row.embedding as number[]) ?? [],
      confidence: (row.confidence as number) ?? 1.0,
      source: (row.source as string) ?? "",
      createdAt: row.createdAt as Date,
      updatedAt: row.updatedAt as Date,
      lastAccessedAt: (row.lastAccessedAt as Date) ?? (row.updatedAt as Date),
      accessCount: (row.accessCount as number) ?? 0,
    }));
  }

  async updateLongTermMemory(
    id: UUID,
    entityId: UUID,
    updates: Partial<
      Omit<LongTermMemory, "id" | "agentId" | "entityId" | "createdAt">
    >,
  ): Promise<void> {
    const db = this.getDb();
    const updateData: Record<string, DbValue> = {
      updatedAt: new Date(),
    };

    if (updates.content !== undefined) updateData.content = updates.content;
    if (updates.metadata !== undefined)
      updateData.metadata = updates.metadata as Record<string, DbValue>;
    if (updates.confidence !== undefined)
      updateData.confidence = updates.confidence;
    if (updates.embedding !== undefined)
      updateData.embedding = updates.embedding;
    if (updates.lastAccessedAt !== undefined)
      updateData.lastAccessedAt = updates.lastAccessedAt;
    if (updates.accessCount !== undefined)
      updateData.accessCount = updates.accessCount;

    await db
      .update(longTermMemories)
      .set(updateData)
      .where(
        requireSql(
          and(
            eq(longTermMemories.id, id),
            eq(longTermMemories.agentId, this.runtime.agentId),
            eq(longTermMemories.entityId, entityId),
          ),
          "updateLongTermMemory(where)",
        ),
      );

    logger.info(
      { src: "service:memory" },
      `Updated long-term memory: ${id} for entity ${entityId}`,
    );
  }

  async deleteLongTermMemory(id: UUID, entityId: UUID): Promise<void> {
    const db = this.getDb();
    await db
      .delete(longTermMemories)
      .where(
        requireSql(
          and(
            eq(longTermMemories.id, id),
            eq(longTermMemories.agentId, this.runtime.agentId),
            eq(longTermMemories.entityId, entityId),
          ),
          "deleteLongTermMemory(where)",
        ),
      );
    logger.info(
      { src: "service:memory" },
      `Deleted long-term memory: ${id} for entity ${entityId}`,
    );
  }

  async getCurrentSessionSummary(roomId: UUID): Promise<SessionSummary | null> {
    const db = this.getDb();
    const results = await db
      .select()
      .from(sessionSummaries)
      .where(
        requireSql(
          and(
            eq(sessionSummaries.agentId, this.runtime.agentId),
            eq(sessionSummaries.roomId, roomId),
          ),
          "getCurrentSessionSummary(where)",
        ),
      )
      .orderBy(desc(sessionSummaries.updatedAt))
      .limit(1);

    if (results.length === 0) return null;
    const row = results[0];
    return {
      id: row.id as UUID,
      agentId: row.agentId as UUID,
      roomId: row.roomId as UUID,
      entityId: (row.entityId as UUID) || undefined,
      summary: row.summary as string,
      messageCount: row.messageCount as number,
      lastMessageOffset: row.lastMessageOffset as number,
      startTime: row.startTime as Date,
      endTime: row.endTime as Date,
      topics: ((row.topics as string[]) || []) as string[],
      metadata: (row.metadata as Record<string, JsonValue>) ?? {},
      embedding: (row.embedding as number[]) ?? [],
      createdAt: row.createdAt as Date,
      updatedAt: row.updatedAt as Date,
    };
  }

  async storeSessionSummary(
    summary: Omit<SessionSummary, "id" | "createdAt" | "updatedAt">,
  ): Promise<SessionSummary> {
    const db = this.getDb();

    const id = crypto.randomUUID() as UUID;
    const now = new Date();

    const newSummary: SessionSummary = {
      id,
      createdAt: now,
      updatedAt: now,
      ...summary,
    };

    await db.insert(sessionSummaries).values({
      id: newSummary.id,
      agentId: newSummary.agentId,
      roomId: newSummary.roomId,
      entityId: newSummary.entityId ?? null,
      summary: newSummary.summary,
      messageCount: newSummary.messageCount,
      lastMessageOffset: newSummary.lastMessageOffset,
      startTime: newSummary.startTime,
      endTime: newSummary.endTime,
      topics: newSummary.topics ?? [],
      metadata: (newSummary.metadata ?? {}) as Record<string, DbValue>,
      embedding: newSummary.embedding ?? null,
      createdAt: now,
      updatedAt: now,
    });

    logger.info(
      { src: "service:memory" },
      `Stored session summary for room ${newSummary.roomId}`,
    );
    return newSummary;
  }

  async updateSessionSummary(
    id: UUID,
    roomId: UUID,
    updates: Partial<
      Omit<
        SessionSummary,
        "id" | "agentId" | "roomId" | "createdAt" | "updatedAt"
      >
    >,
  ): Promise<void> {
    const db = this.getDb();
    const updateData: Record<string, DbValue> = {
      updatedAt: new Date(),
    };

    if (updates.summary !== undefined) updateData.summary = updates.summary;
    if (updates.messageCount !== undefined)
      updateData.messageCount = updates.messageCount;
    if (updates.lastMessageOffset !== undefined)
      updateData.lastMessageOffset = updates.lastMessageOffset;
    if (updates.endTime !== undefined) updateData.endTime = updates.endTime;
    if (updates.topics !== undefined) updateData.topics = updates.topics;
    if (updates.metadata !== undefined)
      updateData.metadata = updates.metadata as Record<string, DbValue>;
    if (updates.embedding !== undefined)
      updateData.embedding = updates.embedding;

    await db
      .update(sessionSummaries)
      .set(updateData)
      .where(
        requireSql(
          and(
            eq(sessionSummaries.id, id),
            eq(sessionSummaries.agentId, this.runtime.agentId),
            eq(sessionSummaries.roomId, roomId),
          ),
          "updateSessionSummary(where)",
        ),
      );

    logger.info(
      { src: "service:memory" },
      `Updated session summary: ${id} for room ${roomId}`,
    );
  }

  async getSessionSummaries(
    roomId: UUID,
    limit = 5,
  ): Promise<SessionSummary[]> {
    const db = this.getDb();
    const results = await db
      .select()
      .from(sessionSummaries)
      .where(
        requireSql(
          and(
            eq(sessionSummaries.agentId, this.runtime.agentId),
            eq(sessionSummaries.roomId, roomId),
          ),
          "getSessionSummaries(where)",
        ),
      )
      .orderBy(desc(sessionSummaries.updatedAt))
      .limit(limit);

    return results.map((row) => ({
      id: row.id as UUID,
      agentId: row.agentId as UUID,
      roomId: row.roomId as UUID,
      entityId: (row.entityId as UUID) || undefined,
      summary: row.summary as string,
      messageCount: row.messageCount as number,
      lastMessageOffset: row.lastMessageOffset as number,
      startTime: row.startTime as Date,
      endTime: row.endTime as Date,
      topics: ((row.topics as string[]) || []) as string[],
      metadata: (row.metadata as Record<string, JsonValue>) ?? {},
      embedding: (row.embedding as number[]) ?? [],
      createdAt: row.createdAt as Date,
      updatedAt: row.updatedAt as Date,
    }));
  }

  async searchLongTermMemories(
    entityId: UUID,
    queryEmbedding: number[],
    limit = 5,
    matchThreshold = 0.7,
  ): Promise<LongTermMemory[]> {
    if (limit <= 0) return [];
    if (!this.memoryConfig.longTermVectorSearchEnabled) {
      logger.warn(
        { src: "service:memory" },
        "Vector search is not enabled, falling back to recent memories",
      );
      return this.getLongTermMemories(entityId, undefined, limit);
    }

    try {
      const candidates = await this.getLongTermMemories(
        entityId,
        undefined,
        200,
      );
      const scored: Array<{ memory: LongTermMemory; similarity: number }> = [];
      for (const memory of candidates) {
        if ((memory.embedding?.length ?? 0) === 0) continue;
        const similarity = cosineSimilarity(
          memory.embedding ?? [],
          queryEmbedding,
        );
        if (similarity < matchThreshold) continue;
        if (scored.length < limit) {
          scored.push({ memory, similarity });
          scored.sort((a, b) => b.similarity - a.similarity);
          continue;
        }
        if (similarity <= scored[scored.length - 1]?.similarity) continue;
        let index = 0;
        while (index < scored.length && scored[index].similarity > similarity) {
          index += 1;
        }
        scored.splice(index, 0, { memory, similarity });
        if (scored.length > limit) {
          scored.pop();
        }
      }
      return scored.map((x) => ({
        ...x.memory,
        similarity: x.similarity,
      }));
    } catch (error) {
      logger.warn(
        { error },
        "Vector search failed, falling back to recent memories",
        { src: "service:memory" },
      );
      return this.getLongTermMemories(entityId, undefined, limit);
    }
  }

  async getFormattedLongTermMemories(entityId: UUID): Promise<string> {
    const memories = await this.getLongTermMemories(entityId, undefined, 20);
    if (memories.length === 0) return "";

    const grouped = new Map<LongTermMemoryCategory, LongTermMemory[]>();
    for (const memory of memories) {
      const existing = grouped.get(memory.category);
      if (existing) {
        existing.push(memory);
      } else {
        grouped.set(memory.category, [memory]);
      }
    }

    const sections: string[] = [];
    for (const [category, categoryMemories] of grouped.entries()) {
      const categoryName = category
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
      const items = categoryMemories.map((m) => `- ${m.content}`).join("\n");
      sections.push(`**${categoryName}**:\n${items}`);
    }

    return sections.join("\n\n");
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
