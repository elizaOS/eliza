/**
 * Owns one registry client's clock, cache, transport, and generation. Instances
 * make synthetic worlds isolated without mutable process-global test switches;
 * the public registry module retains one production-default instance.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import type { RegistryEndpoint } from "../config/types.eliza.ts";
import {
  fetchRegistrySnapshot,
  isExpectedRegistryNetworkFallback,
  MAX_REGISTRY_JSON_BYTES,
  type RegistryFetch,
  type RegistryNetworkSnapshot,
  validateRegistryJsonShape,
} from "./registry-client-network.ts";
import {
  getPluginInfoFromRegistry,
  normalizePluginLookupAlias,
} from "./registry-client-queries.ts";
import type { RegistryPluginInfo } from "./registry-client-types.ts";

const DEFAULT_TTL_MS = 3_600_000;
const LOCAL_FALLBACK_TTL_MS = 5 * 60_000;
const CACHE_READ_CHUNK_BYTES = 64 * 1024;

class InvalidRegistryCacheError extends Error {
  override readonly name = "InvalidRegistryCacheError";
}

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
    candidate.fetchedAt < 0 ||
    (candidate.sourceUrl !== null && typeof candidate.sourceUrl !== "string") ||
    (candidate.etag !== null && typeof candidate.etag !== "string") ||
    (typeof candidate.sourceUrl === "string" &&
      candidate.sourceUrl.length > 2_048) ||
    (typeof candidate.etag === "string" && candidate.etag.length > 512) ||
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

function clonePlugins(
  plugins: Map<string, RegistryPluginInfo>,
): Map<string, RegistryPluginInfo> {
  return new Map(
    [...plugins].map(([name, info]) => [name, structuredClone(info)]),
  );
}

async function readBoundedCacheFile(filePath: string): Promise<Uint8Array> {
  const handle = await fs.open(filePath, "r");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const buffer = new Uint8Array(CACHE_READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_REGISTRY_JSON_BYTES) {
        throw new InvalidRegistryCacheError(
          "Registry cache exceeds the byte limit",
        );
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function observeDetachedAuthorityLoad<T>(shared: Promise<T>): void {
  // error-policy:J5 the pre-aborted caller observes its AbortError; the
  // detached authority rejection is separately observed and logged here.
  void shared.catch((error) => {
    logger.debug(
      `[registry-client] Detached authority load failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function waitForCaller<T>(
  shared: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return shared;
  if (signal.aborted) {
    // The authority load is intentionally caller-independent; retain an
    // observer so its eventual bounded failure cannot become unhandled after
    // this already-cancelled caller leaves.
    observeDetachedAuthorityLoad(shared);
    return Promise.reject(
      signal.reason ??
        new DOMException("Registry request aborted", "AbortError"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () =>
      reject(
        signal.reason ??
          new DOMException("Registry request aborted", "AbortError"),
      );
    signal.addEventListener("abort", aborted, { once: true });
    shared.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
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
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedCacheFile(resolved);
      } catch (error) {
        // error-policy:J1 only absence and an explicitly bounded oversized
        // cache map to cache-miss; operational filesystem failures stay fatal.
        if (
          error instanceof InvalidRegistryCacheError ||
          (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT")
        ) {
          return null;
        }
        throw new ElizaError("Registry cache could not be read", {
          code: "REGISTRY_CACHE_READ_FAILED",
          context: { filePath: resolved },
          cause: error,
          severity: "fatal",
        });
      }
      try {
        const value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ) as unknown;
        validateRegistryJsonShape(value);
        return parseCacheRecord(value);
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
        let promoted = false;
        try {
          await fs.writeFile(temporary, JSON.stringify(record), {
            encoding: "utf8",
            flag: "wx",
          });
          if (!shouldCommit()) return false;
          await fs.rename(temporary, resolved);
          promoted = true;
          return true;
        } finally {
          if (!promoted) {
            // error-policy:J6 the original write/promotion outcome remains
            // authoritative; cleanup prevents abandoned partial cache files.
            await fs.rm(temporary, { force: true }).catch((error) => {
              logger.debug(
                `[registry-client] Temporary cache cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          }
        }
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
    const memoryAge = this.#memory ? now - this.#memory.fetchedAt : -1;
    if (this.#memory && memoryAge >= 0 && memoryAge < this.#memory.ttlMs) {
      return this.#decorate(this.#memory.plugins);
    }
    let load = this.#load;
    if (!load) {
      const generation = this.#generation;
      load = this.#resolveAuthority(generation).finally(() => {
        if (this.#load === load) this.#load = null;
      });
      this.#load = load;
    }
    const authority = await waitForCaller(load, input.signal);
    return this.#decorate(authority);
  }

  async #resolveAuthority(
    generation: number,
  ): Promise<Map<string, RegistryPluginInfo>> {
    const cached = await this.#options.cacheStore.read();
    const now = this.#now();
    const cacheAge = cached ? now - cached.fetchedAt : -1;
    if (cached && cacheAge >= 0 && cacheAge < this.#ttlMs) {
      const plugins = new Map(cached.plugins);
      if (generation === this.#generation) {
        this.#memory = {
          plugins: clonePlugins(plugins),
          fetchedAt: cached.fetchedAt,
          ttlMs: this.#ttlMs,
        };
      }
      return plugins;
    }
    return this.#loadRegistry(generation, cached);
  }

  async #decorate(
    authority: Map<string, RegistryPluginInfo>,
  ): Promise<Map<string, RegistryPluginInfo>> {
    const plugins = clonePlugins(authority);
    await this.#options.applyLocalWorkspaceApps(plugins);
    await this.#options.applyNodeModulePlugins(plugins);
    await this.#options.mergeCustomEndpoints(
      plugins,
      this.#options.getConfiguredEndpoints(),
    );
    return plugins;
  }

  async #loadRegistry(
    generation: number,
    cached: RegistryCacheRecord | null,
  ): Promise<Map<string, RegistryPluginInfo>> {
    logger.info("[registry-client] Fetching plugin registry...");
    let snapshot: RegistryNetworkSnapshot | null = null;
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
        cacheValidator:
          cached?.sourceUrl && cached.etag
            ? {
                sourceUrl: cached.sourceUrl,
                etag: cached.etag,
                plugins: new Map(cached.plugins),
              }
            : null,
      });
      plugins = clonePlugins(snapshot.plugins);
    } catch (error) {
      // error-policy:J4 only the typed offline condition degrades to explicit
      // local discovery; protocol and validation failures remain fatal.
      if (!isExpectedRegistryNetworkFallback(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(
        `[registry-client] Remote registry unavailable; using local discovery: ${message}`,
      );
      plugins = new Map();
      ttlMs = LOCAL_FALLBACK_TTL_MS;
    }
    logger.info(`[registry-client] Loaded ${plugins.size} upstream plugins`);
    if (generation !== this.#generation) return plugins;

    const fetchedAt = this.#now();
    this.#memory = { plugins: clonePlugins(plugins), fetchedAt, ttlMs };
    if (snapshot) {
      const record: RegistryCacheRecord = {
        fetchedAt,
        sourceUrl: snapshot.etag ? snapshot.sourceUrl : null,
        etag: snapshot.etag,
        plugins: [...clonePlugins(plugins).entries()],
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
