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

/** TTL classes that can be encoded into a slot `.bin` filename. */
export type SlotCacheTtlClass = "short" | "long" | "extended";

/**
 * Build the basename for a persisted slot/conversation `.bin` file with
 * its TTL class encoded as a middle component: `<base>.<ttl>.bin`. The
 * eviction sweep reads that component back via `parseSlotCacheTtlClass`
 * so a slot persisted with the long retention window isn't deleted on
 * the short horizon (and vice versa). Pass `"long"` for cross-restart
 * conversation KV — that matches the prior global (long-only) behaviour
 * for those files.
 */
export function slotCacheFileName(
  base: string,
  ttl: SlotCacheTtlClass,
): string {
  return `${base}.${ttl}.bin`;
}

/**
 * Parse the TTL class encoded into a slot `.bin` filename by
 * `slotCacheFileName`. Returns `undefined` for legacy / hand-written
 * filenames without an encoded class — those keep the `long` horizon
 * (the prior global behaviour for persisted slot files).
 */
export function parseSlotCacheTtlClass(
  fileName: string,
): SlotCacheTtlClass | undefined {
  // `<base>.<ttl>.bin` — the penultimate dot-component is the class.
  const withoutBin = fileName.endsWith(".bin")
    ? fileName.slice(0, -".bin".length)
    : fileName;
  const lastDot = withoutBin.lastIndexOf(".");
  if (lastDot < 0) return undefined;
  const candidate = withoutBin.slice(lastDot + 1);
  if (
    candidate === "short" ||
    candidate === "long" ||
    candidate === "extended"
  ) {
    return candidate;
  }
  return undefined;
}

/**
 * Sweep the slot-save directory and delete files older than their
 * per-file TTL horizon. The TTL class is read from the filename
 * (`<base>.<ttl>.bin` — see `slotCacheFileName`); files without an
 * encoded class use the `long` horizon (the prior global behaviour).
 * Mtime is the watermark; llama-server rewrites the slot file on every
 * save, so a slot that's actively used keeps a fresh mtime.
 *
 * Returns the number of files deleted. Missing directories are not
 * errors — eviction on a clean install just no-ops.
 */
export async function evictExpired(
  rootDir: string,
  ttls: CacheTtls = DEFAULT_CACHE_TTLS,
  now: number = Date.now(),
): Promise<number> {
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
    const ttlClass = parseSlotCacheTtlClass(entry) ?? "long";
    const horizon = ttlMsForKey(ttlClass, ttls);
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

/**
 * Resolve `prefixHash` from `providerOptions.eliza.prefixHash`. Mirrors
 * `extractPromptCacheKey` — returns null when missing or not a non-empty
 * string. The prefix hash covers ONLY the stable prompt prefix (system
 * prompt + tool definitions + large constant context), so a runtime
 * timestamp in the unstable tail does not invalidate it.
 *
 * Local backends prefer this over `promptCacheKey` when available because
 * it gives the strongest "same prefix → same slot" guarantee: two
 * conversations with byte-identical stable prefixes will land on the same
 * slot regardless of how their tail content differs.
 */
export function extractPrefixHash(providerOptions: unknown): string | null {
  if (!providerOptions || typeof providerOptions !== "object") return null;
  const eliza = (providerOptions as Record<string, unknown>).eliza;
  if (!eliza || typeof eliza !== "object") return null;
  const raw = (eliza as Record<string, unknown>).prefixHash;
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw;
}

/**
 * Stable annotation describing a single segment of the prompt as it was
 * emitted by the runtime planner. The cache-bridge consumes this to
 * compute a stable-prefix-only hash for slot pinning, without having to
 * look at the (timestamp-laden) tail.
 *
 * Mirrors `PromptSegment` in @elizaos/core/src/types/model.ts but is kept
 * standalone so the cache-bridge can be imported by the local-inference
 * backends without a hard dep on `@elizaos/core`.
 */
export interface AnnotatedPromptSegment {
  content: string;
  stable: boolean;
}

/**
 * Hash the longest stable prefix of `segments`. Stops at the first
 * unstable segment, so a runtime timestamp in the unstable tail never
 * shifts the hash. Returns `null` when no stable segment exists, signaling
 * to the caller that prefix-cache reuse cannot be derived purely from the
 * prompt structure (fall back to the prompt-cache-key path instead).
 *
 * The hash is sha256-truncated to 16 hex chars, matching `buildModelHash`
 * — short enough for log lines, wide enough that collision is not a
 * realistic concern for any plausible number of concurrent prefixes.
 */
export function hashStablePrefix(
  segments: readonly AnnotatedPromptSegment[],
): string | null {
  if (segments.length === 0) return null;
  const hash = createHash("sha256");
  let consumed = 0;
  for (const segment of segments) {
    if (!segment.stable) break;
    hash.update(segment.content);
    hash.update("");
    consumed += 1;
  }
  if (consumed === 0) return null;
  return hash.digest("hex").slice(0, 16);
}

/**
 * Extract the per-segment stable annotations from a `providerOptions`
 * payload. The runtime emits these as `providerOptions.eliza.promptSegments`
 * when a structured prompt is available — local backends use it to compute
 * `hashStablePrefix` directly, without having to re-parse the prompt text.
 *
 * Returns `null` when the field is absent or malformed; callers fall back
 * to `extractPromptCacheKey` / `extractPrefixHash`.
 */
export function extractAnnotatedSegments(
  providerOptions: unknown,
): AnnotatedPromptSegment[] | null {
  if (!providerOptions || typeof providerOptions !== "object") return null;
  const eliza = (providerOptions as Record<string, unknown>).eliza;
  if (!eliza || typeof eliza !== "object") return null;
  const raw = (eliza as Record<string, unknown>).promptSegments;
  if (!Array.isArray(raw)) return null;
  const out: AnnotatedPromptSegment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const content = (entry as { content?: unknown }).content;
    const stable = (entry as { stable?: unknown }).stable;
    if (typeof content !== "string" || typeof stable !== "boolean") return null;
    out.push({ content, stable });
  }
  return out;
}

/**
 * Resolve the conversation handle id from a `providerOptions` payload.
 * The runtime stuffs it under `providerOptions.eliza.conversationId` when
 * the calling context represents a long-lived conversation (chat handler,
 * planner loop). When present, local backends should use it as the
 * primary slot key — it's stable across turns regardless of prompt
 * content drift, which gives the strongest possible cache reuse for
 * agentic loops.
 */
export function extractConversationId(providerOptions: unknown): string | null {
  if (!providerOptions || typeof providerOptions !== "object") return null;
  const eliza = (providerOptions as Record<string, unknown>).eliza;
  if (!eliza || typeof eliza !== "object") return null;
  const raw = (eliza as Record<string, unknown>).conversationId;
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw;
}

/**
 * Resolve the stable per-call cache key for the local backends. Order of
 * precedence:
 *   1. Conversation id — strongest signal, identical across turns.
 *   2. Annotated stable-prefix hash — survives unstable-tail drift.
 *   3. `prefixHash` from the runtime cache plan — already stable-only via
 *      `cachePrefixSegments` upstream.
 *   4. `promptCacheKey` (`v5:<prefixHash>`) — back-compat fallback.
 * Returns null when none are available.
 */
export function resolveLocalCacheKey(providerOptions: unknown): string | null {
  const conversationId = extractConversationId(providerOptions);
  if (conversationId) return `conv:${conversationId}`;
  const segments = extractAnnotatedSegments(providerOptions);
  if (segments) {
    const hashed = hashStablePrefix(segments);
    if (hashed) return `seg:${hashed}`;
  }
  const prefixHash = extractPrefixHash(providerOptions);
  if (prefixHash) return `pfx:${prefixHash}`;
  return extractPromptCacheKey(providerOptions);
}
