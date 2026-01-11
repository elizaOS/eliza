import {
  type IAgentRuntime,
  logger,
  Service,
  type ServiceTypeName,
  type UUID,
} from "@elizaos/core";
import { and, cosineDistance, desc, eq, gte, sql } from "drizzle-orm";
import { longTermMemories, sessionSummaries } from "../schemas";
import type {
  LongTermMemory,
  LongTermMemoryCategory,
  MemoryConfig,
  SessionSummary,
} from "../types";

/**
 * Memory Service
 * Manages both short-term (session summaries) and long-term (persistent facts) memory
 */
export class MemoryService extends Service {
  static serviceType: ServiceTypeName = "memory" as ServiceTypeName;

  private sessionMessageCounts: Map<UUID, number>;
  private memoryConfig: MemoryConfig;
  private lastExtractionCheckpoints: Map<string, number>;

  capabilityDescription =
    "Advanced memory management with short-term summarization and long-term persistent facts";

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
    logger.info("MemoryService stopped");
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;

    const threshold = runtime.getSetting("MEMORY_SUMMARIZATION_THRESHOLD");
    if (threshold) {
      this.memoryConfig.shortTermSummarizationThreshold = parseInt(String(threshold), 10);
    }

    const retainRecent = runtime.getSetting("MEMORY_RETAIN_RECENT");
    if (retainRecent) {
      this.memoryConfig.shortTermRetainRecent = parseInt(String(retainRecent), 10);
    }

    const summarizationInterval = runtime.getSetting("MEMORY_SUMMARIZATION_INTERVAL");
    if (summarizationInterval) {
      this.memoryConfig.shortTermSummarizationInterval = parseInt(
        String(summarizationInterval),
        10
      );
    }

    const maxNewMessages = runtime.getSetting("MEMORY_MAX_NEW_MESSAGES");
    if (maxNewMessages) {
      this.memoryConfig.summaryMaxNewMessages = parseInt(String(maxNewMessages), 10);
    }

    const longTermEnabled = runtime.getSetting("MEMORY_LONG_TERM_ENABLED");
    if (longTermEnabled === "false" || longTermEnabled === false) {
      this.memoryConfig.longTermExtractionEnabled = false;
    } else if (longTermEnabled === "true" || longTermEnabled === true) {
      this.memoryConfig.longTermExtractionEnabled = true;
    }

    const confidenceThreshold = runtime.getSetting("MEMORY_CONFIDENCE_THRESHOLD");
    if (confidenceThreshold) {
      this.memoryConfig.longTermConfidenceThreshold = parseFloat(String(confidenceThreshold));
    }

    const extractionThreshold = runtime.getSetting("MEMORY_EXTRACTION_THRESHOLD");
    if (extractionThreshold) {
      this.memoryConfig.longTermExtractionThreshold = parseInt(String(extractionThreshold), 10);
    }

    const extractionInterval = runtime.getSetting("MEMORY_EXTRACTION_INTERVAL");
    if (extractionInterval) {
      this.memoryConfig.longTermExtractionInterval = parseInt(String(extractionInterval), 10);
    }

    logger.debug(
      {
        summarizationThreshold: this.memoryConfig.shortTermSummarizationThreshold,
        summarizationInterval: this.memoryConfig.shortTermSummarizationInterval,
        maxNewMessages: this.memoryConfig.summaryMaxNewMessages,
        retainRecent: this.memoryConfig.shortTermRetainRecent,
        longTermEnabled: this.memoryConfig.longTermExtractionEnabled,
        extractionThreshold: this.memoryConfig.longTermExtractionThreshold,
        extractionInterval: this.memoryConfig.longTermExtractionInterval,
        confidenceThreshold: this.memoryConfig.longTermConfidenceThreshold,
      },
      "MemoryService initialized"
    );
  }

  private getDb(): ReturnType<typeof eq> & Record<string, unknown> {
    const db = (this.runtime as IAgentRuntime & { db: ReturnType<typeof eq> }).db;
    if (!db) {
      throw new Error("Database not available");
    }
    return db as ReturnType<typeof eq> & Record<string, unknown>;
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

  async getLastExtractionCheckpoint(entityId: UUID, roomId: UUID): Promise<number> {
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
      logger.warn({ error }, "Failed to get extraction checkpoint from cache");
      return 0;
    }
  }

  async setLastExtractionCheckpoint(
    entityId: UUID,
    roomId: UUID,
    messageCount: number
  ): Promise<void> {
    const key = this.getExtractionKey(entityId, roomId);
    this.lastExtractionCheckpoints.set(key, messageCount);

    try {
      await this.runtime.setCache(key, messageCount);
      logger.debug(
        `Set extraction checkpoint for ${entityId} in room ${roomId} at message count ${messageCount}`
      );
    } catch (error) {
      logger.error({ error }, "Failed to persist extraction checkpoint to cache");
    }
  }

  async shouldRunExtraction(
    entityId: UUID,
    roomId: UUID,
    currentMessageCount: number
  ): Promise<boolean> {
    const threshold = this.memoryConfig.longTermExtractionThreshold;
    const interval = this.memoryConfig.longTermExtractionInterval;

    if (currentMessageCount < threshold) {
      return false;
    }

    const lastCheckpoint = await this.getLastExtractionCheckpoint(entityId, roomId);
    const currentCheckpoint = Math.floor(currentMessageCount / interval) * interval;
    const shouldRun = currentMessageCount >= threshold && currentCheckpoint > lastCheckpoint;

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
      "Extraction check"
    );

    return shouldRun;
  }

  async storeLongTermMemory(
    memory: Omit<LongTermMemory, "id" | "createdAt" | "updatedAt">
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

    try {
      await (
        db as unknown as {
          insert: (table: unknown) => {
            values: (data: unknown) => Promise<void>;
          };
        }
      )
        .insert(longTermMemories)
        .values({
          id: newMemory.id,
          agentId: newMemory.agentId,
          entityId: newMemory.entityId,
          category: newMemory.category,
          content: newMemory.content,
          metadata: newMemory.metadata || {},
          embedding: newMemory.embedding,
          confidence: newMemory.confidence,
          source: newMemory.source,
          accessCount: newMemory.accessCount,
          createdAt: now,
          updatedAt: now,
          lastAccessedAt: newMemory.lastAccessedAt,
        });
    } catch (error) {
      logger.error({ error }, "Failed to store long-term memory");
      throw error;
    }

    logger.info(`Stored long-term memory: ${newMemory.category} for entity ${newMemory.entityId}`);
    return newMemory;
  }

  async getLongTermMemories(
    entityId: UUID,
    category?: LongTermMemoryCategory,
    limit: number = 10
  ): Promise<LongTermMemory[]> {
    const db = this.getDb();

    const conditions = [
      eq(longTermMemories.agentId, this.runtime.agentId),
      eq(longTermMemories.entityId, entityId),
    ];

    if (category) {
      conditions.push(eq(longTermMemories.category, category));
    }

    const results = await (
      db as unknown as {
        select: () => {
          from: (table: unknown) => {
            where: (cond: unknown) => {
              orderBy: (...args: unknown[]) => {
                limit: (n: number) => Promise<Array<Record<string, unknown>>>;
              };
            };
          };
        };
      }
    )
      .select()
      .from(longTermMemories)
      .where(and(...conditions))
      .orderBy(desc(longTermMemories.confidence), desc(longTermMemories.updatedAt))
      .limit(limit);

    return results.map((row) => ({
      id: row.id as UUID,
      agentId: row.agentId as UUID,
      entityId: row.entityId as UUID,
      category: row.category as LongTermMemoryCategory,
      content: row.content as string,
      metadata: row.metadata as Record<string, unknown>,
      embedding: row.embedding as number[],
      confidence: row.confidence as number,
      source: row.source as string,
      createdAt: row.createdAt as Date,
      updatedAt: row.updatedAt as Date,
      lastAccessedAt: row.lastAccessedAt as Date,
      accessCount: row.accessCount as number,
    }));
  }

  async updateLongTermMemory(
    id: UUID,
    entityId: UUID,
    updates: Partial<Omit<LongTermMemory, "id" | "agentId" | "entityId" | "createdAt">>
  ): Promise<void> {
    const db = this.getDb();

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (updates.content !== undefined) updateData.content = updates.content;
    if (updates.metadata !== undefined) updateData.metadata = updates.metadata;
    if (updates.confidence !== undefined) updateData.confidence = updates.confidence;
    if (updates.embedding !== undefined) updateData.embedding = updates.embedding;
    if (updates.lastAccessedAt !== undefined) updateData.lastAccessedAt = updates.lastAccessedAt;
    if (updates.accessCount !== undefined) updateData.accessCount = updates.accessCount;

    await (
      db as unknown as {
        update: (table: unknown) => {
          set: (data: unknown) => { where: (cond: unknown) => Promise<void> };
        };
      }
    )
      .update(longTermMemories)
      .set(updateData)
      .where(
        and(
          eq(longTermMemories.id, id),
          eq(longTermMemories.agentId, this.runtime.agentId),
          eq(longTermMemories.entityId, entityId)
        )
      );

    logger.info(`Updated long-term memory: ${id} for entity ${entityId}`);
  }

  async deleteLongTermMemory(id: UUID, entityId: UUID): Promise<void> {
    const db = this.getDb();

    await (
      db as unknown as {
        delete: (table: unknown) => { where: (cond: unknown) => Promise<void> };
      }
    )
      .delete(longTermMemories)
      .where(
        and(
          eq(longTermMemories.id, id),
          eq(longTermMemories.agentId, this.runtime.agentId),
          eq(longTermMemories.entityId, entityId)
        )
      );

    logger.info(`Deleted long-term memory: ${id} for entity ${entityId}`);
  }

  async getCurrentSessionSummary(roomId: UUID): Promise<SessionSummary | null> {
    const db = this.getDb();

    const results = await (
      db as unknown as {
        select: () => {
          from: (table: unknown) => {
            where: (cond: unknown) => {
              orderBy: (...args: unknown[]) => {
                limit: (n: number) => Promise<Array<Record<string, unknown>>>;
              };
            };
          };
        };
      }
    )
      .select()
      .from(sessionSummaries)
      .where(
        and(eq(sessionSummaries.agentId, this.runtime.agentId), eq(sessionSummaries.roomId, roomId))
      )
      .orderBy(desc(sessionSummaries.updatedAt))
      .limit(1);

    if (results.length === 0) {
      return null;
    }

    const row = results[0];
    return {
      id: row.id as UUID,
      agentId: row.agentId as UUID,
      roomId: row.roomId as UUID,
      entityId: row.entityId as UUID | undefined,
      summary: row.summary as string,
      messageCount: row.messageCount as number,
      lastMessageOffset: row.lastMessageOffset as number,
      startTime: row.startTime as Date,
      endTime: row.endTime as Date,
      topics: (row.topics as string[]) || [],
      metadata: row.metadata as Record<string, unknown>,
      embedding: row.embedding as number[],
      createdAt: row.createdAt as Date,
      updatedAt: row.updatedAt as Date,
    };
  }

  async storeSessionSummary(
    summary: Omit<SessionSummary, "id" | "createdAt" | "updatedAt">
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

    await (
      db as unknown as {
        insert: (table: unknown) => {
          values: (data: unknown) => Promise<void>;
        };
      }
    )
      .insert(sessionSummaries)
      .values({
        id: newSummary.id,
        agentId: newSummary.agentId,
        roomId: newSummary.roomId,
        entityId: newSummary.entityId || null,
        summary: newSummary.summary,
        messageCount: newSummary.messageCount,
        lastMessageOffset: newSummary.lastMessageOffset,
        startTime: newSummary.startTime,
        endTime: newSummary.endTime,
        topics: newSummary.topics || [],
        metadata: newSummary.metadata || {},
        embedding: newSummary.embedding,
        createdAt: now,
        updatedAt: now,
      });

    logger.info(`Stored session summary for room ${newSummary.roomId}`);
    return newSummary;
  }

  async updateSessionSummary(
    id: UUID,
    roomId: UUID,
    updates: Partial<Omit<SessionSummary, "id" | "agentId" | "roomId" | "createdAt" | "updatedAt">>
  ): Promise<void> {
    const db = this.getDb();

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (updates.summary !== undefined) updateData.summary = updates.summary;
    if (updates.messageCount !== undefined) updateData.messageCount = updates.messageCount;
    if (updates.lastMessageOffset !== undefined)
      updateData.lastMessageOffset = updates.lastMessageOffset;
    if (updates.endTime !== undefined) updateData.endTime = updates.endTime;
    if (updates.topics !== undefined) updateData.topics = updates.topics;
    if (updates.metadata !== undefined) updateData.metadata = updates.metadata;
    if (updates.embedding !== undefined) updateData.embedding = updates.embedding;

    await (
      db as unknown as {
        update: (table: unknown) => {
          set: (data: unknown) => { where: (cond: unknown) => Promise<void> };
        };
      }
    )
      .update(sessionSummaries)
      .set(updateData)
      .where(
        and(
          eq(sessionSummaries.id, id),
          eq(sessionSummaries.agentId, this.runtime.agentId),
          eq(sessionSummaries.roomId, roomId)
        )
      );

    logger.info(`Updated session summary: ${id} for room ${roomId}`);
  }

  async getSessionSummaries(roomId: UUID, limit: number = 5): Promise<SessionSummary[]> {
    const db = this.getDb();

    const results = await (
      db as unknown as {
        select: () => {
          from: (table: unknown) => {
            where: (cond: unknown) => {
              orderBy: (...args: unknown[]) => {
                limit: (n: number) => Promise<Array<Record<string, unknown>>>;
              };
            };
          };
        };
      }
    )
      .select()
      .from(sessionSummaries)
      .where(
        and(eq(sessionSummaries.agentId, this.runtime.agentId), eq(sessionSummaries.roomId, roomId))
      )
      .orderBy(desc(sessionSummaries.updatedAt))
      .limit(limit);

    return results.map((row) => ({
      id: row.id as UUID,
      agentId: row.agentId as UUID,
      roomId: row.roomId as UUID,
      entityId: row.entityId as UUID | undefined,
      summary: row.summary as string,
      messageCount: row.messageCount as number,
      lastMessageOffset: row.lastMessageOffset as number,
      startTime: row.startTime as Date,
      endTime: row.endTime as Date,
      topics: (row.topics as string[]) || [],
      metadata: row.metadata as Record<string, unknown>,
      embedding: row.embedding as number[],
      createdAt: row.createdAt as Date,
      updatedAt: row.updatedAt as Date,
    }));
  }

  async searchLongTermMemories(
    entityId: UUID,
    queryEmbedding: number[],
    limit: number = 5,
    matchThreshold: number = 0.7
  ): Promise<LongTermMemory[]> {
    if (!this.memoryConfig.longTermVectorSearchEnabled) {
      logger.warn("Vector search is not enabled, falling back to recent memories");
      return this.getLongTermMemories(entityId, undefined, limit);
    }

    const db = this.getDb();

    try {
      const cleanVector = queryEmbedding.map((n) =>
        Number.isFinite(n) ? Number(n.toFixed(6)) : 0
      );

      const similarity = sql<number>`1 - (${cosineDistance(
        longTermMemories.embedding,
        cleanVector
      )})`;

      const conditions = [
        eq(longTermMemories.agentId, this.runtime.agentId),
        eq(longTermMemories.entityId, entityId),
        sql`${longTermMemories.embedding} IS NOT NULL`,
      ];

      if (matchThreshold > 0) {
        conditions.push(gte(similarity, matchThreshold));
      }

      const results = await (
        db as unknown as {
          select: (cols: unknown) => {
            from: (table: unknown) => {
              where: (cond: unknown) => {
                orderBy: (...args: unknown[]) => {
                  limit: (n: number) => Promise<
                    Array<{
                      memory: Record<string, unknown>;
                      similarity: number;
                    }>
                  >;
                };
              };
            };
          };
        }
      )
        .select({
          memory: longTermMemories,
          similarity,
        })
        .from(longTermMemories)
        .where(and(...conditions))
        .orderBy(desc(similarity))
        .limit(limit);

      return results.map((row) => ({
        id: row.memory.id as UUID,
        agentId: row.memory.agentId as UUID,
        entityId: row.memory.entityId as UUID,
        category: row.memory.category as LongTermMemoryCategory,
        content: row.memory.content as string,
        metadata: row.memory.metadata as Record<string, unknown>,
        embedding: row.memory.embedding as number[],
        confidence: row.memory.confidence as number,
        source: row.memory.source as string,
        createdAt: row.memory.createdAt as Date,
        updatedAt: row.memory.updatedAt as Date,
        lastAccessedAt: row.memory.lastAccessedAt as Date,
        accessCount: row.memory.accessCount as number,
        similarity: row.similarity,
      }));
    } catch (error) {
      logger.warn({ error }, "Vector search failed, falling back to recent memories");
      return this.getLongTermMemories(entityId, undefined, limit);
    }
  }

  async getFormattedLongTermMemories(entityId: UUID): Promise<string> {
    const memories = await this.getLongTermMemories(entityId, undefined, 20);

    if (memories.length === 0) {
      return "";
    }

    const grouped = new Map<LongTermMemoryCategory, LongTermMemory[]>();

    for (const memory of memories) {
      if (!grouped.has(memory.category)) {
        grouped.set(memory.category, []);
      }
      grouped.get(memory.category)?.push(memory);
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
