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
  /** Root directory for the on-disk tier. Defaults to ~/.eliza/tool-cache. */
  diskRoot?: string;
  /** Maximum entries in the in-memory tier. Default 1000. */
  memoryCapacity?: number;
  /** Privacy redactor applied to outputs before disk write. Required. */
  redact: PrivacyRedactor;
  /** Clock injection for tests. */
  now?: () => number;
}

export class ToolCallCache {
  private readonly memory: Lru<string, ToolCacheEntry>;
  private readonly disk: DiskStore;
  private readonly now: () => number;

  constructor(options: ToolCallCacheOptions) {
    const root =
      options.diskRoot ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
        ".eliza",
        "tool-cache",
      );
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
    return candidate;
  }

  /**
   * Record a fresh tool result. No-op when the descriptor is not cacheable.
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
      output,
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
  ): Promise<ToolOutput> {
    const hit = this.get(descriptor, args);
    if (hit) return hit.output;
    const output = await execute();
    this.set(descriptor, args, output);
    return output;
  }
}
