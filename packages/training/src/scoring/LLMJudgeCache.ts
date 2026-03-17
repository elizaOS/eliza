/**
 * LLMJudgeCache
 *
 * Caches LLM-as-judge scoring results to:
 * 1. Avoid redundant API calls for identical trajectories
 * 2. Enable fast re-scoring when rubrics change
 * 3. Provide validation of cached scores
 *
 * Uses content-addressable hashing: cache key = hash(trajectory_content + rubric_version)
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import { getTrainingDataAdapter } from "../adapter";
import { getRubricHash, RUBRICS_VERSION } from "../rubrics";
import { logger } from "../utils/logger";

/**
 * Cached score entry
 */
export interface CachedScore {
  cacheKey: string;
  trajectoryId: string;
  archetype: string;
  score: number;
  reasoning: string;
  strengths: string[];
  weaknesses: string[];
  rubricVersion: string;
  rubricHash: string;
  scoredAt: Date;
  expiresAt: Date;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  hitRate: number;
}

/**
 * Cache configuration
 */
export interface LLMJudgeCacheConfig {
  /** Time-to-live in hours (default: 168 = 1 week) */
  ttlHours: number;
  /** Maximum cache entries (default: 10000) */
  maxEntries: number;
  /** Whether to validate rubric version on cache hit */
  validateRubricVersion: boolean;
}

const DEFAULT_CONFIG: LLMJudgeCacheConfig = {
  ttlHours: 168, // 1 week
  maxEntries: 10000,
  validateRubricVersion: true,
};

/**
 * In-memory LLM judge cache with validation
 */
export class LLMJudgeCache {
  private cache: Map<string, CachedScore> = new Map();
  private config: LLMJudgeCacheConfig;
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    invalidations: 0,
    hitRate: 0,
  };

  constructor(config: Partial<LLMJudgeCacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate a cache key from trajectory content and archetype
   */
  private generateCacheKey(
    trajectoryId: string,
    stepsJson: string,
    archetype: string,
  ): string {
    const content = `${trajectoryId}:${stepsJson}:${archetype}:${RUBRICS_VERSION}`;
    return createHash("sha256").update(content).digest("hex").substring(0, 32);
  }

  /**
   * Check if a cached score is valid
   */
  private isValid(cached: CachedScore, archetype: string): boolean {
    // Check expiration
    if (new Date() > cached.expiresAt) {
      return false;
    }

    // Check rubric version if validation is enabled
    if (this.config.validateRubricVersion) {
      if (cached.rubricVersion !== RUBRICS_VERSION) {
        return false;
      }

      // Check rubric hash for this specific archetype
      const currentRubricHash = getRubricHash(archetype);
      if (cached.rubricHash !== currentRubricHash) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get a cached score if available and valid
   */
  get(
    trajectoryId: string,
    stepsJson: string,
    archetype: string,
  ): CachedScore | null {
    const cacheKey = this.generateCacheKey(trajectoryId, stepsJson, archetype);
    const cached = this.cache.get(cacheKey);

    if (!cached) {
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    if (!this.isValid(cached, archetype)) {
      this.cache.delete(cacheKey);
      this.stats.invalidations++;
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    this.stats.hits++;
    this.updateHitRate();

    logger.debug(
      "Cache hit",
      { trajectoryId, archetype, cacheKey: cacheKey.substring(0, 8) },
      "LLMJudgeCache",
    );

    return cached;
  }

  /**
   * Store a score in the cache
   */
  set(
    trajectoryId: string,
    stepsJson: string,
    archetype: string,
    score: number,
    reasoning: string,
    strengths: string[] = [],
    weaknesses: string[] = [],
  ): void {
    // Enforce max entries limit
    if (this.cache.size >= this.config.maxEntries) {
      this.evictOldest();
    }

    const cacheKey = this.generateCacheKey(trajectoryId, stepsJson, archetype);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.config.ttlHours * 60 * 60 * 1000,
    );

    const entry: CachedScore = {
      cacheKey,
      trajectoryId,
      archetype,
      score,
      reasoning,
      strengths,
      weaknesses,
      rubricVersion: RUBRICS_VERSION,
      rubricHash: getRubricHash(archetype),
      scoredAt: now,
      expiresAt,
    };

    this.cache.set(cacheKey, entry);

    logger.debug(
      "Cache set",
      { trajectoryId, archetype, score, cacheKey: cacheKey.substring(0, 8) },
      "LLMJudgeCache",
    );
  }

  /**
   * Evict the oldest cache entry
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      const entryTime = entry.scoredAt.getTime();
      if (entryTime < oldestTime) {
        oldestTime = entryTime;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Update hit rate statistic
   */
  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }

  /**
   * Invalidate all cache entries for an archetype (when rubric changes)
   */
  invalidateArchetype(archetype: string): number {
    let invalidated = 0;

    for (const [key, entry] of this.cache) {
      if (entry.archetype === archetype) {
        this.cache.delete(key);
        invalidated++;
      }
    }

    this.stats.invalidations += invalidated;

    logger.info(
      "Invalidated cache entries",
      { archetype, count: invalidated },
      "LLMJudgeCache",
    );

    return invalidated;
  }

  /**
   * Invalidate all cache entries
   */
  clear(): void {
    const count = this.cache.size;
    this.cache.clear();
    this.stats.invalidations += count;

    logger.info("Cleared cache", { count }, "LLMJudgeCache");
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Warm cache from database
   * Loads previously scored trajectories into cache
   */
  async warmFromDatabase(limit = 1000): Promise<number> {
    const results = await getTrainingDataAdapter().getScoredTrajectories(limit);

    let loaded = 0;

    for (const row of results) {
      if (row.aiJudgeReward !== null && row.aiJudgeReasoning && row.judgedAt) {
        // Use 'default' archetype for warmed entries since archetype isn't stored
        this.set(
          row.trajectoryId,
          row.stepsJson,
          "default",
          row.aiJudgeReward,
          row.aiJudgeReasoning,
        );
        loaded++;
      }
    }

    logger.info(
      "Warmed cache from database",
      { loaded, attempted: results.length },
      "LLMJudgeCache",
    );

    return loaded;
  }
}

/**
 * Singleton cache instance
 */
export const llmJudgeCache = new LLMJudgeCache();

/**
 * Score validation utilities
 */
export const scoreValidator = {
  /**
   * Validate a score is in valid range
   */
  isValidScore(score: number): boolean {
    return (
      typeof score === "number" &&
      !Number.isNaN(score) &&
      score >= 0 &&
      score <= 1
    );
  },

  /**
   * Validate reasoning is meaningful
   */
  isValidReasoning(reasoning: string): boolean {
    return (
      typeof reasoning === "string" &&
      reasoning.length >= 20 &&
      reasoning.length <= 5000
    );
  },

  /**
   * Validate a complete score response
   */
  isValidScoreResponse(response: {
    score: number;
    reasoning: string;
    strengths?: string[];
    weaknesses?: string[];
  }): boolean {
    return (
      this.isValidScore(response.score) &&
      this.isValidReasoning(response.reasoning)
    );
  },

  /**
   * Check if scores are consistent (similar trajectories should have similar scores)
   */
  checkScoreConsistency(
    scores: Array<{ trajectoryId: string; score: number; metricsHash: string }>,
  ): { consistent: boolean; outliers: string[] } {
    if (scores.length < 3) {
      return { consistent: true, outliers: [] };
    }

    // Group by metrics hash
    const byMetrics = new Map<string, number[]>();
    for (const s of scores) {
      const existing = byMetrics.get(s.metricsHash) || [];
      existing.push(s.score);
      byMetrics.set(s.metricsHash, existing);
    }

    const outliers: string[] = [];

    // Check variance within groups
    for (const [hash, groupScores] of byMetrics) {
      if (groupScores.length < 2) continue;

      const mean = groupScores.reduce((a, b) => a + b) / groupScores.length;
      const variance =
        groupScores.reduce((sum, s) => sum + (s - mean) ** 2, 0) /
        groupScores.length;
      const stdDev = Math.sqrt(variance);

      // Flag if std deviation is too high (inconsistent scoring)
      if (stdDev > 0.2) {
        // Find trajectories in this group
        for (const s of scores) {
          if (s.metricsHash === hash && Math.abs(s.score - mean) > 2 * stdDev) {
            outliers.push(s.trajectoryId);
          }
        }
      }
    }

    return {
      consistent: outliers.length === 0,
      outliers,
    };
  },
};
