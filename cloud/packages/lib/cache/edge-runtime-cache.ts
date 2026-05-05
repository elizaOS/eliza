/**
 * Edge-Compatible Runtime State Cache
 *
 * Provides a shared cache layer that works in both Edge and Node.js runtimes.
 * Uses the shared cache adapter for edge compatibility.
 *
 * Tracks runtime warm state (is warm, embedding dimension set, request count).
 */

import { cache } from "@/lib/cache/client";
import { logger } from "@/lib/utils/logger";

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
  private readonly WARM_STATE_TTL = 300; // 5 minutes

  /**
   * Mark runtime as warm after initialization
   */
  async markRuntimeWarm(
    agentId: string,
    state: Omit<RuntimeWarmState, "warmedAt" | "requestCount">,
  ): Promise<void> {
    if (!cache.isAvailable()) return;

    try {
      const fullState: RuntimeWarmState = {
        ...state,
        warmedAt: Date.now(),
        requestCount: 0,
      };

      await cache.set(`${EDGE_CACHE_PREFIX}warm:${agentId}`, fullState, this.WARM_STATE_TTL);

      logger.debug(`[EdgeCache] Marked runtime warm: ${agentId}`);
    } catch (error) {
      logger.warn(`[EdgeCache] Failed to mark runtime warm: ${error}`);
    }
  }

  /**
   * Increment request count for a warm runtime (for analytics)
   */
  async incrementRequestCount(agentId: string): Promise<void> {
    if (!cache.isAvailable()) return;

    try {
      const key = `${EDGE_CACHE_PREFIX}warm:${agentId}`;
      const state = await cache.get<RuntimeWarmState>(key);

      if (state) {
        state.requestCount++;

        // Refresh TTL on activity
        await cache.set(key, state, this.WARM_STATE_TTL);
      }
    } catch (_error) {
      // Non-critical, ignore
    }
  }

  /**
   * Invalidate character warm state (call when character is updated)
   */
  async invalidateCharacter(characterId: string): Promise<void> {
    if (!cache.isAvailable()) return;

    try {
      await cache.del(`${EDGE_CACHE_PREFIX}warm:${characterId}`);
      logger.debug(`[EdgeCache] Invalidated character: ${characterId}`);
    } catch (error) {
      logger.warn(`[EdgeCache] Failed to invalidate character: ${error}`);
    }
  }

  // ─── MCP Version Tracking (cross-instance cache invalidation) ───────────

  private mcpVersionKey(organizationId: string): string {
    return `${EDGE_CACHE_PREFIX}mcp-version:${organizationId}`;
  }

  /**
   * Bump MCP config version for an org (call on OAuth connect/disconnect).
   * Returns the new version number.
   */
  async bumpMcpVersion(organizationId: string): Promise<number> {
    if (!cache.isAvailable()) return 0;

    try {
      const key = this.mcpVersionKey(organizationId);
      const newVersion = await cache.incr(key);
      // TTL of 24 hours — outlives runtime cache (30 min) to ensure cross-instance invalidation works.
      // If version expires, degrades to local-only eviction (safe fallback).
      await cache.expire(key, 86400);
      logger.info(`[EdgeCache] Bumped MCP version for org ${organizationId}: ${newVersion}`);
      return newVersion;
    } catch (error) {
      logger.warn(`[EdgeCache] Failed to bump MCP version: ${error}`);
      return 0;
    }
  }

  /**
   * Get current MCP config version for an org.
   * Returns 0 if no version exists (no OAuth changes tracked).
   */
  async getMcpVersion(organizationId: string): Promise<number> {
    if (!cache.isAvailable()) return 0;

    try {
      const version = await cache.get<number>(this.mcpVersionKey(organizationId));
      return version ?? 0;
    } catch {
      return 0;
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
