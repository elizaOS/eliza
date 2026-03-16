/**
 * Runtime Factory - Creates configured elizaOS runtimes per user/agent context.
 */
import {
  AgentRuntime,
  stringToUuid,
  elizaLogger,
  type UUID,
  type Character,
  type Plugin,
  type IDatabaseAdapter,
  type Logger,
  type World,
} from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql/node";
import mcpPlugin from "@elizaos/plugin-mcp";
import { agentLoader } from "./agent-loader";
import {
  getElizaCloudApiUrl,
  getDefaultModels,
  buildElevenLabsSettings,
} from "./config";
import { DEFAULT_IMAGE_MODEL } from "@/lib/models";
import type { UserContext } from "./user-context";
import { logger } from "@/lib/utils/logger";
import "@/lib/polyfills/dom-polyfills";
import {
  edgeRuntimeCache,
  getStaticEmbeddingDimension,
  KNOWN_EMBEDDING_DIMENSIONS,
} from "@/lib/cache/edge-runtime-cache";

const adapterEmbeddingDimensions = new Map<string, number>();

/**
 * Default agent ID used when no specific character/agent is specified.
 * Exported for use in other modules that need the same default.
 */
export const DEFAULT_AGENT_ID_STRING = "b850bc30-45f8-0041-a00a-83df46d8555d";

const MCP_SERVER_CONFIGS: Record<string, { url: string; type: string }> = {
  google: { url: "/api/mcps/google/mcp", type: "streamable-http" },
  github: { url: "/api/mcps/github/mcp", type: "streamable-http" },
  notion: { url: "/api/mcps/notion/mcp", type: "streamable-http" },
  linear: { url: "/api/mcps/linear/mcp", type: "streamable-http" },
  // twitter: { url: "/api/mcps/twitter/mcp", type: "streamable-http" },
};

interface GlobalWithEliza {
  logger?: Logger;
}

interface RuntimeSettings {
  ELIZAOS_API_KEY?: string;
  ELIZAOS_CLOUD_API_KEY?: string;
  USER_ID?: string;
  ENTITY_ID?: string;
  ORGANIZATION_ID?: string;
  IS_ANONYMOUS?: boolean;
  ELIZAOS_CLOUD_SMALL_MODEL?: string;
  ELIZAOS_CLOUD_LARGE_MODEL?: string;
  ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL?: string;
  appPromptConfig?: unknown;
  [key: string]: unknown;
}

const globalAny = globalThis as GlobalWithEliza;

interface CachedRuntime {
  runtime: AgentRuntime;
  lastUsed: number;
  createdAt: number;
  agentId: UUID;
  characterName: string;
}

const safeClose = async (
  closeable: { close(): Promise<void> },
  label: string,
  id: string,
): Promise<void> => {
  await closeable
    .close()
    .catch((e) => elizaLogger.debug(`[${label}] Close error for ${id}: ${e}`));
};

/** Stop runtime services without closing the shared database adapter pool. */
async function stopRuntimeServices(
  runtime: AgentRuntime,
  id: string,
  label: string,
): Promise<void> {
  try {
    await runtime.stop();
  } catch (e) {
    elizaLogger.debug(`[${label}] Stop error for ${id}: ${e}`);
  }
}

class RuntimeCache {
  private cache = new Map<string, CachedRuntime>();
  private readonly MAX_SIZE = 50;
  private readonly MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes max age
  private readonly IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes idle timeout

  private isStale(entry: CachedRuntime, now: number): boolean {
    return (
      now - entry.createdAt > this.MAX_AGE_MS ||
      now - entry.lastUsed > this.IDLE_TIMEOUT_MS
    );
  }

  private async evictEntry(
    key: string,
    entry: CachedRuntime,
    reason: string,
  ): Promise<void> {
    await stopRuntimeServices(entry.runtime, key, "RuntimeCache");
    this.cache.delete(key);
    elizaLogger.debug(
      `[RuntimeCache] Evicted ${reason} runtime: ${key} (adapter kept alive)`,
    );
  }

  async get(agentId: string): Promise<AgentRuntime | null> {
    const entry = this.cache.get(agentId);
    if (!entry) return null;

    const now = Date.now();
    if (this.isStale(entry, now)) {
      await this.evictEntry(agentId, entry, "stale");
      // Remove adapter reference for stale entries (consistent with getWithHealthCheck)
      dbAdapterPool.removeAdapter(entry.agentId as string);
      return null;
    }

    entry.lastUsed = now;
    return entry.runtime;
  }

  async getWithHealthCheck(
    agentId: string,
    dbPool: DbAdapterPool,
  ): Promise<AgentRuntime | null> {
    const entry = this.cache.get(agentId);
    if (!entry) return null;

    const now = Date.now();
    if (this.isStale(entry, now)) {
      await this.evictEntry(agentId, entry, "stale");
      // Remove adapter reference for stale entries (checkHealth not called yet)
      dbPool.removeAdapter(entry.agentId as string);
      return null;
    }

    // checkHealth() removes the adapter internally if unhealthy
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
  ): Promise<void> {
    // Evict oldest if at capacity
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
    });
    elizaLogger.debug(
      `[RuntimeCache] Cached runtime: ${characterName} (${actualAgentId}, key=${cacheKey})`,
    );
  }

  /** Remove runtime from cache (keeps adapter pool alive). */
  async remove(agentId: string): Promise<boolean> {
    const entry = this.cache.get(agentId);
    if (!entry) return false;

    await stopRuntimeServices(entry.runtime, agentId, "RuntimeCache");
    this.cache.delete(agentId);
    elizaLogger.info(
      `[RuntimeCache] Removed runtime: ${agentId} (adapter kept alive)`,
    );
    return true;
  }

  /** Delete runtime and close completely. Use only for full shutdown. */
  async delete(agentId: string): Promise<boolean> {
    const entry = this.cache.get(agentId);
    if (entry) {
      await safeClose(entry.runtime, "RuntimeCache", agentId);
      this.cache.delete(agentId);
      elizaLogger.info(
        `[RuntimeCache] Deleted runtime: ${agentId} (fully closed)`,
      );
      return true;
    }
    return false;
  }

  has(agentId: string): boolean {
    // Cache keys are now composite: ${agentId}:${orgId}${webSearchSuffix}
    // Check if any key starts with this agentId
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
  async removeByOrganization(organizationId: string): Promise<number> {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!organizationId || !UUID_RE.test(organizationId)) {
      return 0;
    }

    const entries = Array.from(this.cache.entries())
      .filter(([key]) => key.includes(`:${organizationId}`));

    await Promise.all(entries.map(async ([key, entry]) => {
      await stopRuntimeServices(entry.runtime, key, "RuntimeCache");
      this.cache.delete(key);
      dbAdapterPool.removeAdapter(entry.agentId as string);
    }));

    return entries.length;
  }

  /** Clear all cached runtimes. WARNING: Closes shared connection pool. */
  async clear(): Promise<void> {
    await Promise.all(
      Array.from(this.cache.entries()).map(([id, entry]) =>
        safeClose(entry.runtime, "RuntimeCache", id),
      ),
    );
    this.cache.clear();
  }
}

class DbAdapterPool {
  private adapters = new Map<string, IDatabaseAdapter>();
  private initPromises = new Map<string, Promise<IDatabaseAdapter>>();

  async getOrCreate(
    agentId: UUID,
    embeddingModel?: string,
  ): Promise<IDatabaseAdapter> {
    const key = agentId as string;

    if (this.adapters.has(key)) {
      const existingAdapter = this.adapters.get(key)!;
      const isHealthy = await this.checkAdapterHealth(existingAdapter);
      if (isHealthy) {
        return existingAdapter;
      }

      // Don't close the adapter - it shares a global connection pool.
      // Just remove our reference and let plugin-sql handle pool recreation.
      this.adapters.delete(key);
      adapterEmbeddingDimensions.delete(key);
      elizaLogger.warn(
        `[DbAdapterPool] Stale adapter for ${agentId}, recreating (pool kept alive)`,
      );
    }

    if (this.initPromises.has(key)) {
      return this.initPromises.get(key)!;
    }

    const initPromise = this.createAdapter(agentId, embeddingModel);
    this.initPromises.set(key, initPromise);

    try {
      const adapter = await initPromise;
      this.adapters.set(key, adapter);
      return adapter;
    } finally {
      this.initPromises.delete(key);
    }
  }

  private async checkAdapterHealth(
    adapter: IDatabaseAdapter,
  ): Promise<boolean> {
    try {
      await adapter.getEntitiesByIds([
        "00000000-0000-0000-0000-000000000000" as UUID,
      ]);
      return true;
    } catch (error) {
      // Any error during health check indicates an unhealthy adapter.
      // A non-existent entity should return an empty array, not throw.
      elizaLogger.warn(
        `[DbAdapterPool] Adapter health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async checkHealth(agentId: UUID): Promise<boolean> {
    const key = agentId as string;
    const adapter = this.adapters.get(key);
    if (!adapter) return false;

    const isHealthy = await this.checkAdapterHealth(adapter);
    if (!isHealthy) this.removeAdapter(key);
    return isHealthy;
  }

  private async createAdapter(
    agentId: UUID,
    embeddingModel?: string,
  ): Promise<IDatabaseAdapter> {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is required");
    }

    const startTime = Date.now();
    const adapter = createDatabaseAdapter(
      { postgresUrl: process.env.DATABASE_URL },
      agentId,
    );
    await adapter.init();

    const key = agentId as string;
    const dimension = getStaticEmbeddingDimension(embeddingModel);
    const existingDimension = adapterEmbeddingDimensions.get(key);

    if (existingDimension !== dimension) {
      try {
        await adapter.ensureEmbeddingDimension(dimension);
        adapterEmbeddingDimensions.set(key, dimension);
        elizaLogger.info(
          `[DbAdapterPool] Set embedding dimension for ${agentId}: ${dimension}`,
        );
      } catch (e) {
        elizaLogger.debug(`[DbAdapterPool] Embedding dimension: ${e}`);
        adapterEmbeddingDimensions.set(key, dimension);
      }
    }

    elizaLogger.debug(
      `[DbAdapterPool] Created adapter for ${agentId} in ${Date.now() - startTime}ms`,
    );
    return adapter;
  }

  /** Remove adapter reference without closing the shared connection pool. */
  removeAdapter(agentId: string): void {
    this.adapters.delete(agentId);
    adapterEmbeddingDimensions.delete(agentId);
    elizaLogger.debug(
      `[DbAdapterPool] Removed adapter reference: ${agentId} (connection pool kept alive)`,
    );
  }

  /** Close adapter completely. WARNING: Closes shared connection pool! */
  async closeAdapter(agentId: string): Promise<void> {
    const adapter = this.adapters.get(agentId);
    if (adapter) {
      await safeClose(adapter, "DbAdapterPool", agentId);
    }
    this.adapters.delete(agentId);
    adapterEmbeddingDimensions.delete(agentId);
  }

  /** @deprecated Use removeAdapter() or closeAdapter() instead. */
  async invalidateAdapter(agentId: string): Promise<void> {
    elizaLogger.warn(`[DbAdapterPool] invalidateAdapter() deprecated - use removeAdapter()`);
    await this.closeAdapter(agentId);
  }
}

const runtimeCache = new RuntimeCache();
const dbAdapterPool = new DbAdapterPool();

export class RuntimeFactory {
  private static instance: RuntimeFactory;
  private readonly DEFAULT_AGENT_ID = stringToUuid(
    DEFAULT_AGENT_ID_STRING,
  ) as UUID;

  private constructor() {
    this.initializeLoggers();
  }

  static getInstance(): RuntimeFactory {
    if (!this.instance) {
      this.instance = new RuntimeFactory();
    }
    return this.instance;
  }

  getCacheStats(): { runtime: { size: number; maxSize: number } } {
    return { runtime: runtimeCache.getStats() };
  }

  async clearCaches(): Promise<void> {
    await runtimeCache.clear();
  }

  async invalidateRuntime(agentId: string): Promise<boolean> {
    // Don't close adapter - it shares a global connection pool with all agents
    const wasInMemoryBase = await runtimeCache.remove(agentId);
    const wasInMemoryWs = await runtimeCache.remove(`${agentId}:ws`);
    const wasInMemory = wasInMemoryBase || wasInMemoryWs;

    // Just remove from our tracking - DON'T close the adapter
    dbAdapterPool.removeAdapter(agentId);

    try {
      await edgeRuntimeCache.invalidateCharacter(agentId);
      await edgeRuntimeCache.markRuntimeWarm(agentId, {
        isWarm: false,
        embeddingDimension: 0,
        characterName: undefined,
      });
    } catch (e) {
      elizaLogger.warn(`[RuntimeFactory] Edge cache invalidation failed: ${e}`);
    }

    elizaLogger.info(
      `[RuntimeFactory] Invalidated runtime for agent: ${agentId} (base: ${wasInMemoryBase}, ws: ${wasInMemoryWs})`,
    );

    return wasInMemory;
  }

  isRuntimeCached(agentId: string): boolean {
    return runtimeCache.has(agentId);
  }

  /** Invalidate all runtimes for an organization (e.g., when OAuth changes). */
  async invalidateByOrganization(organizationId: string): Promise<number> {
    const count = await runtimeCache.removeByOrganization(organizationId);
    if (count > 0) {
      elizaLogger.info(`[RuntimeFactory] Invalidated ${count} runtime(s) for org ${organizationId}`);
    }
    return count;
  }

  async createRuntimeForUser(context: UserContext): Promise<AgentRuntime> {
    const startTime = Date.now();
    elizaLogger.info(
      `[RuntimeFactory] Creating runtime: user=${context.userId}, mode=${context.agentMode}, char=${context.characterId || "default"}, webSearch=${context.webSearchEnabled}`,
    );

    const isDefaultCharacter =
      !context.characterId ||
      context.characterId === DEFAULT_AGENT_ID_STRING;
    const loaderOptions = { webSearchEnabled: context.webSearchEnabled };

    const { character, plugins, modeResolution } = isDefaultCharacter
      ? await agentLoader.getDefaultCharacter(context.agentMode, loaderOptions)
      : await agentLoader.loadCharacter(
          context.characterId!,
          context.agentMode,
          loaderOptions,
        );

    if (modeResolution.upgradeReason !== "none") {
      elizaLogger.info(
        `[RuntimeFactory] Mode upgraded: ${context.agentMode} → ${modeResolution.mode} (reason: ${modeResolution.upgradeReason})`,
      );
    }

    const agentId = (
      character.id ? stringToUuid(character.id) : this.DEFAULT_AGENT_ID
    ) as UUID;

    const webSearchSuffix = context.webSearchEnabled ? ":ws" : "";
    // Include organizationId to prevent cross-org API key pollution
    const cacheKey = `${agentId}:${context.organizationId}${webSearchSuffix}`;

    const cachedRuntime = await runtimeCache.getWithHealthCheck(
      cacheKey,
      dbAdapterPool,
    );
    if (cachedRuntime) {
      elizaLogger.info(
        `[RuntimeFactory] Cache HIT: ${character.name} (${Date.now() - startTime}ms)`,
      );
      this.applyUserContext(cachedRuntime, context);
      edgeRuntimeCache.incrementRequestCount(agentId as string).catch((e) => {
        elizaLogger.debug(`[RuntimeFactory] Edge cache increment failed: ${e}`);
      });

      return cachedRuntime;
    }

    elizaLogger.info(`[RuntimeFactory] Cache MISS: ${character.name}`);

    const embeddingModel =
      (character.settings?.OPENAI_EMBEDDING_MODEL as string) ||
      (character.settings?.ELIZAOS_CLOUD_EMBEDDING_MODEL as string);

    const dbAdapter = await dbAdapterPool.getOrCreate(agentId, embeddingModel);
    const baseSettings = this.buildSettings(character, context);
    const filteredPlugins = this.filterPlugins(plugins);

    // Build MCP settings separately - these will be passed via opts.settings
    // to avoid being persisted to the database via character.settings
    // Pass character.settings to preserve any pre-configured MCP servers
    const mcpSettings = this.buildMcpSettings(character.settings || {}, context);

    // Add MCP plugin if user has OAuth connections for any MCP server
    // This is necessary because plugin loading happens before MCP settings injection
    if (this.shouldEnableMcp(context) && !filteredPlugins.some((p) => p.name === "mcp")) {
      filteredPlugins.push(mcpPlugin as Plugin);
      elizaLogger.info("[RuntimeFactory] Added MCP plugin for OAuth-connected user");
    }

    // User-specific settings that should NOT be persisted to the database
    // These are passed via opts.settings so they're ephemeral per-request
    const ephemeralSettings: Record<string, string | boolean | number | Record<string, unknown>> = {
      // API keys - must be per-user, not persisted
      ELIZAOS_API_KEY: context.apiKey,
      ELIZAOS_CLOUD_API_KEY: context.apiKey,
      // User context - must be per-user, not persisted
      USER_ID: context.userId,
      ENTITY_ID: context.entityId,
      ORGANIZATION_ID: context.organizationId,
      IS_ANONYMOUS: context.isAnonymous,
      // MCP settings - based on user's OAuth connections
      ...mcpSettings,
    };

    // Create runtime with user-specific settings in opts.settings (NOT character.settings)
    // runtime.getSetting() checks opts.settings as fallback, and these won't be persisted to DB
    const runtime = new AgentRuntime({
      character: {
        ...character,
        id: agentId,
        settings: baseSettings,
      },
      plugins: filteredPlugins,
      agentId,
      settings: ephemeralSettings as Record<string, string | boolean | number>,
    });

    runtime.registerDatabaseAdapter(dbAdapter);
    this.ensureRuntimeLogger(runtime);

    await this.initializeRuntime(runtime, character, agentId);
    await this.waitForMcpServiceIfNeeded(runtime, filteredPlugins);

    await runtimeCache.set(cacheKey, runtime, character.name, agentId);

    edgeRuntimeCache
      .markRuntimeWarm(agentId as string, {
        isWarm: true,
        embeddingDimension: getStaticEmbeddingDimension(embeddingModel),
        characterName: character.name,
      })
      .catch((e) => {
        elizaLogger.debug(`[RuntimeFactory] Edge cache warm failed: ${e}`);
      });

    elizaLogger.success(
      `[RuntimeFactory] Runtime ready: ${character.name} (${modeResolution.mode}, webSearch=${context.webSearchEnabled}) in ${Date.now() - startTime}ms`,
    );
    return runtime;
  }

  /**
   * Apply user-specific context to a cached runtime.
   *
   * IMPORTANT: API keys, user IDs, and other settings resolved via getSetting()
   * are now handled by the request context pattern (see packages/core/src/request-context.ts).
   * Those settings are prefetched at request start and injected via runWithRequestContext(),
   * so getSetting() returns the correct user's values without mutating shared state.
   *
   * This method only handles settings that are accessed DIRECTLY on character.settings
   * (not via getSetting()), such as model preferences and app configurations.
   */
  private applyUserContext(runtime: AgentRuntime, context: UserContext): void {
    const charSettings = (runtime.character.settings || {}) as RuntimeSettings;

    // Model preferences - accessed directly, not via getSetting()
    if (context.modelPreferences) {
      charSettings.ELIZAOS_CLOUD_SMALL_MODEL =
        context.modelPreferences.smallModel ||
        charSettings.ELIZAOS_CLOUD_SMALL_MODEL;
      charSettings.ELIZAOS_CLOUD_LARGE_MODEL =
        context.modelPreferences.largeModel ||
        charSettings.ELIZAOS_CLOUD_LARGE_MODEL;
    }

    // Image model - accessed directly
    if (context.imageModel) {
      charSettings.ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL = context.imageModel;
    }

    // App prompt config - accessed directly
    if (context.appPromptConfig) {
      charSettings.appPromptConfig = context.appPromptConfig;
    }

    // NOTE: The following are NO LONGER mutated here because they're resolved
    // dynamically via getSetting() which checks request context first:
    // - ELIZAOS_API_KEY / ELIZAOS_CLOUD_API_KEY
    // - USER_ID / ENTITY_ID / ORGANIZATION_ID / IS_ANONYMOUS
    // - MCP settings (mcp.servers with X-API-Key headers)
    //
    // See: packages/core/src/runtime.ts getSetting() and
    //      lib/services/entity-settings/service.ts prefetch()
  }

  private transformMcpSettings(
    mcpSettings: Record<string, unknown>,
    apiKey?: string,
  ): Record<string, unknown> {
    if (!mcpSettings?.servers) return mcpSettings;

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const transformedServers: Record<string, unknown> = {};

    for (const [serverId, serverConfig] of Object.entries(
      mcpSettings.servers as Record<string, { url?: string; type?: string; headers?: Record<string, string> } | null>,
    )) {
      if (!serverConfig) continue; // Skip malformed/null server entries
      const isHttpTransport = serverConfig.type && ["http", "streamable-http", "sse"].includes(serverConfig.type);
      const transformedUrl = serverConfig.url?.startsWith("/")
        ? `${baseUrl}${serverConfig.url}`
        : serverConfig.url;

      // Auto-inject API key header for HTTP MCP servers on our domain
      // Use URL origin comparison to prevent leaking API key to lookalike domains
      const isSameOrigin = (() => {
        if (!transformedUrl) return false;
        try {
          const targetOrigin = new URL(transformedUrl).origin;
          const baseOrigin = new URL(baseUrl).origin;
          return targetOrigin === baseOrigin;
        } catch {
          return false;
        }
      })();
      const shouldInjectAuth = isHttpTransport && apiKey && isSameOrigin;

      elizaLogger.info(`[MCP Transform] Server ${serverId}: isHttp=${isHttpTransport}, hasApiKey=${!!apiKey}, isSameOrigin=${isSameOrigin}, shouldInjectAuth=${shouldInjectAuth}`);

      transformedServers[serverId] = {
        ...serverConfig,
        url: transformedUrl,
        ...(shouldInjectAuth && {
          headers: {
            ...serverConfig.headers,
            "X-API-Key": apiKey,
          },
        }),
      };
    }

    return { ...mcpSettings, servers: transformedServers };
  }

  private getConnectedPlatforms(context: UserContext): Set<string> {
    return new Set((context.oauthConnections || []).map((c) => c.platform.toLowerCase()));
  }

  private shouldEnableMcp(context: UserContext): boolean {
    const connected = this.getConnectedPlatforms(context);
    return Object.keys(MCP_SERVER_CONFIGS).some((p) => connected.has(p));
  }

  private buildMcpSettings(
    charSettings: Record<string, unknown>,
    context: UserContext,
  ): { mcp?: Record<string, unknown> } {
    const connected = this.getConnectedPlatforms(context);
    const enabledServers = Object.fromEntries(
      Object.entries(MCP_SERVER_CONFIGS).filter(([p]) => connected.has(p)),
    );

    if (Object.keys(enabledServers).length === 0) return {};

    elizaLogger.debug(`[RuntimeFactory] MCP enabled: ${Object.keys(enabledServers).join(", ")}`);

    const existingMcp = charSettings.mcp as Record<string, unknown> | undefined;
    const existingServers =
      existingMcp?.servers && typeof existingMcp.servers === "object" && !Array.isArray(existingMcp.servers)
        ? (existingMcp.servers as Record<string, unknown>)
        : {};

    return {
      mcp: this.transformMcpSettings({ ...existingMcp, servers: { ...enabledServers, ...existingServers } }, context.apiKey),
    };
  }

  private filterPlugins(plugins: Plugin[]): Plugin[] {
    return plugins.filter((p) => p.name !== "@elizaos/plugin-sql") as Plugin[];
  }

  private buildSettings(
    character: Character,
    context: UserContext,
  ): NonNullable<Character["settings"]> {
    // Strip user-specific and ephemeral settings from charSettings
    // These should NOT come from persisted DB values - they must be fresh per-request
    const {
      mcp: _stripMcp,
      ELIZAOS_API_KEY: _stripApiKey,
      ELIZAOS_CLOUD_API_KEY: _stripCloudApiKey,
      USER_ID: _stripUserId,
      ENTITY_ID: _stripEntityId,
      ORGANIZATION_ID: _stripOrgId,
      IS_ANONYMOUS: _stripIsAnon,
      ...charSettings
    } = (character.settings || {}) as Record<string, unknown>;

    const getSetting = (key: string, fallback: string) =>
      (charSettings[key] as string) || process.env[key] || fallback;

    const embeddingModel =
      (charSettings.OPENAI_EMBEDDING_MODEL as string) ||
      (charSettings.ELIZAOS_CLOUD_EMBEDDING_MODEL as string);
    const embeddingDimension = getStaticEmbeddingDimension(embeddingModel);

    // Return only character-level settings that are safe to persist
    // User-specific settings (API keys, user context, MCP) are passed via opts.settings
    return {
      ...charSettings,
      POSTGRES_URL: process.env.DATABASE_URL!,
      DATABASE_URL: process.env.DATABASE_URL!,
      EMBEDDING_DIMENSION: String(embeddingDimension),
      ELIZAOS_CLOUD_BASE_URL: getElizaCloudApiUrl(),
      ELIZAOS_CLOUD_SMALL_MODEL:
        context.modelPreferences?.smallModel ||
        getSetting("ELIZAOS_CLOUD_SMALL_MODEL", getDefaultModels().small),
      ELIZAOS_CLOUD_LARGE_MODEL:
        context.modelPreferences?.largeModel ||
        getSetting("ELIZAOS_CLOUD_LARGE_MODEL", getDefaultModels().large),
      ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL:
        context.imageModel ||
        getSetting(
          "ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL",
          DEFAULT_IMAGE_MODEL.modelId,
        ),
      ...buildElevenLabsSettings(charSettings),
      // NOTE: User-specific settings (API keys, user context, MCP) are NOT included here
      // They're passed via opts.settings to avoid being persisted to the database
      ...(context.appPromptConfig
        ? { appPromptConfig: context.appPromptConfig }
        : {}),
      ...(context.webSearchEnabled && process.env.TAVILY_API_KEY
        ? { TAVILY_API_KEY: process.env.TAVILY_API_KEY }
        : {}),
    } as unknown as NonNullable<Character["settings"]>;
  }

  private async initializeRuntime(
    runtime: AgentRuntime,
    character: Character,
    agentId: UUID,
  ): Promise<void> {
    const startTime = Date.now();

    let initSucceeded = false;
    try {
      const initStart = Date.now();
      await runtime.initialize({ skipMigrations: true });
      elizaLogger.info(
        `[RuntimeFactory] initialize() completed in ${Date.now() - initStart}ms`,
      );
      initSucceeded = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isDuplicate =
        msg.toLowerCase().includes("duplicate") ||
        msg.toLowerCase().includes("unique constraint") ||
        msg.includes("Failed to create entity") ||
        msg.includes("Failed to create agent") ||
        msg.includes("Failed to create room");
      if (!isDuplicate) throw e;
      elizaLogger.warn(
        `[RuntimeFactory] Init error: ${msg.substring(0, 50)}...`,
      );
      this.resolveInitPromise(runtime);
    }

    // Check if agent exists
    const agentExists = await runtime.getAgent(agentId);

    const parallelOps: Promise<void>[] = [];

    if (!agentExists) {
      parallelOps.push(this.ensureAgentExists(runtime, character, agentId));
    }

    parallelOps.push(
      (async () => {
        try {
          await runtime.ensureWorldExists({
            id: agentId,
            name: `World for ${character.name}`,
            agentId,
            serverId: agentId,
          } as World);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (
            !msg.toLowerCase().includes("duplicate") &&
            !msg.toLowerCase().includes("unique constraint")
          ) {
            throw e;
          }
        }
      })(),
    );

    if (parallelOps.length > 0) {
      const parallelStart = Date.now();
      await Promise.all(parallelOps);
      elizaLogger.debug(
        `[RuntimeFactory] Parallel ops: ${Date.now() - parallelStart}ms`,
      );
    }

    if (initSucceeded) {
      this.resolveInitPromise(runtime);
    }

    elizaLogger.info(`[RuntimeFactory] Init: ${Date.now() - startTime}ms`);
  }

  private resolveInitPromise(runtime: AgentRuntime): void {
    const runtimeAny = runtime as unknown as {
      initResolver?: () => void;
    };
    if (typeof runtimeAny.initResolver === "function") {
      runtimeAny.initResolver();
      runtimeAny.initResolver = undefined;
    }
  }

  private async ensureAgentExists(
    runtime: AgentRuntime,
    character: Character,
    agentId: UUID,
  ): Promise<void> {
    try {
      await runtime.createEntity({
        id: agentId,
        names: [character.name || "Eliza"],
        agentId,
        metadata: { name: character.name || "Eliza" },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        !msg.toLowerCase().includes("duplicate") &&
        !msg.toLowerCase().includes("unique constraint")
      )
        throw e;
    }
  }

  private ensureRuntimeLogger(runtime: AgentRuntime): void {
    if (!runtime.logger?.log) {
      runtime.logger = {
        log: logger.info.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        debug: console.debug.bind(console),
        success: (message: string) => logger.info(`✓ ${message}`),
        notice: console.info.bind(console),
      } as Logger & { notice: typeof console.info };
    }
  }

  private initializeLoggers(): void {
    if (elizaLogger) {
      elizaLogger.log = logger.info.bind(console);
      elizaLogger.info = console.info.bind(console);
      elizaLogger.warn = console.warn.bind(console);
      elizaLogger.error = console.error.bind(console);
      elizaLogger.debug = console.debug.bind(console);
      elizaLogger.success = (
        obj: string | Error | Record<string, unknown>,
        msg?: string,
      ) => {
        logger.info(typeof obj === "string" ? `✓ ${obj}` : ["✓", obj, msg]);
      };
    }

    if (typeof globalThis !== "undefined" && !globalAny.logger) {
      globalAny.logger = {
        level: "info",
        log: logger.info.bind(console),
        trace: console.trace.bind(console),
        debug: console.debug.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        fatal: console.error.bind(console),
        success: (
          obj: string | Error | Record<string, unknown>,
          msg?: string,
        ) => {
          logger.info(typeof obj === "string" ? `✓ ${obj}` : ["✓", obj, msg]);
        },
        progress: logger.info.bind(console),
        clear: () => console.clear(),
        child: () => globalAny.logger!,
      };
    }
  }

  private async waitForMcpServiceIfNeeded(
    runtime: AgentRuntime,
    plugins: Plugin[],
  ): Promise<void> {
    if (!plugins.some((p) => p.name === "mcp")) return;

    type McpService = {
      waitForInitialization?: () => Promise<void>;
      getServers?: () => unknown[];
    };

    const startTime = Date.now();
    const maxWaitMs = 2500; // Allow time for MCP server connections
    const maxDelay = 200;
    let waitMs = 5; // Start lower at 5ms
    let mcpService: McpService | null = null;

    // Check immediately first
    mcpService = runtime.getService("mcp") as McpService | null;

    // Exponential backoff: 5, 10, 20, 40, 80, 160, 200, 200...
    while (!mcpService && Date.now() - startTime < maxWaitMs) {
      await new Promise((r) => setTimeout(r, waitMs));
      mcpService = runtime.getService("mcp") as McpService | null;
      waitMs = Math.min(waitMs * 2, maxDelay);
    }

    const elapsed = Date.now() - startTime;
    if (!mcpService) {
      elizaLogger.warn(
        `[RuntimeFactory] MCP service not available after ${elapsed}ms`,
      );
      return;
    }

    elizaLogger.debug(`[RuntimeFactory] MCP service found in ${elapsed}ms`);

    if (typeof mcpService.waitForInitialization === "function") {
      await mcpService.waitForInitialization();
    }

    const servers = mcpService.getServers?.();
    if (servers) {
      elizaLogger.info(
        `[RuntimeFactory] MCP: ${servers.length} server(s) connected in ${Date.now() - startTime}ms`,
      );
      for (const server of servers as Array<{ name: string; status: string; tools?: unknown[]; error?: string }>) {
        elizaLogger.info(
          `[RuntimeFactory] MCP Server: ${server.name} status=${server.status} tools=${server.tools?.length || 0} error=${server.error || 'none'}`,
        );
      }
    }
  }
}

export function getRuntimeCacheStats(): {
  runtime: { size: number; maxSize: number };
} {
  return runtimeFactory.getCacheStats();
}

export const runtimeFactory = RuntimeFactory.getInstance();

export async function invalidateRuntime(agentId: string): Promise<boolean> {
  return runtimeFactory.invalidateRuntime(agentId);
}

export function isRuntimeCached(agentId: string): boolean {
  return runtimeFactory.isRuntimeCached(agentId);
}

/** Invalidate all cached runtimes for an organization. */
export async function invalidateByOrganization(organizationId: string): Promise<number> {
  return runtimeFactory.invalidateByOrganization(organizationId);
}

export { getStaticEmbeddingDimension, KNOWN_EMBEDDING_DIMENSIONS };

// Test exports - only for integration testing
export const _testing = {
  getRuntimeCache: () => runtimeCache,
  getDbAdapterPool: () => dbAdapterPool,
  safeClose,
  stopRuntimeServices,

  async forceEvictRuntime(agentId: string): Promise<void> {
    const entry = runtimeCache["cache"].get(agentId);
    if (entry) {
      await stopRuntimeServices(entry.runtime, agentId, "TestForceEvict");
      runtimeCache["cache"].delete(agentId);
    }
  },

  async forceEvictRuntimeOld(agentId: string): Promise<void> {
    const entry = runtimeCache["cache"].get(agentId);
    if (entry) {
      await safeClose(entry.runtime, "TestForceEvictOld", agentId);
      runtimeCache["cache"].delete(agentId);
    }
  },

  getCacheEntries(): Map<
    string,
    { runtime: AgentRuntime; lastUsed: number; createdAt: number }
  > {
    return new Map(runtimeCache["cache"]);
  },

  getAdapterEntries(): Map<string, IDatabaseAdapter> {
    return new Map(dbAdapterPool["adapters"]);
  },

  async closeAdapterDirectly(agentId: string): Promise<void> {
    const adapter = dbAdapterPool["adapters"].get(agentId);
    if (adapter) {
      await adapter.close();
    }
  },
};
