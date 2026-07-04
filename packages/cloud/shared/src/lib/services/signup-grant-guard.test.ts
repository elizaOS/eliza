// Exercises signup grant guard behavior with deterministic cloud-shared lib fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";

// A minimal in-memory Postgres stand-in that models the load-bearing semantics:
//   1. `pg_advisory_xact_lock(...)` serializes transactions sharing a lock key,
//   2. the per-IP COUNT only sees grant rows from already-COMMITTED transactions.
// This lets the concurrency regression assert the cap holds under a race the old
// (count-then-insert, no lock) guard would have lost.

interface GrantRow {
  ip: string;
}

// Committed grant rows, visible to every new transaction's COUNT.
let committedGrants: GrantRow[] = [];
// Per-lock-key queue of waiters, enforcing FIFO mutual exclusion.
const lockHolders = new Map<string, Promise<void>>();
// SQL strings each tx.execute saw, for asserting the advisory lock is acquired.
let executedSql: string[] = [];

function sqlText(query: unknown): string {
  // drizzle `sql` template → the queryChunks carry the static text; we only need
  // to recognize which statement ran, so stringify and scan.
  return JSON.stringify(query);
}

class FakeTx {
  // Grant rows staged in THIS (uncommitted) transaction.
  readonly pending: GrantRow[] = [];
  // The IP this transaction is counting/granting for, captured from the lock key.
  ip: string | undefined;

  async execute(query: unknown): Promise<{ rows: Array<{ count: string }> }> {
    const text = sqlText(query);
    executedSql.push(text);

    if (text.includes("pg_advisory_xact_lock")) {
      // The lock key is `free_grant:<ip>`; pull the ip out of the params.
      this.ip = extractIp(query, "free_grant:");
      return { rows: [] };
    }

    if (text.includes("COUNT(*)")) {
      // The guard always runs the advisory-lock statement before the COUNT, so
      // `this.ip` is set; count only COMMITTED grant rows for this IP.
      const count = committedGrants.filter((g) => g.ip === this.ip).length;
      return { rows: [{ count: String(count) }] };
    }

    return { rows: [] };
  }
}

// Pull the `free_grant:<ip>` lock key out of a drizzle `sql` template. Bound
// params sit in `queryChunks` as bare values; static SQL text is wrapped as
// `{ value: [...] }`. So a bare string param starting with the prefix is the key.
function extractIp(query: unknown, prefix: string): string | undefined {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return undefined;
  for (const chunk of chunks) {
    if (typeof chunk === "string" && chunk.startsWith(prefix)) {
      return chunk.slice(prefix.length);
    }
  }
  return undefined;
}

// Mock dbWrite.transaction with advisory-lock-aware serialization: a transaction
// whose lock key is already held waits behind the current holder; on commit its
// pending grant rows become visible and the lock is released to the next waiter.
const transaction = mock(async (fn: (tx: FakeTx) => Promise<boolean>): Promise<boolean> => {
  const tx = new FakeTx();
  // Run the body to discover the lock key (the advisory-lock execute sets tx.ip),
  // but gate the *grant + count* behind the lock by re-entering once acquired.
  // Simpler: serialize the whole body per resolved ip via a two-phase approach.
  // Phase 1: peek the ip by executing only the lock statement is impractical here,
  // so we serialize on first use of the lock inside the body via a shared mutex.
  return await runSerialized(tx, fn);
});

// Serialize transaction bodies that share a lock key. Because the ip isn't known
// until the lock statement runs inside the body, we wrap the body so the first
// `pg_advisory_xact_lock` call blocks until the prior same-ip tx has committed.
async function runSerialized(tx: FakeTx, fn: (tx: FakeTx) => Promise<boolean>): Promise<boolean> {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });

  const originalExecute = tx.execute.bind(tx);
  let acquired = false;
  tx.execute = async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes("pg_advisory_xact_lock") && !acquired) {
      acquired = true;
      const result = await originalExecute(query);
      const key = tx.ip ?? "";
      const prior = lockHolders.get(key);
      lockHolders.set(
        key,
        (async () => {
          if (prior) await prior;
          await held; // released when this tx commits
        })(),
      );
      if (prior) await prior; // block until the prior same-ip tx committed
      return result;
    }
    return originalExecute(query);
  };

  try {
    const granted = await fn(tx);
    // Commit: a granted body's row becomes visible to subsequent counts.
    if (granted && tx.ip) committedGrants.push({ ip: tx.ip });
    return granted;
  } finally {
    release(); // release the advisory lock to the next same-ip waiter
  }
}

mock.module("../../db/client", () => ({
  dbWrite: { transaction },
}));

mock.module("../utils/logger", () => ({
  logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}));

const { runWithSignupGrantIpCap, FREE_GRANT_IP_LIMITS } = await import("./signup-grant-guard");

const CAP = FREE_GRANT_IP_LIMITS.MAX_FREE_GRANTS_PER_IP_DAILY;

describe("runWithSignupGrantIpCap (anti-sybil free-grant cap)", () => {
  beforeEach(() => {
    transaction.mockClear();
    committedGrants = [];
    executedSql = [];
    lockHolders.clear();
  });

  test("falls open and runs the grant without a transaction when no IP is known", async () => {
    let granted = false;
    let receivedTx: unknown = "unset";
    const ran = await runWithSignupGrantIpCap(undefined, async (tx) => {
      granted = true;
      receivedTx = tx;
    });
    expect(ran).toBe(true);
    expect(granted).toBe(true);
    expect(receivedTx).toBeUndefined();
    expect(transaction).not.toHaveBeenCalled();
  });

  test("acquires a per-IP advisory xact lock before counting", async () => {
    await runWithSignupGrantIpCap("1.2.3.4", async () => {});
    expect(executedSql.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(true);
    // The lock statement must precede the COUNT.
    const lockIdx = executedSql.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    const countIdx = executedSql.findIndex((s) => s.includes("COUNT(*)"));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(countIdx).toBeGreaterThan(lockIdx);
  });

  test("passes the lock-holding transaction to the grant callback for known IPs", async () => {
    let receivedTx: unknown;
    await runWithSignupGrantIpCap("2.2.2.2", async (tx) => {
      receivedTx = tx;
    });
    expect(receivedTx).toBeInstanceOf(FakeTx);
  });

  test("grants below the cap and withholds once it is reached", async () => {
    // Seed CAP-1 prior committed grants for this IP.
    committedGrants = Array.from({ length: CAP - 1 }, () => ({ ip: "9.9.9.9" }));
    let grants = 0;
    expect(await runWithSignupGrantIpCap("9.9.9.9", async () => void grants++)).toBe(true);
    // Now at CAP committed; the next attempt is withheld.
    expect(await runWithSignupGrantIpCap("9.9.9.9", async () => void grants++)).toBe(false);
    expect(grants).toBe(1);
  });

  // The regression: with the cap one slot below the limit, fire TWO simultaneous
  // same-IP grant attempts. The advisory lock must serialize them so the second
  // sees the first's committed row and is denied — only ONE grant lands. The old
  // count-then-insert guard (no lock) let both read `count < cap` and both grant.
  test("two concurrent same-IP attempts cannot both pass the cap (TOCTOU)", async () => {
    // Seed CAP-1 so exactly one more grant is permitted.
    committedGrants = Array.from({ length: CAP - 1 }, () => ({ ip: "5.5.5.5" }));

    let grantsRun = 0;
    const attempt = () =>
      runWithSignupGrantIpCap("5.5.5.5", async () => {
        grantsRun++;
      });

    const [a, b] = await Promise.all([attempt(), attempt()]);

    // Exactly one of the two racers may grant; the other is withheld at the cap.
    expect([a, b].filter(Boolean).length).toBe(1);
    expect(grantsRun).toBe(1);
    expect(committedGrants.filter((g) => g.ip === "5.5.5.5").length).toBe(CAP);
  });

  test("a grant failure propagates (no swallow) and is not counted as committed", async () => {
    await expect(
      runWithSignupGrantIpCap("7.7.7.7", async () => {
        throw new Error("addCredits failed");
      }),
    ).rejects.toThrow("addCredits failed");
    expect(committedGrants.filter((g) => g.ip === "7.7.7.7").length).toBe(0);
  });
});
