/** Owns per-agent adapter reuse without closing shared database connections.
 * Invalidation rejects stale initialization and health-check publication.
 * This process-local fence does not stop database work already in flight;
 * migrations must separately establish durable write exclusion and quiescence.
 */
import { ElizaError, elizaLogger, type IDatabaseAdapter, type UUID } from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { getStaticEmbeddingDimension } from "../../../cache/edge-runtime-cache";
import { resolveRuntimeDatabaseAdapterConfig } from "../../database-adapter-config";
import { safeClose } from "../lifecycle";
import { applyLegacyDatabaseAdapterCompat } from "./adapter-compat";

const adapterEmbeddingDimensions = new Map<string, number>();

export class DbAdapterPool {
  private adapters = new Map<string, IDatabaseAdapter>();
  private readonly ownedAdapters = new Set<IDatabaseAdapter>();
  private initPromises = new Map<string, Promise<IDatabaseAdapter>>();
  private generations = new Map<string, symbol>();

  constructor(
    private readonly adapterFactory: typeof createDatabaseAdapter = createDatabaseAdapter,
  ) {}

  private assertGeneration(agentId: string, generation: symbol): void {
    if (this.generations.get(agentId) !== generation) {
      throw new ElizaError("Database adapter was invalidated; retry runtime initialization", {
        code: "RUNTIME_ADAPTER_INVALIDATED",
        context: { agentId },
      });
    }
  }

  async getOrCreate(agentId: UUID, embeddingModel?: string): Promise<IDatabaseAdapter> {
    const key = agentId as string;
    let generation = this.generations.get(key);
    if (!generation) {
      generation = Symbol(key);
      this.generations.set(key, generation);
    }

    if (this.adapters.has(key)) {
      const existingAdapter = this.adapters.get(key)!;
      const isHealthy = await this.checkAdapterHealth(existingAdapter);
      this.assertGeneration(key, generation);
      if (this.adapters.get(key) !== existingAdapter) {
        return this.getOrCreate(agentId, embeddingModel);
      }
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

    const admittedGeneration = generation;
    const initPromise = this.createAdapter(agentId, admittedGeneration, embeddingModel)
      .then((adapter) => {
        this.assertGeneration(key, admittedGeneration);
        this.adapters.set(key, adapter);
        return adapter;
      })
      .finally(() => {
        if (this.initPromises.get(key) === initPromise) this.initPromises.delete(key);
      });
    this.initPromises.set(key, initPromise);
    return initPromise;
  }

  private async checkAdapterHealth(adapter: IDatabaseAdapter): Promise<boolean> {
    try {
      await adapter.getEntitiesByIds(["00000000-0000-0000-0000-000000000000" as UUID]);
      return true;
    } catch (error) {
      // error-policy:J4 Health failure is an explicit unhealthy result.
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
    if (this.adapters.get(key) !== adapter) return false;
    if (!isHealthy) this.removeAdapter(key);
    return isHealthy;
  }

  private async createAdapter(
    agentId: UUID,
    generation: symbol,
    embeddingModel?: string,
  ): Promise<IDatabaseAdapter> {
    const startTime = Date.now();
    const adapterConfig = resolveRuntimeDatabaseAdapterConfig(process.env);
    const adapter = applyLegacyDatabaseAdapterCompat(this.adapterFactory(adapterConfig, agentId));
    this.ownedAdapters.add(adapter);
    await adapter.initialize();
    this.assertGeneration(agentId, generation);

    const key = agentId as string;
    const dimension = getStaticEmbeddingDimension(embeddingModel);
    const existingDimension = adapterEmbeddingDimensions.get(key);

    if (existingDimension !== dimension) {
      try {
        await adapter.ensureEmbeddingDimension(dimension);
      } catch (e) {
        // error-policy:J2 Failed dimension initialization cannot publish a healthy adapter.
        throw new ElizaError("Database embedding dimension initialization failed", {
          code: "RUNTIME_ADAPTER_DIMENSION_FAILED",
          cause: e,
          context: { agentId, dimension },
        });
      }
      this.assertGeneration(key, generation);
      adapterEmbeddingDimensions.set(key, dimension);
      elizaLogger.info(`[DbAdapterPool] Set embedding dimension for ${agentId}: ${dimension}`);
    }

    elizaLogger.debug(
      `[DbAdapterPool] Created adapter for ${agentId} in ${Date.now() - startTime}ms`,
    );
    return adapter;
  }

  /** Remove references without closing the shared pool. An expected adapter
   * binds an old runtime's eviction to its own instance; ordinary invalidation
   * without that argument also revokes pending initialization generations.
   */
  removeAdapter(agentId: string, expectedAdapter?: IDatabaseAdapter): boolean {
    if (expectedAdapter !== undefined && this.adapters.get(agentId) !== expectedAdapter) {
      return false;
    }
    this.generations.delete(agentId);
    this.initPromises.delete(agentId);
    this.adapters.delete(agentId);
    adapterEmbeddingDimensions.delete(agentId);
    elizaLogger.debug(
      `[DbAdapterPool] Removed adapter reference: ${agentId} (connection pool kept alive)`,
    );
    return true;
  }

  /** Close adapter completely. WARNING: Closes shared connection pool. */
  async closeAdapter(agentId: string): Promise<void> {
    const adapter = this.adapters.get(agentId);
    this.removeAdapter(agentId);
    if (adapter) {
      await safeClose(adapter, "DbAdapterPool", agentId);
    }
  }

  /** Transfers full-shutdown ownership after the factory has joined every creation.
   * Invalidated and failed initializations still own shared connection resources.
   */
  takeForShutdown(): IDatabaseAdapter[] {
    if (this.initPromises.size > 0) {
      throw new ElizaError("Join runtime creations before releasing database adapters", {
        code: "RUNTIME_ADAPTER_SHUTDOWN_PENDING",
      });
    }
    const adapters = [...this.ownedAdapters];
    this.ownedAdapters.clear();
    for (const agentId of this.generations.keys()) adapterEmbeddingDimensions.delete(agentId);
    this.adapters.clear();
    this.generations.clear();
    return adapters;
  }

  entriesForTesting(): Map<string, IDatabaseAdapter> {
    return new Map(this.adapters);
  }
}

export const dbAdapterPool = new DbAdapterPool();
