/**
 * Inbound gate for WeChat messages: deduplicates repeat deliveries within a
 * deduplication window and feature-gates group/image messages before handing each
 * message to the `onMessage` callback. Sits between `callback-server` (which
 * normalizes proxy payloads) and the channel's dispatch into the runtime.
 *
 * The dedup cache is a hard-bounded LRU-by-insertion of at most
 * DEDUP_MAX_ENTRIES ids: since `Bot` is a long-lived per-account object on the
 * hot inbound path, capacity eviction (not just window expiry) must hold even
 * when more than DEDUP_MAX_ENTRIES distinct ids arrive inside the window.
 */

import { hasCommittedWechatSideEffect } from "./delivery-error";
import type { WechatMessageContext } from "./types";

const DEFAULT_DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const DEDUP_MAX_ENTRIES = 1000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface BotOptions {
  onMessage: (msg: WechatMessageContext) => void | Promise<void>;
  featuresGroups?: boolean;
  featuresImages?: boolean;
  /** Deduplication window in milliseconds. Defaults to 30 minutes. */
  dedupWindowMs?: number;
}

export class Bot {
  private readonly seen = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly onMessage: (
    msg: WechatMessageContext,
  ) => void | Promise<void>;
  private readonly featuresGroups: boolean;
  private readonly featuresImages: boolean;
  private readonly dedupWindowMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(options: BotOptions) {
    this.onMessage = options.onMessage;
    this.featuresGroups = options.featuresGroups ?? true;
    this.featuresImages = options.featuresImages ?? true;
    this.dedupWindowMs = options.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;

    this.cleanupTimer = setInterval(
      () => this.cleanup(),
      DEDUP_CLEANUP_INTERVAL_MS,
    );
  }

  async handleIncoming(message: WechatMessageContext): Promise<void> {
    // Feature gate: groups
    if (message.group && !this.featuresGroups) {
      return;
    }

    // Feature gate: images
    if (message.type === "image" && !this.featuresImages) {
      return;
    }

    // Skip unsupported types
    if (message.type === "unknown") {
      return;
    }

    const owner = this.inFlight.get(message.id);
    if (owner) {
      await owner;
      return;
    }
    if (this.isDuplicate(message.id)) {
      return;
    }

    const delivery = this.deliver(message);
    this.inFlight.set(message.id, delivery);
    try {
      await delivery;
      this.remember(message.id);
    } catch (error) {
      // error-policy:J2 preserve the delivery failure for the webhook boundary.
      // Only a delivery with an already-committed outbound side effect belongs
      // in the dedup cache; retryable failures must not displace successful ids.
      if (hasCommittedWechatSideEffect(error)) {
        this.remember(message.id);
      }
      throw error;
    } finally {
      if (this.inFlight.get(message.id) === delivery) {
        this.inFlight.delete(message.id);
      }
    }
  }

  private async deliver(message: WechatMessageContext): Promise<void> {
    await this.onMessage(message);
  }

  private isDuplicate(messageId: string): boolean {
    const now = Date.now();
    const seenAt = this.seen.get(messageId);
    if (seenAt !== undefined && seenAt >= now - this.dedupWindowMs) {
      return true;
    }
    if (seenAt !== undefined) {
      this.seen.delete(messageId);
    }

    return false;
  }

  /** Commit a completed delivery while preserving the hard cache bound. */
  private remember(messageId: string): void {
    if (this.stopped) {
      return;
    }
    const now = Date.now();

    // Evict if at capacity. First drop entries older than the dedup window;
    // that alone is insufficient when more than DEDUP_MAX_ENTRIES distinct ids
    // arrive inside the window (a busy account or a flood), so afterward
    // deterministically evict the oldest entries until the map is back under
    // the cap. `Map` preserves insertion order, so `keys()` yields oldest-first
    // and the most recent ids — the ones dedup actually protects — are kept.
    if (this.seen.size >= DEDUP_MAX_ENTRIES) {
      this.cleanup(now);
      while (this.seen.size >= DEDUP_MAX_ENTRIES) {
        const oldest = this.seen.keys().next();
        if (oldest.done) {
          break;
        }
        this.seen.delete(oldest.value);
      }
    }

    this.seen.set(messageId, now);
  }

  private cleanup(now = Date.now()): void {
    const cutoff = now - this.dedupWindowMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) {
        this.seen.delete(id);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.seen.clear();
    this.inFlight.clear();
  }
}
