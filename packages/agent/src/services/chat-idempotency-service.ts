/**
 * Owns bounded idempotency reservations and replayable outcomes for chat turns.
 * Route adapters choose the conversation scope and durable outcome shape while
 * this service enforces active-turn ownership and settled-result retention.
 */
import { ElizaError } from "@elizaos/core";

export interface ChatIdempotencyReservation {
  readonly scope: string;
  readonly clientMessageId: string;
  readonly token: symbol;
}

export class ChatIdempotencyConflictError extends ElizaError {
  constructor(scope: string, clientMessageId: string) {
    super("Idempotency key was reused for a different chat request", {
      code: "CHAT_IDEMPOTENCY_CONFLICT",
      context: { scope, clientMessageId },
    });
  }
}

export type ChatIdempotencyWaitResult<Outcome> =
  | { kind: "settled"; outcome: Outcome }
  | { kind: "released" };

export type ChatIdempotencyAdmission<Outcome> =
  | { kind: "unkeyed" }
  | { kind: "owner"; reservation: ChatIdempotencyReservation }
  | { kind: "settled"; outcome: Outcome }
  | { kind: "conflict"; error: ChatIdempotencyConflictError }
  | {
      kind: "duplicate";
      wait(signal?: AbortSignal): Promise<ChatIdempotencyWaitResult<Outcome>>;
    };

export class ChatIdempotencyWaitAbortedError extends Error {
  constructor(options?: ErrorOptions) {
    super("Chat idempotency wait was aborted", options);
    this.name = "ChatIdempotencyWaitAbortedError";
  }
}

export interface ChatIdempotencyStore<Outcome> {
  normalize(value: unknown): string | null;
  admit(
    scope: string,
    clientMessageId: string | null,
    options?: { fingerprint?: string; now?: number },
  ): ChatIdempotencyAdmission<Outcome>;
  reserve(scope: string, clientMessageId: string | null, now?: number): boolean;
  release(
    scope: string,
    clientMessageId: string | null,
    reservation?: ChatIdempotencyReservation | null,
  ): void;
  firstSeenAt(scope: string, clientMessageId: string | null): number | null;
  settle(
    scope: string,
    clientMessageId: string | null,
    outcome: Outcome,
    reservation?: ChatIdempotencyReservation | null,
  ): void;
  outcome(scope: string, clientMessageId: string | null): Outcome | null;
  reset(): void;
  readonly retentionMs: number;
}

interface Entry<Outcome> {
  firstSeenAt: number;
  token: symbol;
  legacyOwner: boolean;
  status: "active" | "settled" | "released";
  settledAt?: number;
  outcome?: Outcome;
  waiters: Set<(result: ChatIdempotencyWaitResult<Outcome>) => void>;
  fingerprint?: string;
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

  const cloneOutcome = (outcome: Outcome): Outcome => structuredClone(outcome);

  const notifyWaiters = (
    entry: Entry<Outcome>,
    result: ChatIdempotencyWaitResult<Outcome>,
  ) => {
    for (const waiter of entry.waiters) {
      waiter(
        result.kind === "settled"
          ? { kind: "settled", outcome: cloneOutcome(result.outcome) }
          : result,
      );
    }
    entry.waiters.clear();
  };

  const createEntry = (
    firstSeenAt: number,
    legacyOwner = false,
    fingerprint?: string,
  ): Entry<Outcome> => ({
    firstSeenAt,
    token: Symbol("chat-idempotency-owner"),
    legacyOwner,
    status: "active",
    waiters: new Set(),
    fingerprint,
  });

  const ownsEntry = (
    scope: string,
    clientMessageId: string,
    entry: Entry<Outcome>,
    reservation: ChatIdempotencyReservation | null | undefined,
  ): boolean =>
    (reservation === undefined && entry.legacyOwner) ||
    (reservation !== undefined &&
      reservation !== null &&
      reservation.scope === scope &&
      reservation.clientMessageId === clientMessageId &&
      reservation.token === entry.token);

  const admit = (
    scope: string,
    clientMessageId: string | null,
    options: { fingerprint?: string; now?: number } = {},
  ): ChatIdempotencyAdmission<Outcome> => {
    const now = options.now ?? Date.now();
    if (!clientMessageId) return { kind: "unkeyed" };
    const key = keyFor(scope, clientMessageId);
    const current = entries.get(key);
    if (current) {
      // Retire a settled entry that has outlived the retention window BEFORE
      // comparing fingerprints. Past `retentionMs` the reservation no longer
      // exists as far as this contract is concerned, so a client reusing the
      // same `clientMessageId` for genuinely new content is a fresh request.
      // Comparing fingerprints first pinned the key to its original content
      // permanently — the caller got CHAT_IDEMPOTENCY_CONFLICT forever, and
      // the route layer hands that value straight to the client as an SSE
      // error. It also returned before the opportunistic sweep below, so the
      // dead entry was never collected either. `reserve()` already retires the
      // expired entry first; this makes `admit()` agree with it.
      const settledAndExpired =
        current.status === "settled" &&
        current.settledAt !== undefined &&
        now - current.settledAt > retentionMs;
      if (settledAndExpired) {
        entries.delete(key);
      } else if (
        current.fingerprint !== undefined &&
        options.fingerprint !== current.fingerprint
      ) {
        return {
          kind: "conflict",
          error: new ChatIdempotencyConflictError(scope, clientMessageId),
        };
      } else if (
        current.status === "settled" &&
        current.outcome !== undefined
      ) {
        return { kind: "settled", outcome: cloneOutcome(current.outcome) };
      } else if (current.status === "active") {
        return {
          kind: "duplicate",
          wait(signal) {
            if (signal?.aborted) {
              return Promise.reject(
                new ChatIdempotencyWaitAbortedError({ cause: signal.reason }),
              );
            }
            if (current.status === "released") {
              return Promise.resolve({ kind: "released" });
            }
            if (current.status === "settled" && current.outcome !== undefined) {
              return Promise.resolve({
                kind: "settled",
                outcome: cloneOutcome(current.outcome),
              });
            }
            return new Promise<ChatIdempotencyWaitResult<Outcome>>(
              (resolve, reject) => {
                let onAbort: (() => void) | undefined;
                const finish = (result: ChatIdempotencyWaitResult<Outcome>) => {
                  if (onAbort) signal?.removeEventListener("abort", onAbort);
                  resolve(result);
                };
                current.waiters.add(finish);
                if (signal) {
                  onAbort = () => {
                    current.waiters.delete(finish);
                    reject(
                      new ChatIdempotencyWaitAbortedError({
                        cause: signal.reason,
                      }),
                    );
                  };
                  signal.addEventListener("abort", onAbort, { once: true });
                }
              },
            );
          },
        };
      }
    }

    const entry = createEntry(now, false, options.fingerprint);
    entries.set(key, entry);
    if (now - lastSweepAt > retentionMs) {
      lastSweepAt = now;
      for (const [candidateKey, candidate] of entries) {
        if (
          candidate.status === "settled" &&
          candidate.settledAt !== undefined &&
          now - candidate.settledAt > retentionMs
        ) {
          entries.delete(candidateKey);
        }
      }
    }
    return {
      kind: "owner",
      reservation: {
        scope,
        clientMessageId,
        token: entry.token,
      },
    };
  };

  return {
    retentionMs,
    normalize(value) {
      if (typeof value !== "string") return null;
      const normalized = value.trim();
      return normalized.length > 0 && normalized.length <= maxKeyLength
        ? normalized
        : null;
    },
    admit,
    reserve(scope, clientMessageId, now = Date.now()) {
      if (!clientMessageId) return false;
      const key = keyFor(scope, clientMessageId);
      const current = entries.get(key);
      if (current) {
        if (
          current.status !== "settled" ||
          current.settledAt === undefined ||
          now - current.settledAt <= retentionMs
        ) {
          return true;
        }
        entries.delete(key);
      }
      entries.set(key, createEntry(now, true));
      if (now - lastSweepAt > retentionMs) {
        lastSweepAt = now;
        for (const [candidateKey, candidate] of entries) {
          if (
            candidate.status === "settled" &&
            candidate.settledAt !== undefined &&
            now - candidate.settledAt > retentionMs
          ) {
            entries.delete(candidateKey);
          }
        }
      }
      return false;
    },
    release(scope, clientMessageId, reservation) {
      if (!clientMessageId) return;
      const key = keyFor(scope, clientMessageId);
      const entry = entries.get(key);
      if (entry?.status !== "active") return;
      if (!ownsEntry(scope, clientMessageId, entry, reservation)) return;
      entries.delete(key);
      entry.status = "released";
      notifyWaiters(entry, { kind: "released" });
    },
    firstSeenAt(scope, clientMessageId) {
      if (!clientMessageId) return null;
      return entries.get(keyFor(scope, clientMessageId))?.firstSeenAt ?? null;
    },
    settle(scope, clientMessageId, outcome, reservation) {
      if (!clientMessageId) return;
      const entry = entries.get(keyFor(scope, clientMessageId));
      if (entry?.status !== "active") return;
      if (!ownsEntry(scope, clientMessageId, entry, reservation)) return;
      entry.outcome = cloneOutcome(outcome);
      entry.settledAt = Date.now();
      entry.status = "settled";
      notifyWaiters(entry, { kind: "settled", outcome });
    },
    outcome(scope, clientMessageId) {
      if (!clientMessageId) return null;
      const outcome = entries.get(keyFor(scope, clientMessageId))?.outcome;
      return outcome === undefined ? null : cloneOutcome(outcome);
    },
    reset() {
      for (const entry of entries.values()) {
        entry.status = "released";
        notifyWaiters(entry, { kind: "released" });
      }
      entries.clear();
      lastSweepAt = 0;
    },
  };
}
