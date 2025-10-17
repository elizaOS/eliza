import {
  type IAgentRuntime,
  Service,
  type UUID,
  logger,
  type ServiceTypeName,
} from '@elizaos/core';
import { eq, and, desc, sql, cosineDistance, gte } from 'drizzle-orm';
import {
  type LongTermMemory,
  type SessionSummary,
  type MemoryConfig,
  LongTermMemoryCategory,
} from '../types/index';
import { longTermMemories, sessionSummaries } from '../schemas/index';

/**
 * Memory Service
 * Manages both short-term (session summaries) and long-term (persistent facts) memory
 */
export class MemoryService extends Service {
  static serviceType: ServiceTypeName = 'memory' as ServiceTypeName;

  private sessionMessageCounts: Map<UUID, number>;
  private memoryConfig: MemoryConfig;
  private lastExtractionCheckpoints: Map<string, number>; // Track last extraction per entity-room pair

  capabilityDescription =
    'Advanced memory management with short-term summarization and long-term persistent facts';

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.sessionMessageCounts = new Map();
    this.lastExtractionCheckpoints = new Map();
    this.memoryConfig = {
      shortTermSummarizationThreshold: 5,
      shortTermRetainRecent: 10,
      longTermExtractionEnabled: true,
      longTermVectorSearchEnabled: false,
      longTermConfidenceThreshold: 0.7,
      longTermExtractionInterval: 5, // Run extraction every N messages
      summaryModelType: 'TEXT_LARGE',
      summaryMaxTokens: 2500,
    };
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new MemoryService(runtime);
    await service.initialize(runtime);
    return service;
  }

  async stop(): Promise<void> {
    // No cleanup needed for this service
    logger.info('MemoryService stopped');
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;

    // Load configuration from runtime settings
    const threshold = runtime.getSetting('MEMORY_SUMMARIZATION_THRESHOLD');
    if (threshold) {
      this.memoryConfig.shortTermSummarizationThreshold = parseInt(threshold, 10);
    }

    const retainRecent = runtime.getSetting('MEMORY_RETAIN_RECENT');
    if (retainRecent) {
      this.memoryConfig.shortTermRetainRecent = parseInt(retainRecent, 10);
    }

    const longTermEnabled = runtime.getSetting('MEMORY_LONG_TERM_ENABLED');
    // Only override default if explicitly set to 'false'
    if (longTermEnabled === 'false') {
      this.memoryConfig.longTermExtractionEnabled = false;
    } else if (longTermEnabled === 'true') {
      this.memoryConfig.longTermExtractionEnabled = true;
    }
    // Otherwise keep the default value (true)

    const confidenceThreshold = runtime.getSetting('MEMORY_CONFIDENCE_THRESHOLD');
    if (confidenceThreshold) {
      this.memoryConfig.longTermConfidenceThreshold = parseFloat(confidenceThreshold);
    }

    logger.info(
      {
        summarizationThreshold: this.memoryConfig.shortTermSummarizationThreshold,
        retainRecent: this.memoryConfig.shortTermRetainRecent,
        longTermEnabled: this.memoryConfig.longTermExtractionEnabled,
        extractionInterval: this.memoryConfig.longTermExtractionInterval,
        confidenceThreshold: this.memoryConfig.longTermConfidenceThreshold,
      },
      'MemoryService initialized'
    );
  }

  /**
   * Get the Drizzle database instance
   */
  private getDb(): any {
    const db = (this.runtime as any).db;
    if (!db) {
      throw new Error('Database not available');
    }
    return db;
  }

  /**
   * Get configuration
   */
  getConfig(): MemoryConfig {
    return { ...this.memoryConfig };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<MemoryConfig>): void {
    this.memoryConfig = { ...this.memoryConfig, ...updates };
  }

  /**
   * Track message count for a room
   */
  incrementMessageCount(roomId: UUID): number {
    const current = this.sessionMessageCounts.get(roomId) || 0;
    const newCount = current + 1;
    this.sessionMessageCounts.set(roomId, newCount);
    return newCount;
  }

  /**
   * Reset message count for a room
   */
  resetMessageCount(roomId: UUID): void {
    this.sessionMessageCounts.set(roomId, 0);
  }

  /**
   * Check if summarization is needed for a room
   */
  async shouldSummarize(roomId: UUID): Promise<boolean> {
    const count = await this.runtime.countMemories(roomId, false, 'messages');
    return count >= this.memoryConfig.shortTermSummarizationThreshold;
  }

  /**
   * Generate cache key for tracking extraction checkpoints per entity-room pair
   */
  private getExtractionKey(entityId: UUID, roomId: UUID): string {
    return `memory:extraction:${entityId}:${roomId}`;
  }

  /**
   * Get the last extraction checkpoint for an entity in a room
   * Uses the cache table via adapter
   */
  async getLastExtractionCheckpoint(entityId: UUID, roomId: UUID): Promise<number> {
    const key = this.getExtractionKey(entityId, roomId);

    // Check in-memory cache first
    const cached = this.lastExtractionCheckpoints.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // Check database cache table via adapter
    try {
      const checkpoint = await this.runtime.getCache<number>(key);
      const messageCount = checkpoint ?? 0;

      // Cache it in memory for faster access
      this.lastExtractionCheckpoints.set(key, messageCount);

      return messageCount;
    } catch (error) {
      logger.warn({ error }, 'Failed to get extraction checkpoint from cache');
      return 0;
    }
  }

  /**
   * Set the last extraction checkpoint for an entity in a room
   * Uses the cache table via adapter
   */
  async setLastExtractionCheckpoint(
    entityId: UUID,
    roomId: UUID,
    messageCount: number
  ): Promise<void> {
    const key = this.getExtractionKey(entityId, roomId);

    // Update in-memory cache
    this.lastExtractionCheckpoints.set(key, messageCount);

    // Persist to database cache table via adapter
    try {
      await this.runtime.setCache(key, messageCount);
      logger.debug(
        `Set extraction checkpoint for ${entityId} in room ${roomId} at message count ${messageCount}`
      );
    } catch (error) {
      logger.error({ error }, 'Failed to persist extraction checkpoint to cache');
    }
  }

  /**
   * Check if long-term extraction should run based on message count and interval
   */
  async shouldRunExtraction(
    entityId: UUID,
    roomId: UUID,
    currentMessageCount: number
  ): Promise<boolean> {
    const interval = this.memoryConfig.longTermExtractionInterval;
    const lastCheckpoint = await this.getLastExtractionCheckpoint(entityId, roomId);

    // Calculate the current checkpoint (e.g., if interval=5: 5, 10, 15, 20...)
    const currentCheckpoint = Math.floor(currentMessageCount / interval) * interval;

    // Run if we're at or past a checkpoint and haven't processed this checkpoint yet
    const shouldRun = currentMessageCount >= interval && currentCheckpoint > lastCheckpoint;

    logger.debug(
      {
        entityId,
        roomId,
        currentMessageCount,
        interval,
        lastCheckpoint,
        currentCheckpoint,
        shouldRun,
      },
      'Extraction check'
    );

    return shouldRun;
  }

  /**
   * Store a long-term memory
   */
  async storeLongTermMemory(
    memory: Omit<LongTermMemory, 'id' | 'createdAt' | 'updatedAt'>
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
      await db.insert(longTermMemories).values({
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
      logger.error({ error }, 'Failed to store long-term memory');
      throw error;
    }

    logger.info(`Stored long-term memory: ${newMemory.category} for entity ${newMemory.entityId}`);
    return newMemory;
  }

  /**
   * Retrieve long-term memories for an entity
   */
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

    const results = await db
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
      content: row.content,
      metadata: row.metadata as Record<string, unknown>,
      embedding: row.embedding as number[],
      confidence: row.confidence as number,
      source: row.source as string,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastAccessedAt: row.lastAccessedAt,
      accessCount: row.accessCount as number,
    }));
  }

  /**
   * Update a long-term memory
   */
  async updateLongTermMemory(
    id: UUID,
    updates: Partial<Omit<LongTermMemory, 'id' | 'agentId' | 'createdAt'>>
  ): Promise<void> {
    const db = this.getDb();

    const updateData: any = {
      updatedAt: new Date(),
    };

    if (updates.content !== undefined) {
      updateData.content = updates.content;
    }

    if (updates.metadata !== undefined) {
      updateData.metadata = updates.metadata;
    }

    if (updates.confidence !== undefined) {
      updateData.confidence = updates.confidence;
    }

    if (updates.embedding !== undefined) {
      updateData.embedding = updates.embedding;
    }

    if (updates.lastAccessedAt !== undefined) {
      updateData.lastAccessedAt = updates.lastAccessedAt;
    }

    if (updates.accessCount !== undefined) {
      updateData.accessCount = updates.accessCount;
    }

    await db.update(longTermMemories).set(updateData).where(eq(longTermMemories.id, id));

    logger.info(`Updated long-term memory: ${id}`);
  }

  /**
   * Delete a long-term memory
   */
  async deleteLongTermMemory(id: UUID): Promise<void> {
    const db = this.getDb();

    await db.delete(longTermMemories).where(eq(longTermMemories.id, id));

    logger.info(`Deleted long-term memory: ${id}`);
  }

  /**
   * Get the current session summary for a room (latest one)
   */
  async getCurrentSessionSummary(roomId: UUID): Promise<SessionSummary | null> {
    const db = this.getDb();

    const results = await db
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
      summary: row.summary,
      messageCount: row.messageCount,
      lastMessageOffset: row.lastMessageOffset,
      startTime: row.startTime,
      endTime: row.endTime,
      topics: (row.topics as string[]) || [],
      metadata: row.metadata as Record<string, unknown>,
      embedding: row.embedding as number[],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Store a session summary (initial creation)
   */
  async storeSessionSummary(
    summary: Omit<SessionSummary, 'id' | 'createdAt' | 'updatedAt'>
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

  /**
   * Update an existing session summary
   */
  async updateSessionSummary(
    id: UUID,
    updates: Partial<Omit<SessionSummary, 'id' | 'agentId' | 'roomId' | 'createdAt' | 'updatedAt'>>
  ): Promise<void> {
    const db = this.getDb();

    const updateData: any = {
      updatedAt: new Date(),
    };

    if (updates.summary !== undefined) {
      updateData.summary = updates.summary;
    }

    if (updates.messageCount !== undefined) {
      updateData.messageCount = updates.messageCount;
    }

    if (updates.lastMessageOffset !== undefined) {
      updateData.lastMessageOffset = updates.lastMessageOffset;
    }

    if (updates.endTime !== undefined) {
      updateData.endTime = updates.endTime;
    }

    if (updates.topics !== undefined) {
      updateData.topics = updates.topics;
    }

    if (updates.metadata !== undefined) {
      updateData.metadata = updates.metadata;
    }

    if (updates.embedding !== undefined) {
      updateData.embedding = updates.embedding;
    }

    await db.update(sessionSummaries).set(updateData).where(eq(sessionSummaries.id, id));

    logger.info(`Updated session summary: ${id}`);
  }

  /**
   * Get session summaries for a room
   */
  async getSessionSummaries(roomId: UUID, limit: number = 5): Promise<SessionSummary[]> {
    const db = this.getDb();

    const results = await db
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
      summary: row.summary,
      messageCount: row.messageCount,
      lastMessageOffset: row.lastMessageOffset,
      startTime: row.startTime,
      endTime: row.endTime,
      topics: (row.topics as string[]) || [],
      metadata: row.metadata as Record<string, unknown>,
      embedding: row.embedding as number[],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  /**
   * Search long-term memories by semantic similarity (if embeddings are available)
   */
  async searchLongTermMemories(
    entityId: UUID,
    queryEmbedding: number[],
    limit: number = 5,
    matchThreshold: number = 0.7
  ): Promise<LongTermMemory[]> {
    if (!this.memoryConfig.longTermVectorSearchEnabled) {
      logger.warn('Vector search is not enabled, falling back to recent memories');
      return this.getLongTermMemories(entityId, undefined, limit);
    }

    const db = this.getDb();

    try {
      // Clean the vector to ensure all numbers are finite and properly formatted
      const cleanVector = queryEmbedding.map((n) =>
        Number.isFinite(n) ? Number(n.toFixed(6)) : 0
      );

      // Calculate similarity using Drizzle's cosineDistance
      const similarity = sql<number>`1 - (${cosineDistance(
        longTermMemories.embedding,
        cleanVector
      )})`;

      const conditions = [
        eq(longTermMemories.agentId, this.runtime.agentId),
        eq(longTermMemories.entityId, entityId),
        sql`${longTermMemories.embedding} IS NOT NULL`,
      ];

      // Add similarity threshold if specified
      if (matchThreshold > 0) {
        conditions.push(gte(similarity, matchThreshold));
      }

      const results = await db
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
        content: row.memory.content,
        metadata: row.memory.metadata as Record<string, unknown>,
        embedding: row.memory.embedding as number[],
        confidence: row.memory.confidence as number,
        source: row.memory.source as string,
        createdAt: row.memory.createdAt,
        updatedAt: row.memory.updatedAt,
        lastAccessedAt: row.memory.lastAccessedAt,
        accessCount: row.memory.accessCount as number,
        similarity: row.similarity,
      }));
    } catch (error) {
      logger.warn({ error }, 'Vector search failed, falling back to recent memories');
      return this.getLongTermMemories(entityId, undefined, limit);
    }
  }

  /**
   * Get all long-term memories formatted for context
   */
  async getFormattedLongTermMemories(entityId: UUID): Promise<string> {
    const memories = await this.getLongTermMemories(entityId, undefined, 20);

    if (memories.length === 0) {
      return '';
    }

    // Group by category
    const grouped = new Map<LongTermMemoryCategory, LongTermMemory[]>();

    for (const memory of memories) {
      if (!grouped.has(memory.category)) {
        grouped.set(memory.category, []);
      }
      grouped.get(memory.category)?.push(memory);
    }

    // Format each category
    const sections: string[] = [];

    for (const [category, categoryMemories] of grouped.entries()) {
      const categoryName = category
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      const items = categoryMemories.map((m) => `- ${m.content}`).join('\n');
      sections.push(`**${categoryName}**:\n${items}`);
    }

    return sections.join('\n\n');
  }
}
