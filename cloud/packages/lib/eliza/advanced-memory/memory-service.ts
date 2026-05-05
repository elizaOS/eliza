import {
  type IAgentRuntime,
  logger,
  ModelType,
  Service,
  type ServiceTypeName,
  type UUID,
} from "@elizaos/core";
import { sql } from "drizzle-orm";
import { dbRead } from "@/db/client";
import type {
  LongTermMemory,
  LongTermMemoryCategory,
  MemoryConfig,
  MemoryStorageProvider,
  SessionSummary,
} from "./types";

const MEMORY_STORAGE_SERVICE = "memoryStorage" as ServiceTypeName;

export class MemoryService extends Service {
  static serviceType = "memory" as ServiceTypeName;

  private sessionMessageCounts = new Map<UUID, number>();
  private memoryConfig: MemoryConfig = {
    shortTermSummarizationThreshold: 16,
    shortTermRetainRecent: 6,
    shortTermSummarizationInterval: 10,
    longTermExtractionEnabled: true,
    longTermVectorSearchEnabled: false,
    longTermConfidenceThreshold: 0.85,
    longTermExtractionThreshold: 30,
    longTermExtractionInterval: 10,
    summaryModelType: ModelType.TEXT_SMALL,
    summaryMaxTokens: 2500,
    summaryMaxNewMessages: 20,
  };
  private lastExtractionCheckpoints = new Map<string, number>();
  private storage: MemoryStorageProvider | null = null;

  capabilityDescription =
    "Memory management with conversation summarization and long-term persistent facts";

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
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

    let provider: MemoryStorageProvider | null = null;
    if (runtime.hasService(MEMORY_STORAGE_SERVICE)) {
      try {
        provider = (await runtime.getServiceLoadPromise(
          MEMORY_STORAGE_SERVICE,
        )) as unknown as MemoryStorageProvider | null;
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        logger.warn(
          { src: "service:memory", agentId: runtime.agentId, err },
          "MemoryStorageProvider failed to start; storage-backed advanced memory disabled",
        );
      }
    }

    if (!provider) {
      logger.warn(
        { src: "service:memory", agentId: runtime.agentId },
        "No MemoryStorageProvider found; long-term memory and session summaries disabled",
      );
    }

    this.storage = provider;

    const threshold = runtime.getSetting("MEMORY_SUMMARIZATION_THRESHOLD");
    if (threshold) {
      this.memoryConfig.shortTermSummarizationThreshold = Number.parseInt(String(threshold), 10);
    }

    const retainRecent = runtime.getSetting("MEMORY_RETAIN_RECENT");
    if (retainRecent) {
      this.memoryConfig.shortTermRetainRecent = Number.parseInt(String(retainRecent), 10);
    }

    const summarizationInterval = runtime.getSetting("MEMORY_SUMMARIZATION_INTERVAL");
    if (summarizationInterval) {
      this.memoryConfig.shortTermSummarizationInterval = Number.parseInt(
        String(summarizationInterval),
        10,
      );
    }

    const maxNewMessages = runtime.getSetting("MEMORY_MAX_NEW_MESSAGES");
    if (maxNewMessages) {
      this.memoryConfig.summaryMaxNewMessages = Number.parseInt(String(maxNewMessages), 10);
    }

    const longTermEnabled = runtime.getSetting("MEMORY_LONG_TERM_ENABLED");
    if (longTermEnabled === "false" || longTermEnabled === false) {
      this.memoryConfig.longTermExtractionEnabled = false;
    } else if (longTermEnabled === "true" || longTermEnabled === true) {
      this.memoryConfig.longTermExtractionEnabled = true;
    }

    const confidenceThreshold = runtime.getSetting("MEMORY_CONFIDENCE_THRESHOLD");
    if (confidenceThreshold) {
      this.memoryConfig.longTermConfidenceThreshold = Number.parseFloat(
        String(confidenceThreshold),
      );
    }

    const extractionThreshold = runtime.getSetting("MEMORY_EXTRACTION_THRESHOLD");
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
        summarizationThreshold: this.memoryConfig.shortTermSummarizationThreshold,
        summarizationInterval: this.memoryConfig.shortTermSummarizationInterval,
        maxNewMessages: this.memoryConfig.summaryMaxNewMessages,
        retainRecent: this.memoryConfig.shortTermRetainRecent,
        longTermEnabled: this.memoryConfig.longTermExtractionEnabled,
        extractionThreshold: this.memoryConfig.longTermExtractionThreshold,
        extractionInterval: this.memoryConfig.longTermExtractionInterval,
        confidenceThreshold: this.memoryConfig.longTermConfidenceThreshold,
        storageAvailable: !!this.storage,
      },
      "MemoryService initialized",
      { src: "service:memory" },
    );
  }

  private async getStorage(): Promise<MemoryStorageProvider> {
    if (!this.storage && this.runtime.hasService(MEMORY_STORAGE_SERVICE)) {
      try {
        this.storage = (await this.runtime.getServiceLoadPromise(
          MEMORY_STORAGE_SERVICE,
        )) as unknown as MemoryStorageProvider | null;
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        logger.warn(
          { src: "service:memory", agentId: this.runtime.agentId, err },
          "MemoryStorageProvider lookup failed during lazy resolution",
        );
      }
    }

    if (!this.storage) {
      throw new Error(
        "MemoryStorageProvider not available. Register a memoryStorage service from your database plugin.",
      );
    }

    return this.storage;
  }

  private async countRoomMemories(roomId: UUID): Promise<number> {
    type ModernCounter = (params: {
      roomIds: UUID[];
      unique: boolean;
      tableName: string;
    }) => Promise<number>;
    type LegacyCounter = (roomId: UUID, unique?: boolean, tableName?: string) => Promise<number>;

    const counter = this.runtime.countMemories as unknown as ModernCounter | LegacyCounter;
    if (counter.length >= 2) {
      return (counter as LegacyCounter).call(this.runtime, roomId, false, "messages");
    }
    return (counter as ModernCounter).call(this.runtime, {
      roomIds: [roomId],
      unique: false,
      tableName: "messages",
    });
  }

  getConfig(): MemoryConfig {
    return { ...this.memoryConfig };
  }

  updateConfig(updates: Partial<MemoryConfig>): void {
    this.memoryConfig = { ...this.memoryConfig, ...updates };
  }

  hasStorage(): boolean {
    return !!this.storage;
  }

  incrementMessageCount(roomId: UUID): number {
    const current = this.sessionMessageCounts.get(roomId) || 0;
    const next = current + 1;
    this.sessionMessageCounts.set(roomId, next);
    return next;
  }

  resetMessageCount(roomId: UUID): void {
    this.sessionMessageCounts.set(roomId, 0);
  }

  async shouldSummarize(roomId: UUID): Promise<boolean> {
    const count = await this.countRoomMemories(roomId);
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
      const checkpoint = await this.runtime.getCache(key);
      const messageCount =
        typeof checkpoint === "number" && Number.isFinite(checkpoint) ? checkpoint : 0;
      this.lastExtractionCheckpoints.set(key, messageCount);
      return messageCount;
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.warn({ src: "service:memory", err }, "Failed to get extraction checkpoint from cache");
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

    const lastCheckpoint = await this.getLastExtractionCheckpoint(entityId, roomId);
    const currentCheckpoint = Math.floor(currentMessageCount / interval) * interval;
    return currentMessageCount >= threshold && currentCheckpoint > lastCheckpoint;
  }

  async storeLongTermMemory(
    memory: Omit<LongTermMemory, "id" | "createdAt" | "updatedAt" | "accessCount">,
  ): Promise<LongTermMemory> {
    return (await this.getStorage()).storeLongTermMemory(memory);
  }

  async getLongTermMemories(
    entityId: UUID,
    category?: LongTermMemoryCategory,
    limit = 10,
  ): Promise<LongTermMemory[]> {
    if (limit <= 0) {
      return [];
    }
    return (await this.getStorage()).getLongTermMemories(this.runtime.agentId, entityId, {
      category,
      limit,
    });
  }

  async updateLongTermMemory(
    id: UUID,
    entityId: UUID,
    updates: Partial<Omit<LongTermMemory, "id" | "agentId" | "entityId" | "createdAt">>,
  ): Promise<void> {
    await (await this.getStorage()).updateLongTermMemory(
      id,
      this.runtime.agentId,
      entityId,
      updates,
    );
  }

  async deleteLongTermMemory(id: UUID, entityId: UUID): Promise<void> {
    await (await this.getStorage()).deleteLongTermMemory(id, this.runtime.agentId, entityId);
  }

  async getCurrentSessionSummary(roomId: UUID): Promise<SessionSummary | null> {
    return (await this.getStorage()).getCurrentSessionSummary(this.runtime.agentId, roomId);
  }

  async storeSessionSummary(
    summary: Omit<SessionSummary, "id" | "createdAt" | "updatedAt">,
  ): Promise<SessionSummary> {
    return (await this.getStorage()).storeSessionSummary(summary);
  }

  async updateSessionSummary(
    id: UUID,
    roomId: UUID,
    updates: Partial<Omit<SessionSummary, "id" | "agentId" | "roomId" | "createdAt" | "updatedAt">>,
  ): Promise<void> {
    await (await this.getStorage()).updateSessionSummary(id, this.runtime.agentId, roomId, updates);
  }

  async getSessionSummaries(roomId: UUID, limit = 5): Promise<SessionSummary[]> {
    return (await this.getStorage()).getSessionSummaries(this.runtime.agentId, roomId, limit);
  }

  async searchLongTermMemories(
    entityId: UUID,
    queryEmbedding: number[],
    limit = 5,
    matchThreshold = 0.7,
  ): Promise<LongTermMemory[]> {
    if (limit <= 0) {
      return [];
    }

    if (!this.memoryConfig.longTermVectorSearchEnabled) {
      logger.warn(
        { src: "service:memory" },
        "Vector search is not enabled, falling back to recent memories",
      );
      return this.getLongTermMemories(entityId, undefined, limit);
    }

    const dim = queryEmbedding.length;
    if (dim !== 384 && dim !== 1536) {
      logger.warn(
        { src: "service:memory", dim },
        "Vector search query dimension is not 384 or 1536; falling back to recent memories",
      );
      return this.getLongTermMemories(entityId, undefined, limit);
    }

    const column = dim === 384 ? "embedding_384" : "embedding_1536";
    const literal = `[${queryEmbedding.join(",")}]`;
    const agentId = this.runtime.agentId;

    const result = await dbRead.execute(sql`
      SELECT
        id,
        agent_id AS "agentId",
        entity_id AS "entityId",
        category,
        content,
        metadata,
        confidence,
        source,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        last_accessed_at AS "lastAccessedAt",
        access_count AS "accessCount",
        1 - (${sql.raw(`"${column}"`)} <=> ${literal}::vector) AS similarity
      FROM long_term_memories
      WHERE agent_id = ${agentId}
        AND entity_id = ${entityId}
        AND ${sql.raw(`"${column}"`)} IS NOT NULL
      ORDER BY ${sql.raw(`"${column}"`)} <=> ${literal}::vector
      LIMIT ${limit}
    `);

    type SearchRow = {
      id: UUID;
      agentId: UUID;
      entityId: UUID;
      category: string;
      content: string;
      metadata: LongTermMemory["metadata"];
      confidence: number | null;
      source: string | null;
      createdAt: Date;
      updatedAt: Date;
      lastAccessedAt: Date | null;
      accessCount: number | null;
      similarity: number;
    };

    const rows = (result.rows ?? []) as SearchRow[];

    return rows
      .filter((row) => row.similarity >= matchThreshold)
      .map((row) => ({
        id: row.id,
        agentId: row.agentId,
        entityId: row.entityId,
        category: row.category as LongTermMemoryCategory,
        content: row.content,
        metadata: row.metadata,
        confidence: row.confidence ?? undefined,
        source: row.source ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastAccessedAt: row.lastAccessedAt ?? undefined,
        accessCount: row.accessCount ?? undefined,
        similarity: row.similarity,
      }));
  }

  async getFormattedLongTermMemories(entityId: UUID): Promise<string> {
    const memories = await this.getLongTermMemories(entityId, undefined, 20);
    if (memories.length === 0) {
      return "";
    }

    const grouped = new Map<LongTermMemoryCategory, LongTermMemory[]>();
    for (const memory of memories) {
      const group = grouped.get(memory.category);
      if (group) {
        group.push(memory);
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
      const items = categoryMemories.map((memory) => `- ${memory.content}`).join("\n");
      sections.push(`**${categoryName}**:\n${items}`);
    }

    return sections.join("\n\n");
  }
}
