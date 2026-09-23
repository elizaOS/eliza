/**
 * Owns hosted runtime reuse and retains evicted generations until strict teardown.
 * Per-agent eviction keeps shared storage open; full shutdown joins all admitted
 * work before closing adapters, including those retained after completed eviction.
 */
import { createHash } from "node:crypto";
import { ElizaError, type UUID } from "@elizaos/common";
import { type AgentRuntime, elizaLogger, type IDatabaseAdapter } from "@elizaos/core";
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
  private clearing: Promise<void> | undefined;
  private readonly retiredAdapters = new Set<IDatabaseAdapter>();
  private readonly retired = new Map<
    AgentRuntime,
    {
      agentId: UUID;
      completion: Promise<void>;
    }
  >();
  private readonly MAX_SIZE = 50;
  private readonly MAX_AGE_MS = 30 * 60 * 1000;
  private readonly IDLE_TIMEOUT_MS = 10 * 60 * 1000;

  private isStale(entry: CachedRuntime, now: number): boolean {
    return now - entry.createdAt > this.MAX_AGE_MS || now - entry.lastUsed > this.IDLE_TIMEOUT_MS;
  }

  /** Own teardown of an evicted or unpublished runtime without closing its adapter. */
  retire(runtime: AgentRuntime): void {
    const agentId = runtime.agentId;
    this.retiredAdapters.add(runtime.adapter);
    if (this.retired.has(runtime)) return;
    // Defer hooks until the retirement is visible, including to reentrant callers.
    const completion = Promise.resolve().then(() => runtime.stop({ requireQuiescence: true }));
    const retirement = { agentId, completion };
    this.retired.set(runtime, retirement);
    void completion.then(
      () => {
        if (this.retired.get(runtime) === retirement) {
          this.retired.delete(runtime);
        }
      },
      (error) => {
        // error-policy:J5 Agent drain or full shutdown observes the retained original rejection.
        elizaLogger.warn(
          { agentId, error },
          "[RuntimeCache] Runtime retirement remains incomplete",
        );
      },
    );
  }

  /** Joins evicted generations, including failures and work outliving bounded stop.
   * The caller must separately fence runtime creation; this does not grant migration admission.
   */
  async drainRetiredByAgentId(agentId: string): Promise<void> {
    for (;;) {
      const retirements = [...this.retired.values()].filter((entry) => entry.agentId === agentId);
      if (retirements.length === 0) return;
      await Promise.all(retirements.map((entry) => entry.completion));
    }
  }

  private async evictEntry(
    key: string,
    entry: CachedRuntime,
    reason: string,
    dbPool?: DbAdapterPool,
  ): Promise<boolean> {
    if (this.cache.get(key) !== entry) return false;
    // Revoke reuse synchronously, before stop hooks can reenter the cache.
    this.cache.delete(key);
    this.retire(entry.runtime);
    dbPool?.removeAdapter(entry.agentId, entry.runtime.adapter);
    await stopRuntimeServices(entry.runtime, key, "RuntimeCache");
    elizaLogger.debug(`[RuntimeCache] Evicted ${reason} runtime: ${key} (adapter kept alive)`);
    return true;
  }

  async get(agentId: string): Promise<AgentRuntime | null> {
    if (this.clearing) return null;
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
    if (this.clearing) return null;
    const entry = this.cache.get(agentId);
    if (!entry) return null;

    const now = Date.now();
    if (this.isStale(entry, now)) {
      await this.evictEntry(agentId, entry, "stale", dbPool);
      return null;
    }

    if (currentMcpVersion !== undefined && entry.mcpVersion < currentMcpVersion) {
      elizaLogger.info(
        `[RuntimeCache] MCP version stale: cached=${entry.mcpVersion}, current=${currentMcpVersion}, key=${agentId}`,
      );
      await this.evictEntry(agentId, entry, "mcp-version-stale", dbPool);
      return null;
    }

    const isHealthy = await dbPool.checkHealth(entry.agentId as UUID);
    if (this.cache.get(agentId) !== entry) return null;
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
    assertAdmission?: () => void,
  ): Promise<void> {
    this.assertOpen();
    assertAdmission?.();
    if (!this.cache.has(cacheKey) && this.cache.size >= this.MAX_SIZE) {
      await this.evictOldest();
    }
    this.assertOpen();
    assertAdmission?.();

    // Capacity eviction may yield while another creator publishes this same key.
    // Retain that exact generation before replacing it, without closing its adapter.
    const previous = this.cache.get(cacheKey);
    if (previous && previous.runtime !== runtime) {
      this.retire(previous.runtime);
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

    return this.evictEntry(agentId, entry, "removed");
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
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!organizationId || !UUID_RE.test(organizationId)) {
      return 0;
    }

    const entries = Array.from(this.cache.entries()).filter(([key]) =>
      key.includes(`:${organizationId}`),
    );

    const removed = await Promise.all(
      entries.map(([key, entry]) => this.evictEntry(key, entry, "organization", dbPool)),
    );

    return removed.filter(Boolean).length;
  }

  private assertOpen(): void {
    if (this.clearing) {
      throw new ElizaError("Runtime cache shutdown is in progress or failed", {
        code: "RUNTIME_CACHE_SHUTTING_DOWN",
      });
    }
  }

  /** Full shutdown only: the factory must first fence and join its creations.
   * Shared adapters stay open until every active or evicted runtime is quiescent.
   */
  clear(dbPool: DbAdapterPool): Promise<void> {
    if (this.clearing) return this.clearing;
    this.clearing = Promise.resolve().then(async () => {
      const entries = [...this.cache.values()];
      this.cache.clear();
      for (const entry of entries) this.retire(entry.runtime);
      while (this.retired.size > 0) {
        await Promise.all([...this.retired.values()].map((entry) => entry.completion));
      }
      // Include adapters whose initialization never produced a runtime, and
      // completed evictions whose shared connection remained deliberately open.
      for (const adapter of dbPool.takeForShutdown()) this.retiredAdapters.add(adapter);
      const closed = await Promise.allSettled(
        [...this.retiredAdapters].map(async (adapter) => {
          await adapter.close();
          this.retiredAdapters.delete(adapter);
        }),
      );
      const failure = closed.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        throw new ElizaError("Hosted runtime database shutdown failed; admission remains closed", {
          code: "RUNTIME_DATABASE_SHUTDOWN_FAILED",
          cause: failure.reason,
        });
      }
      this.clearing = undefined;
    });
    return this.clearing;
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
