/**
 * Owns one registry client's clock, cache, transport, and generation. Instances
 * make synthetic worlds isolated without mutable process-global test switches;
 * the public registry module retains one production-default instance.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "@elizaos/core";
import type { RegistryEndpoint } from "../config/types.eliza.ts";
import {
  fetchRegistrySnapshot,
  isExpectedRegistryNetworkFallback,
  type RegistryFetch,
  type RegistryNetworkSnapshot,
} from "./registry-client-network.ts";
import {
  getPluginInfoFromRegistry,
  normalizePluginLookupAlias,
} from "./registry-client-queries.ts";
import type { RegistryPluginInfo } from "./registry-client-types.ts";

const DEFAULT_TTL_MS = 3_600_000;
const LOCAL_FALLBACK_TTL_MS = 5 * 60_000;

export interface RegistryCacheRecord {
  fetchedAt: number;
  sourceUrl: string | null;
  etag: string | null;
  plugins: Array<[string, RegistryPluginInfo]>;
}

export interface RegistryCacheStore {
  read(): Promise<RegistryCacheRecord | null>;
  write(
    record: RegistryCacheRecord,
    shouldCommit: () => boolean,
  ): Promise<boolean>;
  remove(): Promise<void>;
}

export interface RegistryClientOptions {
  generatedRegistryUrl: string;
  indexRegistryUrl: string;
  cacheStore: RegistryCacheStore;
  now?: () => number;
  fetchImpl?: RegistryFetch;
  cloudReachable?: () => Promise<boolean>;
  timeoutMs?: number;
  cacheTtlMs?: number;
  applyLocalWorkspaceApps: (
    plugins: Map<string, RegistryPluginInfo>,
  ) => Promise<void>;
  applyNodeModulePlugins: (
    plugins: Map<string, RegistryPluginInfo>,
  ) => Promise<void>;
  sanitizeSandbox: (value?: string) => string;
  getConfiguredEndpoints: () => RegistryEndpoint[];
  mergeCustomEndpoints: (
    plugins: Map<string, RegistryPluginInfo>,
    endpoints: RegistryEndpoint[],
  ) => Promise<void>;
}

function isRegistryPluginInfo(
  value: unknown,
  key: string,
): value is RegistryPluginInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const plugin = value as Partial<RegistryPluginInfo>;
  return (
    plugin.name === key &&
    typeof plugin.gitRepo === "string" &&
    typeof plugin.gitUrl === "string" &&
    typeof plugin.description === "string" &&
    (plugin.homepage === null || typeof plugin.homepage === "string") &&
    Array.isArray(plugin.topics) &&
    plugin.topics.every((topic) => typeof topic === "string") &&
    typeof plugin.stars === "number" &&
    Number.isFinite(plugin.stars) &&
    typeof plugin.language === "string" &&
    typeof plugin.npm === "object" &&
    plugin.npm !== null &&
    typeof plugin.npm.package === "string" &&
    typeof plugin.git === "object" &&
    plugin.git !== null &&
    typeof plugin.supports === "object" &&
    plugin.supports !== null &&
    typeof plugin.supports.v0 === "boolean" &&
    typeof plugin.supports.v1 === "boolean" &&
    typeof plugin.supports.v2 === "boolean"
  );
}

function parseCacheRecord(value: unknown): RegistryCacheRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const candidate = value as Partial<RegistryCacheRecord>;
  if (
    typeof candidate.fetchedAt !== "number" ||
    !Number.isFinite(candidate.fetchedAt) ||
    (candidate.sourceUrl !== null && typeof candidate.sourceUrl !== "string") ||
    (candidate.etag !== null && typeof candidate.etag !== "string") ||
    !Array.isArray(candidate.plugins)
  ) {
    return null;
  }
  const seen = new Set<string>();
  for (const entry of candidate.plugins) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      seen.has(entry[0]) ||
      !isRegistryPluginInfo(entry[1], entry[0])
    ) {
      return null;
    }
    seen.add(entry[0]);
  }
  if ((candidate.sourceUrl === null) !== (candidate.etag === null)) return null;
  return candidate as RegistryCacheRecord;
}

/** Create an atomic JSON cache whose final rename is generation-fenced. */
export function createFileRegistryCacheStore(
  filePath: string | (() => string),
): RegistryCacheStore {
  const resolveFilePath = () =>
    path.resolve(typeof filePath === "function" ? filePath() : filePath);
  let mutationTail: Promise<void> = Promise.resolve();
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = mutationTail.then(operation, operation);
    // error-policy:J5 every mutation rejection is returned through `run`; this
    // branch only keeps the private serialization tail usable.
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return {
    async read() {
      await mutationTail;
      const resolved = resolveFilePath();
      try {
        return parseCacheRecord(
          JSON.parse(await fs.readFile(resolved, "utf8")) as unknown,
        );
      } catch {
        // error-policy:J3 an absent or corrupt cache is explicitly invalid and
        // triggers authoritative resolution; it is never a valid empty map.
        return null;
      }
    },
    write(record, shouldCommit) {
      return mutate(async () => {
        const resolved = resolveFilePath();
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        const temporary = `${resolved}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(record), {
          encoding: "utf8",
          flag: "wx",
        });
        if (!shouldCommit()) {
          await fs.rm(temporary, { force: true });
          return false;
        }
        await fs.rename(temporary, resolved);
        return true;
      });
    },
    remove() {
      return mutate(async () => {
        const resolved = resolveFilePath();
        try {
          await fs.unlink(resolved);
        } catch (error) {
          // error-policy:J1 ENOENT is the cache-store boundary's explicit
          // absent state; every other filesystem failure remains fatal.
          if (
            typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            throw error;
          }
        }
      });
    },
  };
}

export class RegistryClient {
  readonly #options: RegistryClientOptions;
  readonly #now: () => number;
  readonly #ttlMs: number;
  #memory: {
    plugins: Map<string, RegistryPluginInfo>;
    fetchedAt: number;
    ttlMs: number;
  } | null = null;
  #load: Promise<Map<string, RegistryPluginInfo>> | null = null;
  #generation = 0;

  constructor(options: RegistryClientOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
    if (!Number.isInteger(this.#ttlMs) || this.#ttlMs < 1) {
      throw new Error("Registry cache TTL must be a positive integer");
    }
  }

  invalidateMemory(): void {
    this.#memory = null;
    this.#load = null;
    this.#generation += 1;
  }

  async getRegistryPlugins(
    input: { signal?: AbortSignal } = {},
  ): Promise<Map<string, RegistryPluginInfo>> {
    const now = this.#now();
    if (this.#memory && now - this.#memory.fetchedAt < this.#memory.ttlMs) {
      return this.#memory.plugins;
    }

    const cached = await this.#options.cacheStore.read();
    if (cached && now - cached.fetchedAt < this.#ttlMs) {
      const plugins = new Map(cached.plugins);
      await this.#options.applyLocalWorkspaceApps(plugins);
      await this.#options.applyNodeModulePlugins(plugins);
      await this.#options.mergeCustomEndpoints(
        plugins,
        this.#options.getConfiguredEndpoints(),
      );
      this.#memory = { plugins, fetchedAt: now, ttlMs: this.#ttlMs };
      return plugins;
    }
    if (this.#load) return this.#load;

    const generation = this.#generation;
    const load = this.#loadRegistry(generation, cached, input.signal).finally(
      () => {
        if (this.#load === load) this.#load = null;
      },
    );
    this.#load = load;
    return load;
  }

  async #loadRegistry(
    generation: number,
    cached: RegistryCacheRecord | null,
    requestSignal?: AbortSignal,
  ): Promise<Map<string, RegistryPluginInfo>> {
    logger.info("[registry-client] Fetching plugin registry...");
    let snapshot: RegistryNetworkSnapshot | null = null;
    let cachePlugins: Map<string, RegistryPluginInfo> | null = null;
    let plugins: Map<string, RegistryPluginInfo>;
    let ttlMs = this.#ttlMs;
    try {
      snapshot = await fetchRegistrySnapshot({
        generatedRegistryUrl: this.#options.generatedRegistryUrl,
        indexRegistryUrl: this.#options.indexRegistryUrl,
        applyLocalWorkspaceApps: this.#options.applyLocalWorkspaceApps,
        applyNodeModulePlugins: this.#options.applyNodeModulePlugins,
        sanitizeSandbox: this.#options.sanitizeSandbox,
        fetchImpl: this.#options.fetchImpl,
        cloudReachable: this.#options.cloudReachable,
        timeoutMs: this.#options.timeoutMs,
        now: this.#now,
        signal: requestSignal,
        cacheValidator:
          cached?.sourceUrl && cached.etag
            ? {
                sourceUrl: cached.sourceUrl,
                etag: cached.etag,
                plugins: new Map(cached.plugins),
              }
            : null,
      });
      plugins = snapshot.plugins;
      cachePlugins = new Map(plugins);
    } catch (error) {
      // error-policy:J4 only the typed offline condition degrades to explicit
      // local discovery; protocol and validation failures remain fatal.
      if (!isExpectedRegistryNetworkFallback(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(
        `[registry-client] Remote registry unavailable; using local discovery: ${message}`,
      );
      plugins = new Map();
      await this.#options.applyLocalWorkspaceApps(plugins);
      await this.#options.applyNodeModulePlugins(plugins);
      ttlMs = LOCAL_FALLBACK_TTL_MS;
    }
    await this.#options.mergeCustomEndpoints(
      plugins,
      this.#options.getConfiguredEndpoints(),
    );
    logger.info(`[registry-client] Loaded ${plugins.size} plugins`);
    if (generation !== this.#generation) return plugins;

    const fetchedAt = this.#now();
    this.#memory = { plugins, fetchedAt, ttlMs };
    if (snapshot) {
      const record: RegistryCacheRecord = {
        fetchedAt,
        sourceUrl: snapshot.etag ? snapshot.sourceUrl : null,
        etag: snapshot.etag,
        plugins: [...(cachePlugins ?? plugins).entries()],
      };
      try {
        await this.#options.cacheStore.write(
          record,
          () => generation === this.#generation,
        );
      } catch (error) {
        // error-policy:J4 the authoritative result remains available while
        // the cache failure is surfaced as an explicit warning.
        logger.warn(`[registry-client] Cache write failed: ${String(error)}`);
      }
    }
    return plugins;
  }

  async refreshRegistry(
    input: { signal?: AbortSignal } = {},
  ): Promise<Map<string, RegistryPluginInfo>> {
    this.invalidateMemory();
    await this.#options.cacheStore.remove();
    return this.getRegistryPlugins(input);
  }

  async getPluginInfo(name: string): Promise<RegistryPluginInfo | null> {
    const plugins = await this.getRegistryPlugins();
    const normalizedName = normalizePluginLookupAlias(name);
    for (const candidate of new Set([normalizedName, name])) {
      const info = getPluginInfoFromRegistry(plugins, candidate);
      if (info) return info;
    }
    return null;
  }
}
