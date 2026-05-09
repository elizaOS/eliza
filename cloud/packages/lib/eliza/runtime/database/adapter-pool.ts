import { elizaLogger, type IDatabaseAdapter, type UUID } from "@elizaos/core";
import * as sqlPluginNode from "@elizaos/plugin-sql";
import { getStaticEmbeddingDimension } from "@/lib/cache/edge-runtime-cache";
import { resolveRuntimeDatabaseAdapterConfig } from "../../database-adapter-config";
import { safeClose } from "../lifecycle";
import { applyLegacyDatabaseAdapterCompat } from "./adapter-compat";

const adapterEmbeddingDimensions = new Map<string, number>();

const createDatabaseAdapter = (
  sqlPluginNode as unknown as {
    createDatabaseAdapter: (
      config: { dataDir?: string; postgresUrl?: string },
      agentId: UUID,
    ) => IDatabaseAdapter;
  }
).createDatabaseAdapter;

export class DbAdapterPool {
  private adapters = new Map<string, IDatabaseAdapter>();
  private initPromises = new Map<string, Promise<IDatabaseAdapter>>();

  async getOrCreate(agentId: UUID, embeddingModel?: string): Promise<IDatabaseAdapter> {
    const key = agentId as string;

    if (this.adapters.has(key)) {
      const existingAdapter = this.adapters.get(key)!;
      const isHealthy = await this.checkAdapterHealth(existingAdapter);
      if (isHealthy) {
        return existingAdapter;
      }

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

  private async checkAdapterHealth(adapter: IDatabaseAdapter): Promise<boolean> {
    try {
      await adapter.getEntitiesByIds(["00000000-0000-0000-0000-000000000000" as UUID]);
      return true;
    } catch (error) {
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

  private async createAdapter(agentId: UUID, embeddingModel?: string): Promise<IDatabaseAdapter> {
    const startTime = Date.now();
    const adapterConfig = resolveRuntimeDatabaseAdapterConfig(process.env);
    const adapter = applyLegacyDatabaseAdapterCompat(createDatabaseAdapter(adapterConfig, agentId));
    await adapter.initialize();

    const key = agentId as string;
    const dimension = getStaticEmbeddingDimension(embeddingModel);
    const existingDimension = adapterEmbeddingDimensions.get(key);

    if (existingDimension !== dimension) {
      try {
        await adapter.ensureEmbeddingDimension(dimension);
        adapterEmbeddingDimensions.set(key, dimension);
        elizaLogger.info(`[DbAdapterPool] Set embedding dimension for ${agentId}: ${dimension}`);
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

  /** Close adapter completely. WARNING: Closes shared connection pool. */
  async closeAdapter(agentId: string): Promise<void> {
    const adapter = this.adapters.get(agentId);
    if (adapter) {
      await safeClose(adapter, "DbAdapterPool", agentId);
    }
    this.adapters.delete(agentId);
    adapterEmbeddingDimensions.delete(agentId);
  }

  entriesForTesting(): Map<string, IDatabaseAdapter> {
    return new Map(this.adapters);
  }
}

export const dbAdapterPool = new DbAdapterPool();
