/**
 * Edge-Compatible Runtime State Cache
 *
 * Provides a shared cache layer that works in both Edge and Node.js runtimes.
 * Uses Upstash Redis for edge compatibility.
 *
 * Tracks runtime warm state (is warm, embedding dimension set, request count).
 */

import { Redis } from "@upstash/redis";
import { logger } from "@/lib/utils/logger";

// Initialize Redis client (works in both Edge and Node.js)
const getRedis = (): Redis | null => {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return null;
  }

  return new Redis({ url, token });
};

const EDGE_CACHE_PREFIX = "edge:runtime:";

export interface RuntimeWarmState {
  /** Whether the runtime is initialized and warm */
  isWarm: boolean;
  /** When the runtime was last warmed */
  warmedAt: number;
  /** Embedding dimension that was set */
  embeddingDimension: number;
  /** Character name for this runtime */
  characterName?: string;
  /** Number of requests served since warm */
  requestCount: number;
}

/**
 * Edge-compatible runtime state cache
 */
export class EdgeRuntimeCache {
  private redis: Redis | null = null;

  private readonly WARM_STATE_TTL = 300; // 5 minutes

  constructor() {
    this.redis = getRedis();
  }

  /**
   * Mark runtime as warm after initialization
   */
  async markRuntimeWarm(
    agentId: string,
    state: Omit<RuntimeWarmState, "warmedAt" | "requestCount">,
  ): Promise<void> {
    if (!this.redis) return;

    try {
      const fullState: RuntimeWarmState = {
        ...state,
        warmedAt: Date.now(),
        requestCount: 0,
      };

      await this.redis.setex(
        `${EDGE_CACHE_PREFIX}warm:${agentId}`,
        this.WARM_STATE_TTL,
        JSON.stringify(fullState),
      );

      logger.debug(`[EdgeCache] Marked runtime warm: ${agentId}`);
    } catch (error) {
      logger.warn(`[EdgeCache] Failed to mark runtime warm: ${error}`);
    }
  }

  /**
   * Increment request count for a warm runtime (for analytics)
   */
  async incrementRequestCount(agentId: string): Promise<void> {
    if (!this.redis) return;

    try {
      const key = `${EDGE_CACHE_PREFIX}warm:${agentId}`;
      const state = await this.redis.get<string>(key);

      if (state) {
        const parsed = JSON.parse(state) as RuntimeWarmState;
        parsed.requestCount++;

        // Refresh TTL on activity
        await this.redis.setex(
          key,
          this.WARM_STATE_TTL,
          JSON.stringify(parsed),
        );
      }
    } catch (error) {
      // Non-critical, ignore
    }
  }

  /**
   * Invalidate character warm state (call when character is updated)
   */
  async invalidateCharacter(characterId: string): Promise<void> {
    if (!this.redis) return;

    try {
      await this.redis.del(`${EDGE_CACHE_PREFIX}warm:${characterId}`);
      logger.debug(`[EdgeCache] Invalidated character: ${characterId}`);
    } catch (error) {
      logger.warn(`[EdgeCache] Failed to invalidate character: ${error}`);
    }
  }
}

// Export singleton instance
export const edgeRuntimeCache = new EdgeRuntimeCache();

/**
 * Export the static embedding dimension lookup for use in Edge
 * This allows Edge middleware to know the dimension without calling Node.js
 */
export const KNOWN_EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  "embed-english-v3.0": 1024,
  "embed-multilingual-v3.0": 1024,
  "voyage-large-2": 1536,
  "voyage-code-2": 1536,
  default: 1536,
};

export function getStaticEmbeddingDimension(model?: string): number {
  if (!model) return KNOWN_EMBEDDING_DIMENSIONS["default"];

  if (KNOWN_EMBEDDING_DIMENSIONS[model]) {
    return KNOWN_EMBEDDING_DIMENSIONS[model];
  }

  for (const [key, dim] of Object.entries(KNOWN_EMBEDDING_DIMENSIONS)) {
    if (model.includes(key)) {
      return dim;
    }
  }

  return KNOWN_EMBEDDING_DIMENSIONS["default"];
}
