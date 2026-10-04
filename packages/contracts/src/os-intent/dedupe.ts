/**
 * The single idempotency authority for OS intents: a launch is applied at most
 * once no matter how many times its `intentId` is redelivered — a retried deep
 * link, a re-tapped notification, a second window racing to route the same
 * launch, or a session restored after a crash all present the same id. The
 * router records only intents it actually ROUTED, so a `blocked` intent retried
 * after the user grants the missing permission is not wrongly suppressed.
 *
 * Pure and clock-injected (every method takes `now`) so ordering and TTL are
 * deterministic under test and identical on every window. The store holds no
 * live handles: a host persists `snapshot()` and rehydrates through the
 * constructor `seed`, which is precisely what makes a restored/reopened session
 * skip the intents its predecessor already handled.
 */

/** One applied launch: its id and the epoch-ms it was first routed. */
export interface AppliedIntentRecord {
  intentId: string;
  appliedAt: number;
}

export interface IntentDedupeStoreOptions {
  /**
   * Records older than this are pruned and treated as un-applied (ms). Default
   * 24h: a same-day relaunch dedupes, but an id from days ago neither pins memory
   * nor suppresses a genuinely new launch that happened to reuse the id.
   */
  ttlMs?: number;
  /** Prior applied records to rehydrate — a restored session's `snapshot()`. */
  seed?: readonly AppliedIntentRecord[];
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class IntentDedupeStore {
  private readonly ttlMs: number;
  private readonly applied = new Map<string, number>();

  constructor(options: IntentDedupeStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    for (const record of options.seed ?? []) {
      this.applied.set(record.intentId, record.appliedAt);
    }
  }

  /**
   * The epoch-ms a live (non-expired) record for `intentId` was applied, or null
   * when absent/expired. Reading expires-and-drops a stale record so a reused id
   * after the TTL is treated as fresh rather than a false duplicate.
   */
  firstAppliedAt(intentId: string, now: number): number | null {
    const appliedAt = this.applied.get(intentId);
    if (appliedAt === undefined) return null;
    if (now - appliedAt > this.ttlMs) {
      this.applied.delete(intentId);
      return null;
    }
    return appliedAt;
  }

  has(intentId: string, now: number): boolean {
    return this.firstAppliedAt(intentId, now) !== null;
  }

  /**
   * Record `intentId` as applied at `now`. Keeps the FIRST applied time, so a
   * later redelivery cannot advance the timestamp and slip the record past its
   * TTL to re-fire.
   */
  record(intentId: string, now: number): void {
    if (!this.applied.has(intentId)) this.applied.set(intentId, now);
  }

  /** Drop expired records; returns how many were pruned. */
  prune(now: number): number {
    let pruned = 0;
    for (const [intentId, appliedAt] of this.applied) {
      if (now - appliedAt > this.ttlMs) {
        this.applied.delete(intentId);
        pruned += 1;
      }
    }
    return pruned;
  }

  /** Live records for persistence; a restored session seeds a new store with this. */
  snapshot(now: number): AppliedIntentRecord[] {
    this.prune(now);
    return [...this.applied].map(([intentId, appliedAt]) => ({
      intentId,
      appliedAt,
    }));
  }

  get size(): number {
    return this.applied.size;
  }
}
