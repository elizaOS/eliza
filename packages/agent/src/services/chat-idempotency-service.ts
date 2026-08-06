/**
 * Owns bounded idempotency reservations and replayable outcomes for chat turns.
 * Route adapters choose the conversation scope and durable outcome shape while
 * this service enforces active-turn ownership and settled-result retention.
 */
export interface ChatIdempotencyStore<Outcome> {
  normalize(value: unknown): string | null;
  reserve(scope: string, clientMessageId: string | null, now?: number): boolean;
  release(scope: string, clientMessageId: string | null): void;
  firstSeenAt(scope: string, clientMessageId: string | null): number | null;
  settle(scope: string, clientMessageId: string | null, outcome: Outcome): void;
  outcome(scope: string, clientMessageId: string | null): Outcome | null;
  reset(): void;
  readonly retentionMs: number;
}

interface Entry<Outcome> {
  firstSeenAt: number;
  settledAt?: number;
  outcome?: Outcome;
}

export function createChatIdempotencyStore<Outcome>(options?: {
  maxKeyLength?: number;
  retentionMs?: number;
}): ChatIdempotencyStore<Outcome> {
  const maxKeyLength = options?.maxKeyLength ?? 128;
  const retentionMs = options?.retentionMs ?? 5 * 60_000;
  const entries = new Map<string, Entry<Outcome>>();
  let lastSweepAt = 0;
  const keyFor = (scope: string, id: string): string => `${scope}:${id}`;

  return {
    retentionMs,
    normalize(value) {
      if (typeof value !== "string") return null;
      const normalized = value.trim();
      return normalized.length > 0 && normalized.length <= maxKeyLength
        ? normalized
        : null;
    },
    reserve(scope, clientMessageId, now = Date.now()) {
      if (!clientMessageId) return false;
      const key = keyFor(scope, clientMessageId);
      const current = entries.get(key);
      if (current) {
        if (
          current.settledAt === undefined ||
          now - current.settledAt <= retentionMs
        ) {
          return true;
        }
        entries.delete(key);
      }
      entries.set(key, { firstSeenAt: now });
      if (now - lastSweepAt > retentionMs) {
        lastSweepAt = now;
        for (const [candidateKey, candidate] of entries) {
          if (
            candidate.settledAt !== undefined &&
            now - candidate.settledAt > retentionMs
          ) {
            entries.delete(candidateKey);
          }
        }
      }
      return false;
    },
    release(scope, clientMessageId) {
      if (clientMessageId) entries.delete(keyFor(scope, clientMessageId));
    },
    firstSeenAt(scope, clientMessageId) {
      if (!clientMessageId) return null;
      return entries.get(keyFor(scope, clientMessageId))?.firstSeenAt ?? null;
    },
    settle(scope, clientMessageId, outcome) {
      if (!clientMessageId) return;
      const entry = entries.get(keyFor(scope, clientMessageId));
      if (!entry) return;
      entry.outcome = structuredClone(outcome);
      entry.settledAt = Date.now();
    },
    outcome(scope, clientMessageId) {
      if (!clientMessageId) return null;
      const outcome = entries.get(keyFor(scope, clientMessageId))?.outcome;
      return outcome === undefined ? null : structuredClone(outcome);
    },
    reset() {
      entries.clear();
      lastSweepAt = 0;
    },
  };
}
