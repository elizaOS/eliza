import {
  type IAgentRuntime,
  Service,
  type UUID,
  logger,
  type ServiceTypeName,
  type LoreEntry,
  ModelType,
  BM25,
} from '@elizaos/core';
import { eq, and, desc, sql, cosineDistance, gte } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { lorebookTable, lorebookEmbeddingsTable } from '../schemas';
import type { StoredLoreEntry, LoreRetrievalOptions, EmbeddingDimensionColumn } from '../types';
import { LORE_DIMENSION_MAP } from '../types';

/**
 * Lore Service
 * Manages character-specific lore entries with hybrid RAG-based retrieval
 * Combines dense vector search with sparse BM25 lexical search
 */
export class LoreService extends Service {
  static serviceType: ServiceTypeName = 'lore' as ServiceTypeName;

  private embeddingDimension?: EmbeddingDimensionColumn;
  private isInitialized = false;
  private bm25Index?: BM25;
  private loreIdToDocIndex: Map<UUID, number> = new Map(); // Maps lore UUID to BM25 doc index
  private loreCountCache?: number; // Cache lore count to avoid repeated queries

  capabilityDescription =
    'Character-specific lore management with hybrid semantic and lexical search using vector embeddings and BM25';

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new LoreService(runtime);
    await service.initialize(runtime);
    return service;
  }

  async stop(): Promise<void> {
    logger.info('LoreService stopped');
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;

    // Ensure embedding dimension is set
    await this.ensureLoreEmbeddingDimension();

    // Initialize BM25 index with optimized parameters for lore retrieval
    this.bm25Index = new BM25([], {
      k1: 1.5, // Slightly higher TF saturation for technical/specific terms
      b: 0.75, // Standard document length normalization
      stemming: true, // Enable Porter2 stemming
      stopWords: new Set([
        'a',
        'an',
        'and',
        'are',
        'as',
        'at',
        'be',
        'by',
        'for',
        'from',
        'has',
        'he',
        'in',
        'is',
        'it',
        'its',
        'of',
        'on',
        'that',
        'the',
        'to',
        'was',
        'were',
        'will',
        'with',
      ]),
      minLength: 2,
      fieldBoosts: {
        loreKey: 2.0, // Boost matches in loreKey (identifiers/tags)
        vectorText: 1.5, // Boost vectorText (semantic keywords)
        content: 1.0, // Standard weight for content
      },
    });

    // Load lore entries from character if present
    if (runtime.character?.lore && Array.isArray(runtime.character.lore)) {
      await this.loadCharacterLore(runtime.character.lore);
    }

    // Cache the lore count for fast checks
    await this.refreshLoreCount();

    this.isInitialized = true;
    logger.info(
      {
        agentId: runtime.agentId,
        agentName: runtime.character.name,
        loreCount: this.loreCountCache || 0,
        embeddingDimension: this.embeddingDimension,
        bm25Enabled: !!this.bm25Index,
      },
      'LoreService initialized with hybrid search'
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
   * Refresh the cached lore count
   * Called internally after mutations (store, delete, etc.)
   */
  private async refreshLoreCount(): Promise<void> {
    try {
      const db = this.getDb();
      const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(lorebookTable)
        .where(eq(lorebookTable.agentId, this.runtime.agentId));

      this.loreCountCache = Number(result[0]?.count) || 0;
    } catch (error) {
      logger.error('Failed to refresh lore count:', JSON.stringify(error));
      this.loreCountCache = undefined;
    }
  }

  /**
   * Ensure embedding dimension is set dynamically based on the model
   */
  private async ensureLoreEmbeddingDimension(): Promise<void> {
    try {
      const embeddingModel = this.runtime.getModel(ModelType.TEXT_EMBEDDING);
      if (!embeddingModel) {
        logger.warn('No TEXT_EMBEDDING model registered. Lore embeddings will not be generated.');
        return;
      }

      // Generate a test embedding to determine dimension
      const testEmbedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text: 'test',
      });

      if (!testEmbedding || !Array.isArray(testEmbedding)) {
        throw new Error('Invalid embedding received from model');
      }

      const dimension = testEmbedding.length;
      const dimensionColumn = LORE_DIMENSION_MAP[dimension];

      if (!dimensionColumn) {
        throw new Error(
          `Unsupported embedding dimension: ${dimension}. Supported dimensions: ${Object.keys(LORE_DIMENSION_MAP).join(', ')}`
        );
      }

      this.embeddingDimension = dimensionColumn;
      logger.info(`Lore embedding dimension set to ${dimension} (${dimensionColumn})`);
    } catch (error) {
      logger.error('Failed to ensure lore embedding dimension:', JSON.stringify(error));
      throw error;
    }
  }

  /**
   * Load character lore entries into the database
   */
  private async loadCharacterLore(loreEntries: LoreEntry[]): Promise<void> {
    if (!loreEntries || loreEntries.length === 0) {
      return;
    }

    const db = this.getDb();

    logger.info(`Loading ${loreEntries.length} lore entries for agent ${this.runtime.agentId}`);

    // Check which lore entries already exist
    const existingLoreKeys = await db
      .select({ loreKey: lorebookTable.loreKey })
      .from(lorebookTable)
      .where(eq(lorebookTable.agentId, this.runtime.agentId));

    const existingKeys = new Set(existingLoreKeys.map((row: any) => row.loreKey));

    // Filter out entries that already exist
    const newEntries = loreEntries.filter((entry) => !existingKeys.has(entry.loreKey));

    if (newEntries.length === 0) {
      logger.info('All lore entries already exist in database');
      return;
    }

    logger.info(`Inserting ${newEntries.length} new lore entries`);

    // Insert lore entries with embeddings
    for (const entry of newEntries) {
      try {
        await this.storeLoreEntry(entry);
      } catch (error) {
        logger.error(`Failed to store lore entry ${entry.loreKey}:`, JSON.stringify(error));
        // Continue with other entries
      }
    }

    logger.success(`Successfully loaded ${newEntries.length} lore entries`);

    // Refresh count cache
    await this.refreshLoreCount();
  }

  /**
   * Store a single lore entry with embedding and BM25 indexing
   */
  async storeLoreEntry(entry: LoreEntry): Promise<UUID> {
    const db = this.getDb();
    const loreId = uuidv4() as UUID;

    // Generate embedding from vectorText
    let embedding: number[] | undefined;
    if (this.embeddingDimension) {
      try {
        embedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
          text: entry.vectorText,
        });
      } catch (error) {
        logger.warn(
          `Failed to generate embedding for lore entry ${entry.loreKey}:`,
          JSON.stringify(error)
        );
      }
    }

    await db.transaction(async (tx: any) => {
      // Insert lore entry
      await tx.insert(lorebookTable).values({
        id: loreId,
        agentId: this.runtime.agentId,
        loreKey: entry.loreKey,
        vectorText: entry.vectorText,
        content: entry.content,
        metadata: entry.metadata || {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Insert embedding if available
      if (embedding && this.embeddingDimension) {
        const embeddingValues: any = {
          id: uuidv4(),
          loreId: loreId,
          createdAt: new Date(),
        };

        // Clean the embedding vector
        const cleanVector = embedding.map((n) => (Number.isFinite(n) ? Number(n.toFixed(6)) : 0));
        embeddingValues[this.embeddingDimension] = cleanVector;

        await tx.insert(lorebookEmbeddingsTable).values(embeddingValues);
      }
    });

    // Add to BM25 index
    if (this.bm25Index) {
      try {
        await this.bm25Index.addDocument({
          loreKey: entry.loreKey,
          vectorText: entry.vectorText,
          content: entry.content,
        });
        // Track the mapping between lore ID and BM25 document index
        const docIndex = this.bm25Index.getDocumentCount() - 1;
        this.loreIdToDocIndex.set(loreId, docIndex);

        logger.debug(`Added lore entry ${entry.loreKey} to BM25 index at position ${docIndex}`);
      } catch (error) {
        logger.warn(
          `Failed to add lore entry ${entry.loreKey} to BM25 index:`,
          JSON.stringify(error)
        );
      }
    }

    // Refresh count cache
    await this.refreshLoreCount();

    return loreId;
  }

  /**
   * Get the count of lore entries for the current agent
   * Uses cached value for performance when available
   */
  async getLoreCount(): Promise<number> {
    if (this.loreCountCache !== undefined) {
      return this.loreCountCache;
    }

    await this.refreshLoreCount();
    return this.loreCountCache || 0;
  }

  /**
   * Search for relevant lore entries using semantic similarity
   * This is the main entry point that orchestrates hybrid search
   */
  async searchLore(
    queryText: string,
    options: LoreRetrievalOptions = {}
  ): Promise<StoredLoreEntry[]> {
    const {
      topK = 5,
      fusionStrategy = 'hybrid-rrf',
      includeMetadata = true,
      similarityThreshold = 0.75,
      alpha = 0.7,
      rrfK = 60,
    } = options;

    // Route to appropriate search strategy
    switch (fusionStrategy) {
      case 'vector':
        return this.vectorSearch(queryText, { topK, similarityThreshold, includeMetadata });

      case 'bm25':
        return this.bm25Search(queryText, { topK, includeMetadata });

      case 'hybrid-rrf':
        return this.hybridSearchRRF(queryText, {
          topK,
          similarityThreshold,
          includeMetadata,
          rrfK,
        });

      case 'hybrid-weighted':
        return this.hybridSearchWeighted(queryText, {
          topK,
          similarityThreshold,
          includeMetadata,
          alpha,
        });

      default:
        // Default to RRF hybrid search
        return this.hybridSearchRRF(queryText, {
          topK,
          similarityThreshold,
          includeMetadata,
          rrfK,
        });
    }
  }

  /**
   * BM25 lexical search
   * Best for: exact matches, acronyms, technical terms, specific identifiers
   */
  private async bm25Search(
    queryText: string,
    options: { topK: number; includeMetadata: boolean }
  ): Promise<StoredLoreEntry[]> {
    if (!this.bm25Index) {
      logger.warn('BM25 index not initialized, returning empty results');
      return [];
    }

    const { topK, includeMetadata } = options;

    try {
      // Execute BM25 search
      const bm25Results = this.bm25Index.search(queryText, topK);

      if (bm25Results.length === 0) {
        return [];
      }

      // Get all lore entries from database
      const allLore = await this.getAllLore();

      // Map BM25 results to stored lore entries
      const results: StoredLoreEntry[] = [];
      for (const result of bm25Results) {
        const loreEntry = allLore[result.index];
        if (loreEntry) {
          results.push({
            ...loreEntry,
            similarity: result.score / 10, // Normalize BM25 score to 0-1 range (approximate)
            metadata: includeMetadata ? loreEntry.metadata : {},
          });
        }
      }

      logger.info(`BM25 search returned ${results.length} results`);
      return results;
    } catch (error) {
      logger.error('Failed to execute BM25 search:', JSON.stringify(error));
      return [];
    }
  }

  /**
   * Dense vector semantic search
   * Best for: conceptual queries, natural language, understanding intent
   */
  private async vectorSearch(
    queryText: string,
    options: { topK: number; similarityThreshold: number; includeMetadata: boolean }
  ): Promise<StoredLoreEntry[]> {
    const { topK, similarityThreshold, includeMetadata } = options;

    logger.debug(
      { topK, similarityThreshold, includeMetadata },
      '##### LoreService: Vector search options'
    );

    if (!this.embeddingDimension) {
      logger.warn('Embedding dimension not set, returning empty results');
      return [];
    }

    const db = this.getDb();

    try {
      // Generate query embedding
      const queryEmbedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text: queryText,
      });

      if (!queryEmbedding || !Array.isArray(queryEmbedding)) {
        logger.warn('Failed to generate query embedding');
        return [];
      }

      // Clean the vector
      const cleanVector = queryEmbedding.map((n) =>
        Number.isFinite(n) ? Number(n.toFixed(6)) : 0
      );

      // Calculate similarity using Drizzle's cosineDistance
      const similarity = sql<number>`1 - (${cosineDistance(
        lorebookEmbeddingsTable[this.embeddingDimension],
        cleanVector
      )})`;

      const conditions = [
        eq(lorebookTable.agentId, this.runtime.agentId),
        sql`${lorebookEmbeddingsTable[this.embeddingDimension]} IS NOT NULL`,
      ];

      // Add similarity threshold
      if (similarityThreshold > 0) {
        conditions.push(gte(similarity, similarityThreshold));
      }

      const results = await db
        .select({
          lore: lorebookTable,
          embedding: lorebookEmbeddingsTable[this.embeddingDimension],
          similarity,
        })
        .from(lorebookTable)
        .innerJoin(lorebookEmbeddingsTable, eq(lorebookEmbeddingsTable.loreId, lorebookTable.id))
        .where(and(...conditions))
        .orderBy(desc(similarity))
        .limit(topK);

      logger.debug({ results }, '##### LoreService: Vector search results');

      return results.map((row: any) => ({
        id: row.lore.id as UUID,
        agentId: row.lore.agentId as UUID,
        loreKey: row.lore.loreKey,
        vectorText: row.lore.vectorText,
        content: row.lore.content,
        metadata: includeMetadata ? (row.lore.metadata as Record<string, unknown>) : {},
        embedding: row.embedding as number[],
        similarity: row.similarity,
        createdAt: row.lore.createdAt,
        updatedAt: row.lore.updatedAt,
      }));
    } catch (error) {
      logger.error('Failed to execute vector search:', JSON.stringify(error));
      return [];
    }
  }

  /**
   * Hybrid search using Reciprocal Rank Fusion (RRF)
   * Combines vector and BM25 results without score normalization
   */
  private async hybridSearchRRF(
    queryText: string,
    options: { topK: number; similarityThreshold: number; includeMetadata: boolean; rrfK: number }
  ): Promise<StoredLoreEntry[]> {
    const { topK, similarityThreshold, includeMetadata, rrfK } = options;

    try {
      // Execute both searches in parallel
      const [vectorResults, bm25Results] = await Promise.all([
        this.vectorSearch(queryText, {
          topK: topK * 2, // Fetch more for better fusion
          similarityThreshold,
          includeMetadata: true,
        }),
        this.bm25Search(queryText, {
          topK: topK * 2,
          includeMetadata: true,
        }),
      ]);

      // Apply Reciprocal Rank Fusion
      const fusedResults = this.reciprocalRankFusion(vectorResults, bm25Results, rrfK);

      // Limit to topK and format
      return fusedResults.slice(0, topK).map((entry) => ({
        ...entry,
        metadata: includeMetadata ? entry.metadata : {},
      }));
    } catch (error) {
      logger.error('Failed to execute hybrid RRF search:', JSON.stringify(error));
      // Fallback to vector search only
      return this.vectorSearch(queryText, { topK, similarityThreshold, includeMetadata });
    }
  }

  /**
   * Hybrid search using weighted linear combination
   * Requires score normalization
   */
  private async hybridSearchWeighted(
    queryText: string,
    options: { topK: number; similarityThreshold: number; includeMetadata: boolean; alpha: number }
  ): Promise<StoredLoreEntry[]> {
    const { topK, similarityThreshold, includeMetadata, alpha } = options;

    try {
      // Execute both searches in parallel
      const [vectorResults, bm25Results] = await Promise.all([
        this.vectorSearch(queryText, {
          topK: topK * 2,
          similarityThreshold,
          includeMetadata: true,
        }),
        this.bm25Search(queryText, {
          topK: topK * 2,
          includeMetadata: true,
        }),
      ]);

      // Apply weighted fusion
      const fusedResults = this.weightedFusion(vectorResults, bm25Results, alpha);

      // Limit to topK and format
      return fusedResults.slice(0, topK).map((entry) => ({
        ...entry,
        metadata: includeMetadata ? entry.metadata : {},
      }));
    } catch (error) {
      logger.error('Failed to execute hybrid weighted search:', JSON.stringify(error));
      // Fallback to vector search only
      return this.vectorSearch(queryText, { topK, similarityThreshold, includeMetadata });
    }
  }

  /**
   * Reciprocal Rank Fusion (RRF)
   * Formula: RRF_score(d) = Σ 1 / (k + rank_i(d))
   * where k=60 is the standard constant from Cormack et al.
   */
  private reciprocalRankFusion(
    vectorResults: StoredLoreEntry[],
    bm25Results: StoredLoreEntry[],
    k: number = 60
  ): StoredLoreEntry[] {
    const scoreMap = new Map<string, { entry: StoredLoreEntry; score: number }>();

    // Process vector results
    vectorResults.forEach((entry, rank) => {
      const key = entry.id;
      const rrfScore = 1 / (k + rank + 1);
      scoreMap.set(key, { entry, score: rrfScore });
    });

    // Process BM25 results
    bm25Results.forEach((entry, rank) => {
      const key = entry.id;
      const rrfScore = 1 / (k + rank + 1);
      const existing = scoreMap.get(key);

      if (existing) {
        // Document appears in both lists - add scores
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { entry, score: rrfScore });
      }
    });

    // Sort by RRF score and return
    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .map((item) => ({
        ...item.entry,
        similarity: item.score, // Store RRF score as similarity
      }));
  }

  /**
   * Weighted linear combination with min-max normalization
   * Final_score = alpha * norm(vector_score) + (1-alpha) * norm(bm25_score)
   */
  private weightedFusion(
    vectorResults: StoredLoreEntry[],
    bm25Results: StoredLoreEntry[],
    alpha: number = 0.7
  ): StoredLoreEntry[] {
    // Normalize scores using min-max
    const normalizeScores = (results: StoredLoreEntry[]): Map<string, number> => {
      const scores = results.map((r) => r.similarity || 0);
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const range = max - min;

      const normalized = new Map<string, number>();
      results.forEach((entry) => {
        const score = entry.similarity || 0;
        const normalizedScore = range > 0 ? (score - min) / range : 0;
        normalized.set(entry.id, normalizedScore);
      });

      return normalized;
    };

    const vectorScores = normalizeScores(vectorResults);
    const bm25Scores = normalizeScores(bm25Results);

    // Combine all unique entries
    const allEntries = new Map<string, StoredLoreEntry>();
    vectorResults.forEach((entry) => allEntries.set(entry.id, entry));
    bm25Results.forEach((entry) => allEntries.set(entry.id, entry));

    // Calculate weighted scores
    const fusedResults = Array.from(allEntries.values()).map((entry) => {
      const vectorScore = vectorScores.get(entry.id) || 0;
      const bm25Score = bm25Scores.get(entry.id) || 0;
      const finalScore = alpha * vectorScore + (1 - alpha) * bm25Score;

      return {
        ...entry,
        similarity: finalScore,
      };
    });

    // Sort by final score
    return fusedResults.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
  }

  /**
   * Get all lore entries for the current agent
   */
  async getAllLore(): Promise<StoredLoreEntry[]> {
    const db = this.getDb();

    const results = await db
      .select()
      .from(lorebookTable)
      .where(eq(lorebookTable.agentId, this.runtime.agentId))
      .orderBy(lorebookTable.loreKey);

    return results.map((row: any) => ({
      id: row.id as UUID,
      agentId: row.agentId as UUID,
      loreKey: row.loreKey,
      vectorText: row.vectorText,
      content: row.content,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  /**
   * Delete a lore entry by ID
   */
  async deleteLoreEntry(loreId: UUID): Promise<void> {
    const db = this.getDb();

    await db.transaction(async (tx: any) => {
      // Delete embedding (cascade should handle this, but being explicit)
      await tx.delete(lorebookEmbeddingsTable).where(eq(lorebookEmbeddingsTable.loreId, loreId));

      // Delete lore entry
      await tx.delete(lorebookTable).where(eq(lorebookTable.id, loreId));
    });

    // Refresh count cache
    await this.refreshLoreCount();

    logger.info(`Deleted lore entry: ${loreId}`);
  }

  /**
   * Delete all lore entries for the current agent
   */
  async deleteAllLore(): Promise<void> {
    const db = this.getDb();

    const loreEntries = await db
      .select({ id: lorebookTable.id })
      .from(lorebookTable)
      .where(eq(lorebookTable.agentId, this.runtime.agentId));

    const loreIds = loreEntries.map((row: any) => row.id);

    if (loreIds.length === 0) {
      return;
    }

    await db.transaction(async (tx: any) => {
      // Delete embeddings
      for (const loreId of loreIds) {
        await tx.delete(lorebookEmbeddingsTable).where(eq(lorebookEmbeddingsTable.loreId, loreId));
      }

      // Delete lore entries
      await tx.delete(lorebookTable).where(eq(lorebookTable.agentId, this.runtime.agentId));
    });

    // Refresh count cache
    await this.refreshLoreCount();

    logger.info(`Deleted ${loreIds.length} lore entries for agent ${this.runtime.agentId}`);
  }
}
