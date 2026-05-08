import { createHash } from "node:crypto";
import { type AgentRuntime, elizaLogger, type UUID } from "@elizaos/core";
import type { DbAdapterPool } from "./database/adapter-pool";
import { safeClose, stopRuntimeServices } from "./lifecycle";
import { stableSerialize } from "./stable-serialize";

export interface CachedRuntime {
  runtime: AgentRuntime;
  lastUsed: number;
  createdAt: number;
  agentId: UUID;
  characterName: string;
  /** MCP config version at creation time (for cross-instance invalidation). */
  mcpVersion: number;
}

export interface RuntimeCacheKeyParts {
  agentId: UUID;
  organizationId: string;
  effectiveMode: string;
  pluginNames: string[];
  webSearchEnabled?: boolean;
  mcpPlatforms?: string[];
  directContextSignature?: string;
}

export function buildRuntimeCacheKey(parts: RuntimeCacheKeyParts): string {
  const pluginProfile = createHash("sha1")
    .update(stableSerialize(parts.pluginNames))
    .digest("hex")
    .slice(0, 12);
  const webSearchSuffix = parts.webSearchEnabled ? ":ws" : "";
  const mcpPlatforms = [...(parts.mcpPlatforms ?? [])].sort();
  const mcpSuffix = mcpPlatforms.length > 0 ? `:mcp=${mcpPlatforms.join(",")}` : "";
  const contextSuffix = parts.directContextSignature ? `:ctx=${parts.directContextSignature}` : "";

  return `${parts.agentId}:${parts.organizationId}:mode=${parts.effectiveMode}:profile=${pluginProfile}${webSearchSuffix}${mcpSuffix}${contextSuffix}`;
}

export class RuntimeCache {
  private cache = new Map<string, CachedRuntime>();
  private readonly MAX_SIZE = 50;
  private readonly MAX_AGE_MS = 30 * 60 * 1000;
  private readonly IDLE_TIMEOUT_MS = 10 * 60 * 1000;

  private isStale(entry: CachedRuntime, now: number): boolean {
    return now - entry.createdAt > this.MAX_AGE_MS || now - entry.lastUsed > this.IDLE_TIMEOUT_MS;
  }

  private async evictEntry(key: string, entry: CachedRuntime, reason: string): Promise<void> {
    await stopRuntimeServices(entry.runtime, key, "RuntimeCache");
    this.cache.delete(key);
    elizaLogger.debug(`[RuntimeCache] Evicted ${reason} runtime: ${key} (adapter kept alive)`);
  }

  async get(agentId: string): Promise<AgentRuntime | null> {
    const entry = this.cache.get(agentId);
    if (!entry) return null;

    const now = Date.now();
    if (this.isStale(entry, now)) {
      await this.evictEntry(agentId, entry, "stale");
      return null;
    }

    entry.lastUsed = now;
    return entry.runtime;
  }

  async getWithHealthCheck(
    agentId: string,
    dbPool: DbAdapterPool,
    currentMcpVersion?: number,
  ): Promise<AgentRuntime | null> {
    const entry = this.cache.get(agentId);
    if (!entry) return null;

    const now = Date.now();
    if (this.isStale(entry, now)) {
      await this.evictEntry(agentId, entry, "stale");
      dbPool.removeAdapter(entry.agentId as string);
      return null;
    }

    if (currentMcpVersion !== undefined && entry.mcpVersion < currentMcpVersion) {
      elizaLogger.info(
        `[RuntimeCache] MCP version stale: cached=${entry.mcpVersion}, current=${currentMcpVersion}, key=${agentId}`,
      );
      await this.evictEntry(agentId, entry, "mcp-version-stale");
      dbPool.removeAdapter(entry.agentId as string);
      return null;
    }

    const isHealthy = await dbPool.checkHealth(entry.agentId as UUID);
    if (!isHealthy) {
      await this.evictEntry(agentId, entry, "unhealthy");
      return null;
    }

    entry.lastUsed = now;
    return entry.runtime;
  }

  async set(
    cacheKey: string,
    runtime: AgentRuntime,
    characterName: string,
    actualAgentId: UUID,
    mcpVersion = 0,
  ): Promise<void> {
    if (this.cache.size >= this.MAX_SIZE) {
      await this.evictOldest();
    }

    const now = Date.now();
    this.cache.set(cacheKey, {
      runtime,
      lastUsed: now,
      createdAt: now,
      agentId: actualAgentId,
      characterName,
      mcpVersion,
    });
    elizaLogger.debug(
      `[RuntimeCache] Cached runtime: ${characterName} (${actualAgentId}, key=${cacheKey}, mcpVersion=${mcpVersion})`,
    );
  }

  /** Remove runtime from cache and keep the adapter pool alive. */
  async remove(agentId: string): Promise<boolean> {
    const entry = this.cache.get(agentId);
    if (!entry) return false;

    await stopRuntimeServices(entry.runtime, agentId, "RuntimeCache");
    this.cache.delete(agentId);
    elizaLogger.info(`[RuntimeCache] Removed runtime: ${agentId} (adapter kept alive)`);
    return true;
  }

  async removeByAgentId(agentId: string): Promise<number> {
    const keys = Array.from(this.cache.keys()).filter(
      (key) => key === agentId || key.startsWith(`${agentId}:`),
    );

    await Promise.all(keys.map((key) => this.remove(key)));
    return keys.length;
  }

  /** Delete runtime and close completely. Use only for full shutdown. */
  async delete(agentId: string): Promise<boolean> {
    const entry = this.cache.get(agentId);
    if (entry) {
      await stopRuntimeServices(entry.runtime, agentId, "RuntimeCache");
      await safeClose(entry.runtime, "RuntimeCache", agentId);
      this.cache.delete(agentId);
      elizaLogger.info(`[RuntimeCache] Deleted runtime: ${agentId} (fully closed)`);
      return true;
    }
    return false;
  }

  has(agentId: string): boolean {
    for (const key of this.cache.keys()) {
      if (key.startsWith(agentId)) {
        return true;
      }
    }
    return false;
  }

  private async evictOldest(): Promise<void> {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastUsed < oldestTime) {
        oldestKey = key;
        oldestTime = entry.lastUsed;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey);
      if (entry) {
        await this.evictEntry(oldestKey, entry, "oldest");
      }
    }
  }

  getStats(): { size: number; maxSize: number } {
    return { size: this.cache.size, maxSize: this.MAX_SIZE };
  }

  /** Remove all runtimes for an organization. */
  async removeByOrganization(organizationId: string, dbPool: DbAdapterPool): Promise<number> {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!organizationId || !UUID_RE.test(organizationId)) {
      return 0;
    }

    const entries = Array.from(this.cache.entries()).filter(([key]) =>
      key.includes(`:${organizationId}`),
    );

    await Promise.all(
      entries.map(async ([key, entry]) => {
        await stopRuntimeServices(entry.runtime, key, "RuntimeCache");
        this.cache.delete(key);
        dbPool.removeAdapter(entry.agentId as string);
      }),
    );

    return entries.length;
  }

  /** Clear all cached runtimes. WARNING: Closes shared connection pool. */
  async clear(): Promise<void> {
    const entries = Array.from(this.cache.entries());
    await Promise.all(
      entries.map(([id, entry]) => stopRuntimeServices(entry.runtime, id, "RuntimeCache")),
    );
    await Promise.all(entries.map(([id, entry]) => safeClose(entry.runtime, "RuntimeCache", id)));
    this.cache.clear();
  }

  entriesForTesting(): Map<string, CachedRuntime> {
    return new Map(this.cache);
  }

  keysForAgentForTesting(agentId: string): string[] {
    return Array.from(this.cache.keys()).filter(
      (key) => key === agentId || key.startsWith(`${agentId}:`),
    );
  }

  getEntryForTesting(key: string): CachedRuntime | undefined {
    return this.cache.get(key);
  }

  deleteEntryForTesting(key: string): void {
    this.cache.delete(key);
  }
}

export const runtimeCache = new RuntimeCache();
