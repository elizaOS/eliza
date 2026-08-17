/**
 * PushTokenRegistry
 *
 * A small, persistent registry of device push tokens. Each registered device
 * stores `{ token, platform, createdAt }`. The registry is keyed by token so a
 * re-registration of the same token is an idempotent upsert (it refreshes
 * `createdAt`).
 *
 * Persistence rides on the DB-backed runtime cache (`runtime.getCache` /
 * `runtime.setCache`) under a single stable key, mirroring the persistence
 * pattern in `@elizaos/core`'s `NotificationService`. A cold/headless runtime
 * with no cache adapter starts empty and degrades to in-memory only.
 */

import type { IAgentRuntime } from "@elizaos/core";

/** Mobile push transport a token belongs to. */
export type PushPlatform = "ios" | "android";

/** A single registered device push token. */
export interface PushTokenRecord {
  /** The raw device token (APNs hex token or FCM registration token). */
  token: string;
  /** Which transport delivers to this token. */
  platform: PushPlatform;
  /** Unix ms when first registered (refreshed on re-registration). */
  createdAt: number;
}

/** Stable cache key the registry persists under (scoped per agent). */
const cacheKeyFor = (agentId: string): string => `push-tokens:${agentId}`;

export class PushTokenRegistry {
  private tokens = new Map<string, PushTokenRecord>();
  private hydrated = false;
  private hydrationPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly runtime: IAgentRuntime) {}

  private get cacheKey(): string {
    return cacheKeyFor(String(this.runtime.agentId));
  }

  /** Load persisted tokens from the DB-backed cache. Idempotent. */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    if (!this.hydrationPromise) {
      this.hydrationPromise = this.loadPersistedTokens();
    }
    const hydrationPromise = this.hydrationPromise;
    try {
      await hydrationPromise;
    } catch (error) {
      if (this.hydrationPromise === hydrationPromise) {
        this.hydrationPromise = null;
      }
      throw error;
    }
  }

  private async loadPersistedTokens(): Promise<void> {
    const stored = await this.runtime.getCache<PushTokenRecord[]>(
      this.cacheKey,
    );
    if (Array.isArray(stored)) {
      this.tokens = new Map(
        stored
          .filter(isPushTokenRecord)
          .map((record) => [record.token, record]),
      );
    }
    this.hydrated = true;
  }

  private async persist(): Promise<void> {
    await this.runtime.setCache(this.cacheKey, [...this.tokens.values()]);
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const pending = this.mutationTail.then(mutation);
    // error-policy:J5 the caller observes `pending`; this recovery keeps one
    // failed persistence attempt from poisoning every later registry mutation.
    this.mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  /**
   * Register (upsert) a device token. Re-registering an existing token under a
   * new platform moves it to that platform and refreshes `createdAt`.
   */
  async register(platform: PushPlatform, token: string): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new Error("[PushTokenRegistry] token is required");
    }
    await this.enqueueMutation(async () => {
      await this.hydrate();
      this.tokens.set(trimmed, {
        token: trimmed,
        platform,
        createdAt: Date.now(),
      });
      await this.persist();
    });
  }

  /** Unregister a device token. Returns true if it existed. */
  async unregister(token: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      await this.hydrate();
      const removed = this.tokens.delete(token.trim());
      if (removed) {
        await this.persist();
      }
      return removed;
    });
  }

  /** List every registered token record. */
  async list(): Promise<PushTokenRecord[]> {
    await this.hydrate();
    return [...this.tokens.values()];
  }

  /** List token records for one platform. */
  async listByPlatform(platform: PushPlatform): Promise<PushTokenRecord[]> {
    await this.hydrate();
    return [...this.tokens.values()].filter((r) => r.platform === platform);
  }

  /** Total number of registered tokens. */
  async count(): Promise<number> {
    await this.hydrate();
    return this.tokens.size;
  }
}

function isPushTokenRecord(value: unknown): value is PushTokenRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.token === "string" &&
    record.token.length > 0 &&
    (record.platform === "ios" || record.platform === "android") &&
    typeof record.createdAt === "number"
  );
}
