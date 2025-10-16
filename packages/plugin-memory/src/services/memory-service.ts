import {
  type IAgentRuntime,
  Service,
  type UUID,
  type Memory,
  logger,
  type ServiceTypeName,
} from '@elizaos/core';
import {
  type LongTermMemory,
  type SessionSummary,
  type MemoryConfig,
  LongTermMemoryCategory,
} from '../types/index';

/**
 * Memory Service
 * Manages both short-term (session summaries) and long-term (persistent facts) memory
 */
export class MemoryService extends Service {
  static serviceType: ServiceTypeName = 'memory' as ServiceTypeName;

  private sessionMessageCounts: Map<UUID, number>;
  private memoryConfig: MemoryConfig;

  capabilityDescription =
    'Advanced memory management with short-term summarization and long-term persistent facts';

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.sessionMessageCounts = new Map();
    this.memoryConfig = {
      shortTermSummarizationThreshold: 50,
      shortTermRetainRecent: 10,
      longTermExtractionEnabled: true,
      longTermVectorSearchEnabled: false,
      longTermConfidenceThreshold: 0.7,
      summaryModelType: 'TEXT_LARGE',
      summaryMaxTokens: 500,
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
    if (longTermEnabled !== undefined) {
      this.memoryConfig.longTermExtractionEnabled = longTermEnabled === 'true';
    }

    const confidenceThreshold = runtime.getSetting('MEMORY_CONFIDENCE_THRESHOLD');
    if (confidenceThreshold) {
      this.memoryConfig.longTermConfidenceThreshold = parseFloat(confidenceThreshold);
    }

    logger.info('MemoryService initialized');
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
  shouldSummarize(roomId: UUID): boolean {
    const count = this.sessionMessageCounts.get(roomId) || 0;
    return count >= this.memoryConfig.shortTermSummarizationThreshold;
  }

  /**
   * Store a long-term memory
   */
  async storeLongTermMemory(
    memory: Omit<LongTermMemory, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<LongTermMemory> {
    let db;
    try {
      db = await this.runtime.getConnection();
    } catch (error) {
      logger.error({ error }, 'Failed to get database connection');
      throw new Error('Database not available');
    }

    if (!db) {
      throw new Error('Database not available');
    }

    const id = crypto.randomUUID() as UUID;
    const now = new Date();

    const newMemory: LongTermMemory = {
      id,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      ...memory,
    };

    // Store using raw SQL since we're using custom tables
    try {
      await db.query(
        `INSERT INTO long_term_memories 
         (id, agent_id, entity_id, category, content, metadata, embedding, confidence, source, access_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          newMemory.id,
          newMemory.agentId,
          newMemory.entityId,
          newMemory.category,
          newMemory.content,
          JSON.stringify(newMemory.metadata || {}),
          newMemory.embedding,
          newMemory.confidence,
          newMemory.source,
          newMemory.accessCount,
        ]
      );
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
    const db = await this.runtime.getConnection();
    if (!db) {
      return [];
    }

    let query = `
      SELECT * FROM long_term_memories 
      WHERE agent_id = $1 AND entity_id = $2
    `;
    const params: unknown[] = [this.runtime.agentId, entityId];

    if (category) {
      query += ` AND category = $3`;
      params.push(category);
      query += ` ORDER BY confidence DESC, updated_at DESC LIMIT $4`;
      params.push(limit);
    } else {
      query += ` ORDER BY confidence DESC, updated_at DESC LIMIT $3`;
      params.push(limit);
    }

    const results = await db.query(query, params);

    return results.rows.map((row: Record<string, unknown>) => ({
      id: row.id as UUID,
      agentId: row.agent_id as UUID,
      entityId: row.entity_id as UUID,
      category: row.category as LongTermMemoryCategory,
      content: row.content as string,
      metadata: row.metadata as Record<string, unknown>,
      embedding: row.embedding as number[],
      confidence: row.confidence as number,
      source: row.source as string,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
      lastAccessedAt: row.last_accessed_at as Date,
      accessCount: row.access_count as number,
    }));
  }

  /**
   * Update a long-term memory
   */
  async updateLongTermMemory(
    id: UUID,
    updates: Partial<Omit<LongTermMemory, 'id' | 'agentId' | 'createdAt'>>
  ): Promise<void> {
    const db = await this.runtime.getConnection();
    if (!db) {
      throw new Error('Database not available');
    }

    const setClauses: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.content !== undefined) {
      setClauses.push(`content = $${paramIndex++}`);
      params.push(updates.content);
    }

    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIndex++}`);
      params.push(JSON.stringify(updates.metadata));
    }

    if (updates.confidence !== undefined) {
      setClauses.push(`confidence = $${paramIndex++}`);
      params.push(updates.confidence);
    }

    if (updates.embedding !== undefined) {
      setClauses.push(`embedding = $${paramIndex++}`);
      params.push(updates.embedding);
    }

    params.push(id);
    const query = `UPDATE long_term_memories SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`;

    await db.query(query, params);
    logger.info(`Updated long-term memory: ${id}`);
  }

  /**
   * Delete a long-term memory
   */
  async deleteLongTermMemory(id: UUID): Promise<void> {
    const db = await this.runtime.getConnection();
    if (!db) {
      throw new Error('Database not available');
    }

    await db.query('DELETE FROM long_term_memories WHERE id = $1', [id]);
    logger.info(`Deleted long-term memory: ${id}`);
  }

  /**
   * Store a session summary
   */
  async storeSessionSummary(
    summary: Omit<SessionSummary, 'id' | 'createdAt'>
  ): Promise<SessionSummary> {
    let db;
    try {
      db = await this.runtime.getConnection();
    } catch (error) {
      logger.error({ error }, 'Failed to get database connection');
      throw new Error('Database not available');
    }

    if (!db) {
      throw new Error('Database not available');
    }

    const id = crypto.randomUUID() as UUID;
    const now = new Date();

    const newSummary: SessionSummary = {
      id,
      createdAt: now,
      ...summary,
    };

    await db.query(
      `INSERT INTO session_summaries 
       (id, agent_id, room_id, entity_id, summary, message_count, start_time, end_time, topics, metadata, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        newSummary.id,
        newSummary.agentId,
        newSummary.roomId,
        newSummary.entityId,
        newSummary.summary,
        newSummary.messageCount,
        newSummary.startTime,
        newSummary.endTime,
        JSON.stringify(newSummary.topics || []),
        JSON.stringify(newSummary.metadata || {}),
        newSummary.embedding,
      ]
    );

    logger.info(`Stored session summary for room ${newSummary.roomId}`);
    return newSummary;
  }

  /**
   * Get session summaries for a room
   */
  async getSessionSummaries(roomId: UUID, limit: number = 5): Promise<SessionSummary[]> {
    const db = await this.runtime.getConnection();
    if (!db) {
      return [];
    }

    const query = `
      SELECT * FROM session_summaries 
      WHERE agent_id = $1 AND room_id = $2 
      ORDER BY end_time DESC 
      LIMIT $3
    `;

    const results = await db.query(query, [this.runtime.agentId, roomId, limit]);

    return results.rows.map((row: Record<string, unknown>) => ({
      id: row.id as UUID,
      agentId: row.agent_id as UUID,
      roomId: row.room_id as UUID,
      entityId: row.entity_id as UUID | undefined,
      summary: row.summary as string,
      messageCount: row.message_count as number,
      startTime: row.start_time as Date,
      endTime: row.end_time as Date,
      topics: (row.topics as string[]) || [],
      metadata: row.metadata as Record<string, unknown>,
      embedding: row.embedding as number[],
      createdAt: row.created_at as Date,
    }));
  }

  /**
   * Search long-term memories by semantic similarity (if embeddings are available)
   */
  async searchLongTermMemories(
    entityId: UUID,
    queryEmbedding: number[],
    limit: number = 5
  ): Promise<LongTermMemory[]> {
    if (!this.memoryConfig.longTermVectorSearchEnabled) {
      logger.warn('Vector search is not enabled, falling back to recent memories');
      return this.getLongTermMemories(entityId, undefined, limit);
    }

    const db = await this.runtime.getConnection();
    if (!db) {
      return [];
    }

    // Use pgvector cosine similarity if available
    // This is a placeholder - actual implementation would depend on vector extension
    const query = `
      SELECT *, 
        1 - (embedding <=> $1::vector) as similarity
      FROM long_term_memories 
      WHERE agent_id = $2 AND entity_id = $3 AND embedding IS NOT NULL
      ORDER BY similarity DESC 
      LIMIT $4
    `;

    try {
      const results = await db.query(query, [
        JSON.stringify(queryEmbedding),
        this.runtime.agentId,
        entityId,
        limit,
      ]);

      return results.rows.map((row: Record<string, unknown>) => ({
        id: row.id as UUID,
        agentId: row.agent_id as UUID,
        entityId: row.entity_id as UUID,
        category: row.category as LongTermMemoryCategory,
        content: row.content as string,
        metadata: row.metadata as Record<string, unknown>,
        embedding: row.embedding as number[],
        confidence: row.confidence as number,
        source: row.source as string,
        createdAt: row.created_at as Date,
        updatedAt: row.updated_at as Date,
        lastAccessedAt: row.last_accessed_at as Date,
        accessCount: row.access_count as number,
      }));
    } catch (error) {
      logger.warn('Vector search failed, falling back to recent memories:', error);
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
