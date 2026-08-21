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

import { logger } from "@elizaos/core";

import { resolveStateDir } from "../../config/paths.ts";
import { boundedWalk } from "./bounded-walk.ts";
import { DiskStore } from "./disk-store.ts";
import { type CacheKeyRejection, tryBuildCacheKey } from "./key.ts";
import { Lru } from "./lru.ts";
import { isRedactionDegraded } from "./redact.ts";
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
  /**
   * Called when args could not be canonicalized inside the cache-key budget
   * (over-deep, cyclic, over-wide, accessor-bearing or reflection-hostile).
   * The call is served uncached rather than failing, so this hook is the only
   * way that degradation is observable — it is never silent.
   */
  onUnkeyableArgs?: (info: {
    toolName: string;
    reason: CacheKeyRejection;
  }) => void;
}

type CacheOutputValidator<T> = (output: unknown) => output is T & ToolOutput;

/**
 * Fail-safe bound for anything that may enter either cache tier.
 *
 * Delegates to the shared descriptor-safe walker, so validation, cycle
 * detection and redaction agree on what is walkable and all three reserve
 * width (array length / own-key count) before per-entry work. A cyclic,
 * accessor-bearing, reflection-hostile, over-wide, over-deep or oversize
 * value is rejected without invoking a getter or a Proxy `get` trap and
 * without allocating a values array.
 */
export function isCacheableToolOutput(value: unknown): value is ToolOutput {
  return boundedWalk(value).ok;
}

export class ToolCallCache {
  private readonly memory: Lru<string, ToolCacheEntry>;
  private readonly disk: DiskStore;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly onUnkeyableArgs:
    | ((info: { toolName: string; reason: CacheKeyRejection }) => void)
    | undefined;

  constructor(options: ToolCallCacheOptions) {
    const root = options.diskRoot ?? path.join(resolveStateDir(), "tool-cache");
    this.memory = new Lru(options.memoryCapacity ?? 1000);
    this.disk = new DiskStore(root, options.redact);
    this.now = options.now ?? Date.now;
    this.onUnkeyableArgs =
      options.onUnkeyableArgs ??
      ((info) => {
        logger.warn(
          info,
          "[ToolCallCache] Bypassing cache for unkeyable tool arguments",
        );
      });
  }

  /**
   * Key (toolName, args) under the canonicalizer's budget.
   *
   * Args are model-emitted and untrusted; an over-deep, cyclic, over-wide,
   * accessor-bearing or reflection-hostile argument tree used to overflow the
   * stack here with a `RangeError` before anything else in the cache path ran.
   * It now yields `undefined`, which every caller treats as "this call is not
   * cacheable" — the tool still executes normally, nothing partial is hashed,
   * and the degradation is reported through `onUnkeyableArgs`.
   */
  private keyFor(toolName: string, args: ToolArgs): string | undefined {
    const result = tryBuildCacheKey(toolName, args);
    if (result.ok) return result.key;
    try {
      this.onUnkeyableArgs?.({ toolName, reason: result.reason });
    } catch (error) {
      // error-policy:J7 the cache is optional degradation, not the tool call;
      // a caller-supplied observer must never be able to abort a tool call
      // that would otherwise have run uncached.
      logger.warn(
        { toolName, reason: result.reason, error },
        "[ToolCallCache] onUnkeyableArgs observer threw; continuing uncached",
      );
    }
    return undefined;
  }

  /** Read and validate one already-derived cache key. */
  private getByKey(
    descriptor: CacheableToolDescriptor,
    key: string,
  ): ToolCacheEntry | undefined {
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
    if (isRedactionDegraded(candidate.output)) {
      this.memory.delete(key);
      this.disk.delete(key);
      return undefined;
    }

    if (!fromMemory) this.memory.set(key, candidate);
    return structuredClone(candidate);
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
    const key = this.keyFor(descriptor.name, args);
    if (key === undefined) return undefined;
    return this.getByKey(descriptor, key);
  }

  /** Validate and store one result under an already-derived cache key. */
  private setByKey(
    descriptor: CacheableToolDescriptor,
    key: string,
    output: ToolOutput,
  ): void {
    if (!isCacheableToolOutput(output)) return;
    const cachedAt = this.now();
    let cloned: ToolOutput;
    try {
      cloned = structuredClone(output);
    } catch {
      // Non-cloneable output (functions, etc.) cannot enter either tier.
      return;
    }
    // An output that already equals a degradation sentinel must not become a
    // memory-tier hit either — it would be indistinguishable from corruption.
    if (isRedactionDegraded(cloned)) {
      return;
    }
    const entry: ToolCacheEntry = {
      key,
      toolName: descriptor.name,
      toolVersion: descriptor.version,
      cachedAt,
      expiresAt: cachedAt + descriptor.ttlMs,
      output: cloned,
    };
    this.memory.set(key, entry);
    this.disk.write(entry);
  }

  /**
   * Record a fresh tool result. Returns immediately when the descriptor is not cacheable.
   * Both tiers are written synchronously; the disk tier runs through the
   * privacy redactor inside DiskStore.write.
   *
   * The bound is enforced here, independently of any caller-supplied
   * `shouldCache` predicate, and BEFORE `structuredClone`: a lenient custom
   * validator (or a direct `set()` caller) must not be able to push a cyclic,
   * accessor-bearing, hostile-proxy or million-key value into either tier or
   * through the clone/redaction work.
   */
  set(
    descriptor: CacheableToolDescriptor,
    args: ToolArgs,
    output: ToolOutput,
  ): void {
    if (!descriptor.cacheable) return;
    const key = this.keyFor(descriptor.name, args);
    if (key === undefined) return;
    this.setByKey(descriptor, key, output);
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
    shouldCache: (
      output: unknown,
    ) => output is ToolOutput = isCacheableToolOutput,
  ): Promise<unknown> {
    if (!descriptor.cacheable) return execute();

    // Derive once per run. Besides avoiding repeated bounded walks, this keeps
    // the observable bypass signal to one event and prevents stateful
    // reflection traps from producing different keys for lookup, in-flight
    // deduplication and writeback within the same execution.
    const cacheKey = this.keyFor(descriptor.name, args);
    if (cacheKey === undefined) return execute();

    const hit = this.getByKey(descriptor, cacheKey);
    if (hit && shouldCache(hit.output)) return hit.output;
    if (hit) this.invalidate(descriptor.name, hit.key);
    const inFlightKey = `${cacheKey}:${descriptor.version}`;
    const existing = this.inFlight.get(inFlightKey);
    if (existing) return existing;

    const pending = execute()
      .then((output) => {
        if (shouldCache(output)) this.setByKey(descriptor, cacheKey, output);
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
