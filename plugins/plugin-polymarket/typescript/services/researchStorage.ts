/**
 * Research Storage Service
 *
 * Manages storage and retrieval of market research data using the Eliza cache system.
 * Research results are stored with expiration tracking to ensure freshness.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { type MarketResearch, ResearchStatus } from "../types";

/** Cache key prefix for research data */
const RESEARCH_CACHE_PREFIX = "polymarket_research:";

/** Default research expiry time (24 hours) */
const DEFAULT_RESEARCH_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Service for managing market research storage
 */
export class ResearchStorageService {
  private runtime: IAgentRuntime;
  private expiryMs: number;

  constructor(runtime: IAgentRuntime, expiryMs?: number) {
    this.runtime = runtime;
    this.expiryMs = expiryMs ?? DEFAULT_RESEARCH_EXPIRY_MS;
  }

  /**
   * Generate cache key for a market
   */
  private getCacheKey(marketId: string): string {
    return `${RESEARCH_CACHE_PREFIX}${marketId}`;
  }

  /**
   * Get research for a specific market
   * Returns null if no research exists
   * Returns with EXPIRED status if research is stale
   */
  async getMarketResearch(marketId: string): Promise<MarketResearch | null> {
    try {
      const key = this.getCacheKey(marketId);
      const research = await this.runtime.getCache<MarketResearch>(key);

      if (!research) {
        return null;
      }

      // Check if research has expired
      if (
        research.status === ResearchStatus.COMPLETED &&
        research.expiresAt &&
        Date.now() > research.expiresAt
      ) {
        logger.debug(`[ResearchStorage] Research for market ${marketId} has expired`);
        return { ...research, status: ResearchStatus.EXPIRED };
      }

      return research;
    } catch (error) {
      logger.error(`[ResearchStorage] Error getting research for market ${marketId}:`, error);
      return null;
    }
  }

  /**
   * Get research by token ID (looks up via market-token mapping)
   */
  async getResearchByTokenId(tokenId: string): Promise<MarketResearch | null> {
    // Token IDs are associated with markets, so we need to search
    // For now, we'll use a secondary cache lookup
    try {
      const mappingKey = `${RESEARCH_CACHE_PREFIX}token:${tokenId}`;
      const marketId = await this.runtime.getCache<string>(mappingKey);

      if (!marketId) {
        return null;
      }

      return this.getMarketResearch(marketId);
    } catch (error) {
      logger.error(`[ResearchStorage] Error getting research by token ${tokenId}:`, error);
      return null;
    }
  }

  /**
   * Mark research as in progress
   */
  async markResearchInProgress(
    marketId: string,
    marketQuestion: string,
    taskId: UUID,
  ): Promise<void> {
    const key = this.getCacheKey(marketId);
    const research: MarketResearch = {
      marketId,
      marketQuestion,
      status: ResearchStatus.IN_PROGRESS,
      taskId,
      startedAt: Date.now(),
    };

    await this.runtime.setCache(key, research);
    logger.info(`[ResearchStorage] Marked research IN_PROGRESS for market: ${marketId}`);
  }

  /**
   * Store completed research results
   */
  async storeResearchResult(
    marketId: string,
    result: MarketResearch["result"],
    researchId: string,
  ): Promise<void> {
    const key = this.getCacheKey(marketId);
    const existing = await this.getMarketResearch(marketId);

    if (!existing) {
      logger.warn(
        `[ResearchStorage] Cannot store result - no existing research for market ${marketId}`,
      );
      return;
    }

    const research: MarketResearch = {
      ...existing,
      status: ResearchStatus.COMPLETED,
      result,
      researchId,
      completedAt: Date.now(),
      expiresAt: Date.now() + this.expiryMs,
    };

    await this.runtime.setCache(key, research);
    logger.info(`[ResearchStorage] Stored COMPLETED research for market: ${marketId}`);
  }

  /**
   * Mark research as failed
   */
  async markResearchFailed(marketId: string, errorMessage: string): Promise<void> {
    const key = this.getCacheKey(marketId);
    const existing = await this.getMarketResearch(marketId);

    const research: MarketResearch = {
      marketId,
      marketQuestion: existing?.marketQuestion ?? "Unknown",
      status: ResearchStatus.FAILED,
      taskId: existing?.taskId,
      startedAt: existing?.startedAt,
      completedAt: Date.now(),
      errorMessage,
    };

    await this.runtime.setCache(key, research);
    logger.error(
      `[ResearchStorage] Marked research FAILED for market ${marketId}: ${errorMessage}`,
    );
  }

  /**
   * Delete research for a market
   */
  async deleteResearch(marketId: string): Promise<void> {
    const key = this.getCacheKey(marketId);
    await this.runtime.deleteCache(key);
    logger.debug(`[ResearchStorage] Deleted research for market: ${marketId}`);
  }

  /**
   * Store token-to-market mapping for token ID lookups
   */
  async storeTokenMapping(tokenId: string, marketId: string): Promise<void> {
    const mappingKey = `${RESEARCH_CACHE_PREFIX}token:${tokenId}`;
    await this.runtime.setCache(mappingKey, marketId);
  }

  /**
   * Check if research is available and current for trading decisions
   */
  async isResearchAvailable(marketId: string): Promise<boolean> {
    const research = await this.getMarketResearch(marketId);
    return research?.status === ResearchStatus.COMPLETED;
  }

  /**
   * Check if research is currently in progress
   */
  async isResearchInProgress(marketId: string): Promise<boolean> {
    const research = await this.getMarketResearch(marketId);
    return research?.status === ResearchStatus.IN_PROGRESS;
  }

  /**
   * Get elapsed time since research started (in minutes)
   */
  async getResearchElapsedMinutes(marketId: string): Promise<number | null> {
    const research = await this.getMarketResearch(marketId);
    if (!research?.startedAt) {
      return null;
    }
    return Math.floor((Date.now() - research.startedAt) / 60000);
  }
}

export default ResearchStorageService;
