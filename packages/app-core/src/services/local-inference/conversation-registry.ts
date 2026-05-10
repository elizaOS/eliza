/**
 * Conversation registry for the local-inference path.
 *
 * Today's slot allocation is purely a hash function: `deriveSlotId` maps a
 * `promptCacheKey` (or any stable string) to `slot_id` in `[0, parallel)`.
 * That works for one-shot calls but breaks for long agentic loops:
 *
 *   - Two distinct conversations whose cache keys hash to the same slot
 *     evict each other's KV every turn (slot thrashing).
 *   - The current high-water mark of concurrent conversations is invisible,
 *     so `--parallel N` cannot be tuned to fit.
 *   - There is no notion of an explicit "I am still using this slot" lease,
 *     so eviction is purely best-effort.
 *
 * This registry keeps a per-conversation reservation. `openConversation`
 * picks the lowest-loaded slot and pins the conversation to it; subsequent
 * `generateInConversation` calls always land on the same slot. When the
 * pool is full, slot reuse falls back to the same-as-before hash policy
 * (two leases on the same slot still serialise correctly via the dispatcher's
 * generation queue).
 *
 * The registry tracks the high-water mark of concurrently-open conversations
 * so the engine can warn (or, in the future, restart llama-server with a
 * higher --parallel) when the load outgrows the configured slot count.
 */

import { createHash } from "node:crypto";

/**
 * Opaque handle returned by `openConversation`. Callers MUST treat this as
 * opaque — the registry owns the slot id and lifetime.
 */
export interface ConversationHandle {
  readonly conversationId: string;
  readonly modelId: string;
  /**
   * Pinned slot id in `[0, parallel)`, or `-1` when slot pinning is disabled
   * (parallel <= 0). Used by both backends as the cache key:
   *   - llama-server: forwarded as `slot_id` in the request payload.
   *   - node-llama-cpp: combined with the conversation id to derive the
   *     session-pool key so identical conversations share a session.
   */
  readonly slotId: number;
  /** Wall-clock ms when the handle was opened. */
  readonly openedAtMs: number;
  /** Wall-clock ms when the handle was last touched (open or generate). */
  lastUsedMs: number;
  /** TTL after which the registry MAY auto-close on the next sweep. */
  readonly ttlMs: number;
  /** True when `closeConversation` has been called; further use is rejected. */
  closed: boolean;
}

export interface OpenConversationArgs {
  conversationId: string;
  modelId: string;
  /** Slot count from the running server (`--parallel N`). Defaults to 1. */
  parallel?: number;
  /**
   * TTL after which the handle is considered idle and may be auto-closed
   * by `evictIdle`. Defaults to 60 minutes — long enough for an LLM call
   * to finish even on a slow drafter, short enough to recover from forgotten
   * close calls within the long-cache window.
   */
  ttlMs?: number;
}

const DEFAULT_HANDLE_TTL_MS = 60 * 60 * 1000;

/**
 * In-memory registry of open conversation handles. A single instance is
 * shared by the engine; each backend reads from it on every generate to
 * decide which slot to pin to.
 */
export class ConversationRegistry {
  private readonly handles = new Map<string, ConversationHandle>();
  /** Per-slot reference count; lowest-loaded slot wins on next open. */
  private readonly slotLoad = new Map<number, number>();
  /** Largest concurrent open count seen; the engine reads this for parallel auto-tune. */
  private highWaterMark = 0;

  /**
   * Lookup / open a conversation handle. Idempotent for the same
   * conversation id + model id; callers can call this on every turn
   * without leaking handles. When the call is reusing an existing handle,
   * `lastUsedMs` is bumped for LRU-style eviction tracking.
   */
  open(args: OpenConversationArgs): ConversationHandle {
    if (!args.conversationId) {
      throw new Error("[conversation-registry] conversationId is required");
    }
    if (!args.modelId) {
      throw new Error("[conversation-registry] modelId is required");
    }
    const compositeKey = this.compositeKey(args.conversationId, args.modelId);
    const existing = this.handles.get(compositeKey);
    if (existing && !existing.closed) {
      existing.lastUsedMs = Date.now();
      return existing;
    }

    const parallel =
      typeof args.parallel === "number" && args.parallel > 0
        ? Math.floor(args.parallel)
        : 1;
    const slotId = this.pickLowestLoadedSlot(parallel, args.conversationId);
    const now = Date.now();
    const handle: ConversationHandle = {
      conversationId: args.conversationId,
      modelId: args.modelId,
      slotId,
      openedAtMs: now,
      lastUsedMs: now,
      ttlMs: args.ttlMs ?? DEFAULT_HANDLE_TTL_MS,
      closed: false,
    };
    this.handles.set(compositeKey, handle);
    this.slotLoad.set(slotId, (this.slotLoad.get(slotId) ?? 0) + 1);
    if (this.handles.size > this.highWaterMark) {
      this.highWaterMark = this.handles.size;
    }
    return handle;
  }

  /**
   * Lookup an open handle by conversation+model. Returns null when the
   * conversation has not been opened or has already been closed. Bumps
   * `lastUsedMs` so an LRU sweep treats reads as activity.
   */
  get(conversationId: string, modelId: string): ConversationHandle | null {
    const handle = this.handles.get(this.compositeKey(conversationId, modelId));
    if (!handle || handle.closed) return null;
    handle.lastUsedMs = Date.now();
    return handle;
  }

  /**
   * Close + drop a handle. Idempotent — closing an unknown / already-closed
   * handle is a no-op so callers can call this from cleanup paths
   * unconditionally.
   */
  close(conversationId: string, modelId: string): void {
    const compositeKey = this.compositeKey(conversationId, modelId);
    const handle = this.handles.get(compositeKey);
    if (!handle) return;
    handle.closed = true;
    this.handles.delete(compositeKey);
    const remaining = (this.slotLoad.get(handle.slotId) ?? 0) - 1;
    if (remaining <= 0) {
      this.slotLoad.delete(handle.slotId);
    } else {
      this.slotLoad.set(handle.slotId, remaining);
    }
  }

  /**
   * Sweep handles whose `lastUsedMs` is older than their TTL. Returns the
   * conversation ids dropped so callers can persist final KV state to
   * disk, etc. Safe to call on a timer.
   */
  evictIdle(now: number = Date.now()): string[] {
    const dropped: string[] = [];
    for (const [compositeKey, handle] of this.handles) {
      if (now - handle.lastUsedMs > handle.ttlMs) {
        handle.closed = true;
        this.handles.delete(compositeKey);
        const remaining = (this.slotLoad.get(handle.slotId) ?? 0) - 1;
        if (remaining <= 0) {
          this.slotLoad.delete(handle.slotId);
        } else {
          this.slotLoad.set(handle.slotId, remaining);
        }
        dropped.push(handle.conversationId);
      }
    }
    return dropped;
  }

  /**
   * Snapshot every currently-open handle. Used by the shutdown path to
   * emit a save-state request per slot.
   */
  snapshot(): readonly ConversationHandle[] {
    return [...this.handles.values()];
  }

  /** Largest concurrent open count seen since the registry was created. */
  highWater(): number {
    return this.highWaterMark;
  }

  /** Number of currently-open handles. */
  size(): number {
    return this.handles.size;
  }

  /**
   * Pick the slot with the fewest in-flight handles. Ties are broken by a
   * deterministic hash of the conversation id, which avoids consistently
   * loading slot 0 when N concurrent opens race.
   */
  private pickLowestLoadedSlot(
    parallel: number,
    conversationId: string,
  ): number {
    if (parallel <= 1) return 0;
    let bestSlot = 0;
    let bestLoad = Number.POSITIVE_INFINITY;
    for (let slot = 0; slot < parallel; slot += 1) {
      const load = this.slotLoad.get(slot) ?? 0;
      if (load < bestLoad) {
        bestLoad = load;
        bestSlot = slot;
      }
    }
    if (bestLoad === 0) return bestSlot;
    // All slots are loaded equally — use the conversation hash for a
    // deterministic tie-break. Same conversation, same slot when reopened.
    const digest = createHash("sha256").update(conversationId).digest();
    return digest.readUInt32BE(0) % parallel;
  }

  private compositeKey(conversationId: string, modelId: string): string {
    return `${modelId}::${conversationId}`;
  }
}

/**
 * Module-singleton registry. The engine reads this on every generate; the
 * conversation lifecycle API (`openConversation`, `closeConversation`)
 * mutates it.
 */
export const conversationRegistry = new ConversationRegistry();
