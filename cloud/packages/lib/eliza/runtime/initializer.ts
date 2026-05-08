import {
  AgentRuntime,
  type Character,
  elizaLogger,
  type IDatabaseAdapter,
  type Plugin,
  stringToUuid,
  type UUID,
  type World,
} from "@elizaos/core";
import { edgeRuntimeCache, getStaticEmbeddingDimension } from "@/lib/cache/edge-runtime-cache";
import "@/lib/polyfills/dom-polyfills";
import { agentLoader } from "../agent-loader";
import mcpPlugin from "../plugin-mcp";
import type { UserContext } from "../user-context";
import { buildRuntimeCacheKey, runtimeCache } from "./cache";
import { dbAdapterPool } from "./database/adapter-pool";
import { safeClose, stopRuntimeServices } from "./lifecycle";
import {
  buildMcpSettings,
  getConnectedMcpPlatforms,
  setMcpEnabledServers,
  shouldEnableMcp,
} from "./mcp-config";
import { waitForMcpServiceIfNeeded } from "./mcp-service-wait";
import {
  assertPersistentDatabaseRequired,
  ensureRuntimeLogger,
  initializeLoggers,
} from "./runtime-patches";
import {
  applyUserContext,
  buildDirectAccessContextSignature,
  buildRuntimeSettings,
  buildSettings,
} from "./settings";

/**
 * Default agent ID used when no specific character/agent is specified.
 * Exported for use in other modules that need the same default.
 */
export const DEFAULT_AGENT_ID_STRING = "b850bc30-45f8-0041-a00a-83df46d8555d";

function filterPlugins(plugins: Plugin[]): Plugin[] {
  return plugins.filter((p) => p.name !== "@elizaos/plugin-sql") as Plugin[];
}

export class RuntimeFactory {
  private static instance: RuntimeFactory;
  private readonly DEFAULT_AGENT_ID = stringToUuid(DEFAULT_AGENT_ID_STRING) as UUID;

  private constructor() {
    initializeLoggers();
  }

  static getInstance(): RuntimeFactory {
    if (!RuntimeFactory.instance) {
      RuntimeFactory.instance = new RuntimeFactory();
    }
    return RuntimeFactory.instance;
  }

  getCacheStats(): { runtime: { size: number; maxSize: number } } {
    return { runtime: runtimeCache.getStats() };
  }

  async clearCaches(): Promise<void> {
    await runtimeCache.clear();
  }

  async invalidateRuntime(agentId: string): Promise<boolean> {
    const removedCount = await runtimeCache.removeByAgentId(agentId);
    const wasInMemory = removedCount > 0;

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
      `[RuntimeFactory] Invalidated runtime for agent: ${agentId} (entries: ${removedCount})`,
    );

    return wasInMemory;
  }

  isRuntimeCached(agentId: string): boolean {
    return runtimeCache.has(agentId);
  }

  /** Invalidate all runtimes for an organization, for example when OAuth changes. */
  async invalidateByOrganization(organizationId: string): Promise<number> {
    const count = await runtimeCache.removeByOrganization(organizationId, dbAdapterPool);
    if (count > 0) {
      elizaLogger.info(
        `[RuntimeFactory] Invalidated ${count} runtime(s) for org ${organizationId}`,
      );
    }
    return count;
  }

  async createRuntimeForUser(context: UserContext): Promise<AgentRuntime> {
    const startTime = Date.now();
    elizaLogger.info(
      `[RuntimeFactory] Creating runtime: user=${context.userId}, mode=${context.agentMode}, char=${context.characterId || "default"}, webSearch=${context.webSearchEnabled}`,
    );

    const isDefaultCharacter =
      !context.characterId || context.characterId === DEFAULT_AGENT_ID_STRING;
    const loaderOptions = { webSearchEnabled: context.webSearchEnabled };

    const { character, plugins, modeResolution } = isDefaultCharacter
      ? await agentLoader.getDefaultCharacter(context.agentMode, loaderOptions)
      : await agentLoader.loadCharacter(context.characterId!, context.agentMode, loaderOptions);

    if (modeResolution.upgradeReason !== "none") {
      elizaLogger.info(
        `[RuntimeFactory] Mode upgraded: ${context.agentMode} -> ${modeResolution.mode} (reason: ${modeResolution.upgradeReason})`,
      );
    }

    const agentId = (character.id ? stringToUuid(character.id) : this.DEFAULT_AGENT_ID) as UUID;
    const filteredPlugins = filterPlugins(plugins);
    const mcpShouldBeEnabled = shouldEnableMcp(context);
    const cachePluginNames =
      mcpShouldBeEnabled && !filteredPlugins.some((p) => p.name === "mcp")
        ? [...filteredPlugins.map((plugin) => plugin.name), (mcpPlugin as Plugin).name]
        : filteredPlugins.map((plugin) => plugin.name);

    const cacheKey = buildRuntimeCacheKey({
      agentId,
      organizationId: context.organizationId,
      effectiveMode: modeResolution.mode,
      pluginNames: cachePluginNames,
      webSearchEnabled: context.webSearchEnabled,
      mcpPlatforms: getConnectedMcpPlatforms(context),
      directContextSignature: buildDirectAccessContextSignature(context),
    });

    const currentMcpVersion = await edgeRuntimeCache
      .getMcpVersion(context.organizationId)
      .catch(() => 0);

    const cachedRuntime = await runtimeCache.getWithHealthCheck(
      cacheKey,
      dbAdapterPool,
      currentMcpVersion,
    );
    if (cachedRuntime) {
      elizaLogger.info(
        `[RuntimeFactory] Cache HIT: ${character.name} (${Date.now() - startTime}ms)`,
      );
      applyUserContext(cachedRuntime, context);
      edgeRuntimeCache.incrementRequestCount(agentId as string).catch((e) => {
        elizaLogger.debug(`[RuntimeFactory] Edge cache increment failed: ${e}`);
      });

      return cachedRuntime;
    }

    elizaLogger.info(`[RuntimeFactory] Cache MISS: ${character.name}`);

    if (mcpShouldBeEnabled && !filteredPlugins.some((p) => p.name === "mcp")) {
      filteredPlugins.push(mcpPlugin as Plugin);
      elizaLogger.info("[RuntimeFactory] Added MCP plugin for OAuth-connected user");
    }

    const embeddingModel =
      (character.settings?.OPENAI_EMBEDDING_MODEL as string) ||
      (character.settings?.ELIZAOS_CLOUD_EMBEDDING_MODEL as string);

    const dbAdapter = await dbAdapterPool.getOrCreate(agentId, embeddingModel);
    const baseSettings = buildSettings(character, context);
    const mcpSettings = buildMcpSettings(context);

    const settingsWithMcp = mcpSettings.mcp
      ? { ...baseSettings, mcp: mcpSettings.mcp }
      : baseSettings;

    const runtime = new AgentRuntime({
      character: {
        ...character,
        id: agentId,
        settings: settingsWithMcp as any,
      },
      plugins: filteredPlugins,
      agentId,
      settings: buildRuntimeSettings(context),
    });

    runtime.registerDatabaseAdapter(dbAdapter);
    ensureRuntimeLogger(runtime);

    await initializeRuntime(runtime, character, agentId);
    await waitForMcpServiceIfNeeded(runtime, filteredPlugins);

    setMcpEnabledServers(context);

    await runtimeCache.set(cacheKey, runtime, character.name ?? "", agentId, currentMcpVersion);

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
}

async function initializeRuntime(
  runtime: AgentRuntime,
  character: Character,
  agentId: UUID,
): Promise<void> {
  const startTime = Date.now();

  let initSucceeded = false;
  try {
    const initStart = Date.now();
    assertPersistentDatabaseRequired(runtime);
    await runtime.initialize({ skipMigrations: true });
    elizaLogger.info(`[RuntimeFactory] initialize() completed in ${Date.now() - initStart}ms`);
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
    elizaLogger.warn(`[RuntimeFactory] Init error: ${msg.substring(0, 50)}...`);
    resolveInitPromise(runtime);
  }

  const agentExists = await runtime.getAgent(agentId);
  const parallelOps: Promise<void>[] = [];

  if (!agentExists) {
    parallelOps.push(ensureAgentExists(runtime, character, agentId));
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
    elizaLogger.debug(`[RuntimeFactory] Parallel ops: ${Date.now() - parallelStart}ms`);
  }

  if (initSucceeded) {
    resolveInitPromise(runtime);
  }

  elizaLogger.info(`[RuntimeFactory] Init: ${Date.now() - startTime}ms`);
}

function resolveInitPromise(runtime: AgentRuntime): void {
  const runtimeAny = runtime as unknown as {
    initResolver?: () => void;
  };
  if (typeof runtimeAny.initResolver === "function") {
    runtimeAny.initResolver();
    runtimeAny.initResolver = undefined;
  }
}

async function ensureAgentExists(
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
    ) {
      throw e;
    }
  }
}

export const runtimeFactory = RuntimeFactory.getInstance();

export function getRuntimeCacheStats(): {
  runtime: { size: number; maxSize: number };
} {
  return runtimeFactory.getCacheStats();
}

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

// Test exports - only for integration testing.
export const _testing = {
  getRuntimeCache: () => runtimeCache,
  getDbAdapterPool: () => dbAdapterPool,
  safeClose,
  stopRuntimeServices,

  async forceEvictRuntime(agentId: string): Promise<void> {
    await runtimeCache.removeByAgentId(agentId);
  },

  async forceEvictRuntimeOld(agentId: string): Promise<void> {
    const keys = runtimeCache.keysForAgentForTesting(agentId);
    for (const key of keys) {
      const entry = runtimeCache.getEntryForTesting(key);
      if (entry) {
        await stopRuntimeServices(entry.runtime, key, "TestForceEvictOld");
        await safeClose(entry.runtime, "TestForceEvictOld", key);
        runtimeCache.deleteEntryForTesting(key);
      }
    }
    dbAdapterPool.removeAdapter(agentId);
  },

  getCacheEntries(): Map<string, { runtime: AgentRuntime; lastUsed: number; createdAt: number }> {
    return runtimeCache.entriesForTesting();
  },

  getAdapterEntries(): Map<string, IDatabaseAdapter> {
    return dbAdapterPool.entriesForTesting();
  },

  async closeAdapterDirectly(agentId: string): Promise<void> {
    const matchingEntries = Array.from(runtimeCache.entriesForTesting().entries()).filter(
      ([, entry]) => (entry.agentId as string) === agentId,
    );

    for (const [cacheKey, entry] of matchingEntries) {
      await stopRuntimeServices(entry.runtime, cacheKey, "TestCloseAdapterDirectly");
    }

    await new Promise((r) => setTimeout(r, 3500));

    await dbAdapterPool.closeAdapter(agentId);
  },
};
