/**
 * Cache bridge for the local-inference path.
 *
 * Translates the runtime's `ProviderCachePlan` (a provider-neutral cache
 * plan emitted by `@elizaos/core`'s `buildProviderCachePlan`) into
 * concrete behaviour for the two local backends:
 *
 *   1. Out-of-process llama-server (DFlash / buun-llama-cpp): stable
 *      slot-id derivation + on-disk slot KV save/restore directory layout
 *      + TTL-based eviction by mtime.
 *   2. In-process node-llama-cpp: a session pool (see
 *      `session-pool.ts`) keyed by `promptCacheKey`.
 *
 * This module is pure logic — no llama-server process management, no
 * node-llama-cpp imports. All filesystem state is rooted under
 * `local-inference/llama-cache/` so cleanup is easy and explicit.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { localInferenceRoot } from "./paths";

/**
 * TTLs for cached prefix data, mirroring the cloud-side semantics:
 *   - `short`: roughly the "default" Anthropic ephemeral cache window.
 *   - `long`: roughly the "1h" Anthropic ephemeral cache window.
 *   - `extended`: the OpenAI 24h prompt-cache retention window.
 *
 * Values are in milliseconds. Eviction uses file mtime, not access time,
 * so a slot that is read repeatedly without being rewritten still ages
 * out — which matches how llama-server writes the slot file each turn.
 */
export interface CacheTtls {
  short: number;
  long: number;
  extended?: number;
}

export const DEFAULT_CACHE_TTLS: CacheTtls = {
  short: 5 * 60 * 1000,
  long: 60 * 60 * 1000,
  extended: 24 * 60 * 60 * 1000,
};

/**
 * Root directory for all local llama-cache state. Anything inside is
 * Eliza-owned and safe to delete to reset the cache.
 */
export function llamaCacheRoot(): string {
  return path.join(localInferenceRoot(), "llama-cache");
}

/**
 * Per-model-hash cache directory. Slot save files for one model never
 * collide with another model's; switching active model does not need to
 * wipe the cache.
 */
export function cacheRoot(modelHash: string): string {
  if (!modelHash) {
    throw new Error("[cache-bridge] cacheRoot requires a non-empty modelHash");
  }
  return path.join(llamaCacheRoot(), modelHash);
}

/**
 * llama-server `--slot-save-path` argument: the directory llama-server
 * writes per-slot KV state into when a request includes
 * `cache_prompt: true`. One directory per model hash.
 */
export function slotSavePath(modelHash: string): string {
  return cacheRoot(modelHash);
}

/**
 * Stable model-fingerprint hash. Combines the absolute paths of the
 * target / drafter GGUFs and the cache-type knobs so two distinct
 * configurations don't share a slot directory.
 */
export function buildModelHash(input: {
  targetModelPath: string;
  drafterModelPath?: string | null;
  cacheTypeK?: string | null;
  cacheTypeV?: string | null;
  /** Optional extra discriminator (context size, parallel, etc.). */
  extra?: string | null;
}): string {
  const hash = createHash("sha256");
  hash.update(input.targetModelPath);
  hash.update("");
  hash.update(input.drafterModelPath ?? "");
  hash.update("");
  hash.update(input.cacheTypeK ?? "");
  hash.update("");
  hash.update(input.cacheTypeV ?? "");
  hash.update("");
  hash.update(input.extra ?? "");
  return hash.digest("hex").slice(0, 16);
}

/**
 * Map a `promptCacheKey` to a llama-server slot id in [0, parallel).
 *
 * llama-server's `--parallel N` flag pre-allocates N decoding slots and
 * accepts a `slot_id` integer in `[0, N-1]` on each request. By hashing
 * the cache key into that range we get:
 *
 *   - The same prefix hash always lands on the same slot, so the in-RAM
 *     KV cache from the previous turn is reused.
 *   - Different prefix hashes spread across slots and don't fight for
 *     the same KV memory.
 *
 * Pass `parallel <= 0` to disable slot pinning (returns -1, the
 * llama-server "any free slot" sentinel).
 */
export function deriveSlotId(promptCacheKey: string, parallel: number): number {
  if (!Number.isFinite(parallel) || parallel <= 0) return -1;
  if (!promptCacheKey) return -1;
  const integerParallel = Math.max(1, Math.floor(parallel));
  if (integerParallel === 1) return 0;
  const digest = createHash("sha256").update(promptCacheKey).digest();
  // Read first 4 bytes as an unsigned big-endian int. Plenty of entropy
  // for parallel ≤ 64.
  const value = digest.readUInt32BE(0);
  return value % integerParallel;
}

/**
 * Convert the runtime-side `CacheTTL` enum + OpenAI extended retention
 * hint into a concrete TTL in milliseconds. This is what the eviction
 * sweep uses when deciding whether a slot file is still live.
 */
export function ttlMsForKey(
  ttl: "short" | "long" | "extended" | undefined,
  ttls: CacheTtls = DEFAULT_CACHE_TTLS,
): number {
  if (ttl === "long") return ttls.long;
  if (ttl === "extended") return ttls.extended ?? ttls.long;
  return ttls.short;
}

/**
 * Sweep the slot-save directory and delete files older than the longest
 * configured TTL. Mtime is the watermark; llama-server rewrites the slot
 * file on every save, so a slot that's actively used keeps a fresh mtime.
 *
 * Returns the number of files deleted. Missing directories are not
 * errors — eviction on a clean install just no-ops.
 */
export async function evictExpired(
  rootDir: string,
  ttls: CacheTtls = DEFAULT_CACHE_TTLS,
  now: number = Date.now(),
): Promise<number> {
  const horizon = Math.max(ttls.short, ttls.long, ttls.extended ?? 0);
  let entries: string[];
  try {
    entries = await fs.readdir(rootDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let deleted = 0;
  for (const entry of entries) {
    const full = path.join(rootDir, entry);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs > horizon) {
      try {
        await fs.unlink(full);
        deleted += 1;
      } catch {
        // Best-effort cleanup; another process may already have removed it.
      }
    }
  }
  return deleted;
}

export interface CacheStatsEntry {
  file: string;
  sizeBytes: number;
  mtimeMs: number;
  ageMs: number;
}

/**
 * Snapshot of the on-disk slot-save directory. Used by the public
 * `getLocalCacheStats()` debugging endpoint.
 */
export async function readCacheStats(
  rootDir: string,
  now: number = Date.now(),
): Promise<CacheStatsEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(rootDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: CacheStatsEntry[] = [];
  for (const entry of entries) {
    const full = path.join(rootDir, entry);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({
      file: entry,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      ageMs: Math.max(0, now - stat.mtimeMs),
    });
  }
  out.sort((left, right) => left.file.localeCompare(right.file));
  return out;
}

/**
 * Resolve `promptCacheKey` from a `providerOptions` payload as emitted
 * by `buildProviderCachePlan`. The runtime stuffs it under
 * `providerOptions.eliza.promptCacheKey`. Returns `null` when the key is
 * missing or not a non-empty string — callers fall back to the default
 * "_default" session in that case.
 */
export function extractPromptCacheKey(providerOptions: unknown): string | null {
  if (!providerOptions || typeof providerOptions !== "object") return null;
  const eliza = (providerOptions as Record<string, unknown>).eliza;
  if (!eliza || typeof eliza !== "object") return null;
  const raw = (eliza as Record<string, unknown>).promptCacheKey;
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw;
}
