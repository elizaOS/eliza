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
  private readonly onMessage: (
    msg: WechatMessageContext,
  ) => void | Promise<void>;
  private readonly featuresGroups: boolean;
  private readonly featuresImages: boolean;
  private readonly dedupWindowMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

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

  handleIncoming(message: WechatMessageContext): void {
    // Deduplication
    if (this.isDuplicate(message.id)) {
      return;
    }

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

    void Promise.resolve(this.onMessage(message)).catch((error: unknown) => {
      console.error("[wechat] Failed to process inbound message:", error);
    });
  }

  private isDuplicate(messageId: string): boolean {
    const now = Date.now();

    if (this.seen.has(messageId)) {
      return true;
    }

    // Evict if at capacity
    if (this.seen.size >= DEDUP_MAX_ENTRIES) {
      this.cleanup();
    }

    this.seen.set(messageId, now);
    return false;
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.dedupWindowMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) {
        this.seen.delete(id);
      }
    }
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.seen.clear();
  }
}
