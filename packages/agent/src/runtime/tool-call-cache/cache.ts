/**
 * Tool-call cache.
 *
 * Two-tier: in-memory LRU + on-disk persistent. Entries are keyed by
 * `sha256(toolName + ':' + canonicalJson(args))` and tagged with the tool
 * implementation version. A version bump on the descriptor invalidates all
 * prior entries for that tool without an explicit purge. Side-effect tools
 * opt out via `cacheable: false` and short-circuit straight to the
 * underlying executor.
 *
 * The disk tier runs every output through a privacy redactor before
 * serialisation. Tool inputs/outputs may contain user PII (search queries,
 * fetched HTML, file contents) and the cross-session disk reuse is what
 * forces this — a process-only cache could rely on the surrounding
 * trajectory filter, but a shared on-disk store cannot.
 */

import path from "node:path";

import { resolveStateDir } from "../../config/paths.ts";
import { DiskStore } from "./disk-store.ts";
import { buildCacheKey } from "./key.ts";
import { Lru } from "./lru.ts";
import type {
  CacheableToolDescriptor,
  PrivacyRedactor,
  ToolArgs,
  ToolCacheEntry,
  ToolOutput,
} from "./types.ts";

export interface ToolCallCacheOptions {
  /** Root directory for the on-disk tier. Defaults to `<stateDir>/tool-cache`. */
  diskRoot?: string;
  /** Maximum entries in the in-memory tier. Default 1000. */
  memoryCapacity?: number;
  /** Privacy redactor applied to outputs before disk write. Required. */
  redact: PrivacyRedactor;
  /** Clock injection for tests. */
  now?: () => number;
}

type CacheOutputValidator<T> = (output: unknown) => output is T & ToolOutput;

function isToolOutput(
  value: unknown,
  seen = new WeakSet<object>(),
): value is ToolOutput {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.every((entry) => isToolOutput(entry, seen));
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every((entry) => isToolOutput(entry, seen))
  );
}

export class ToolCallCache {
  private readonly memory: Lru<string, ToolCacheEntry>;
  private readonly disk: DiskStore;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(options: ToolCallCacheOptions) {
    const root = options.diskRoot ?? path.join(resolveStateDir(), "tool-cache");
    this.memory = new Lru(options.memoryCapacity ?? 1000);
    this.disk = new DiskStore(root, options.redact);
    this.now = options.now ?? Date.now;
  }

  /**
   * Look up a cache entry for (toolName, args). Returns undefined on miss,
   * on TTL expiry, or on tool-version mismatch. A disk hit promotes the
   * entry into the in-memory tier.
   */
  get(
    descriptor: CacheableToolDescriptor,
    args: ToolArgs,
  ): ToolCacheEntry | undefined {
    if (!descriptor.cacheable) return undefined;
    const key = buildCacheKey(descriptor.name, args);
    const fromMemory = this.memory.get(key);
    const candidate = fromMemory ?? this.disk.read(key);
    if (!candidate) return undefined;

    if (candidate.toolVersion !== descriptor.version) {
      this.memory.delete(key);
      this.disk.delete(key);
      return undefined;
    }
    if (candidate.expiresAt <= this.now()) {
      this.memory.delete(key);
      this.disk.delete(key);
      return undefined;
    }

    if (!fromMemory) this.memory.set(key, candidate);
    return structuredClone(candidate);
  }

  /**
   * Record a fresh tool result. Returns immediately when the descriptor is not cacheable.
   * Both tiers are written synchronously; the disk tier runs through the
   * privacy redactor inside DiskStore.write.
   */
  set(
    descriptor: CacheableToolDescriptor,
    args: ToolArgs,
    output: ToolOutput,
  ): void {
    if (!descriptor.cacheable) return;
    const key = buildCacheKey(descriptor.name, args);
    const cachedAt = this.now();
    const entry: ToolCacheEntry = {
      key,
      toolName: descriptor.name,
      toolVersion: descriptor.version,
      cachedAt,
      expiresAt: cachedAt + descriptor.ttlMs,
      output: structuredClone(output),
    };
    this.memory.set(key, entry);
    this.disk.write(entry);
  }

  /**
   * Drop entries from the cache. With no arguments this purges everything.
   * With a tool name it purges every in-memory entry whose toolName matches,
   * and removes the disk-tier file for each matching key. Disk entries
   * written from a previous process that never made it into this LRU are
   * not enumerable (we deliberately do not maintain a disk index) — for a
   * full per-tool disk purge, bump the tool's `version` in its descriptor,
   * which forces every prior entry to miss on lookup.
   */
  invalidate(toolName?: string, argHash?: string): void {
    if (!toolName) {
      this.memory.clear();
      this.disk.clear();
      return;
    }
    if (argHash) {
      this.memory.delete(argHash);
      this.disk.delete(argHash);
      return;
    }
    const toDelete: string[] = [];
    for (const [key, entry] of this.memory.entries()) {
      if (entry.toolName === toolName) toDelete.push(key);
    }
    for (const key of toDelete) {
      this.memory.delete(key);
      this.disk.delete(key);
    }
  }

  /**
   * Run a tool through the cache. On hit, returns the cached output without
   * invoking `execute`. On miss, runs `execute`, persists the result, and
   * returns it. Side-effect tools (`cacheable: false`) always run.
   */
  async run(
    descriptor: CacheableToolDescriptor,
    args: ToolArgs,
    execute: () => Promise<ToolOutput>,
  ): Promise<ToolOutput>;
  async run<T>(
    descriptor: CacheableToolDescriptor,
    args: ToolArgs,
    execute: () => Promise<T>,
    shouldCache: CacheOutputValidator<T>,
  ): Promise<T>;
  async run(
    descriptor: CacheableToolDescriptor,
    args: ToolArgs,
    execute: () => Promise<unknown>,
    shouldCache: (output: unknown) => output is ToolOutput = isToolOutput,
  ): Promise<unknown> {
    const hit = this.get(descriptor, args);
    if (hit && shouldCache(hit.output)) return hit.output;
    if (hit) this.invalidate(descriptor.name, hit.key);
    if (!descriptor.cacheable) return execute();

    const cacheKey = buildCacheKey(descriptor.name, args);
    const inFlightKey = `${cacheKey}:${descriptor.version}`;
    const existing = this.inFlight.get(inFlightKey);
    if (existing) return existing;

    const pending = execute()
      .then((output) => {
        if (shouldCache(output)) this.set(descriptor, args, output);
        return output;
      })
      .finally(() => {
        if (this.inFlight.get(inFlightKey) === pending) {
          this.inFlight.delete(inFlightKey);
        }
      });
    this.inFlight.set(inFlightKey, pending);
    return pending;
  }
}
