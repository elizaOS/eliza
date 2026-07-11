// Exercises signup grant guard behavior with deterministic cloud-shared lib fixtures.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realDbClient from "../../db/client";
import * as realLogger from "../utils/logger";

// bun's `mock.module` patches the process-global module registry. Under the
// batched cloud-unit runner (`--isolate` occasionally fails to contain these on
// a memory-pressured runner), these db/client + logger doubles otherwise bleed
// into later suites that import the real modules, turning them red. Snapshot the
// real exports now and reinstall them in afterAll so this file's stubs are
// strictly local.
const realDbClientExports = { ...realDbClient };
const realLoggerExports = { ...realLogger };

// A minimal in-memory Postgres stand-in that models the load-bearing semantics:
//   1. `pg_advisory_xact_lock(...)` serializes transactions sharing a lock key,
//   2. the per-IP COUNT only sees grant rows from already-COMMITTED transactions.
// This lets the concurrency regression assert the cap holds under a race the old
// (count-then-insert, no lock) guard would have lost.

interface GrantRow {
  ip: string;
}

type TxResult = boolean | { granted?: boolean };

// Committed grant rows, visible to every new transaction's COUNT.
let committedGrants: GrantRow[] = [];
// When set, the COUNT(*) query returns this row shape instead of the real
// per-IP count. Lets a test inject a malformed/unreadable count to exercise the
// fail-closed guard. `null` -> a row with no `count` field at all.
let countRowOverride: { count: unknown } | null | undefined;
// Per-lock-key queue of waiters, enforcing FIFO mutual exclusion.
const lockHolders = new Map<string, Promise<void>>();
// SQL strings each tx.execute saw, for asserting the advisory lock is acquired.
let executedSql: string[] = [];

function sqlText(query: unknown): string {
  // drizzle `sql` template -> the queryChunks carry the static text; we only need
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
      if (countRowOverride !== undefined) {
        return {
          rows: (countRowOverride === null ? [{}] : [countRowOverride]) as Array<{
            count: string;
          }>,
        };
      }
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
const transaction = mock(async (fn: (tx: FakeTx) => Promise<TxResult>): Promise<TxResult> => {
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
async function runSerialized(tx: FakeTx, fn: (tx: FakeTx) => Promise<TxResult>): Promise<TxResult> {
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
    const result = await fn(tx);
    // Commit: a granted body's row becomes visible to subsequent counts.
    const granted = result === true || (typeof result === "object" && result?.granted === true);
    if (granted && tx.ip) committedGrants.push({ ip: tx.ip });
    return result;
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

const {
  runWithSignupGrantIpCap,
  runWithSignupGrantIpCapDetailed,
  resolveSignupGrantIpLimits,
  parseGrantCount,
  FREE_GRANT_IP_LIMITS,
} = await import("./signup-grant-guard");

afterAll(() => {
  mock.module("../../db/client", () => realDbClientExports);
  mock.module("../utils/logger", () => realLoggerExports);
});

const CAP = FREE_GRANT_IP_LIMITS.MAX_FREE_GRANTS_PER_IP_DAILY;

describe("resolveSignupGrantIpLimits", () => {
  test("uses safe defaults when env is unset or invalid", () => {
    expect(resolveSignupGrantIpLimits({})).toEqual({
      MAX_FREE_GRANTS_PER_IP_DAILY: 3,
      WINDOW_HOURS: 24,
    });
    expect(
      resolveSignupGrantIpLimits({
        MAX_FREE_GRANTS_PER_IP_DAILY: "0",
        FREE_GRANT_IP_WINDOW_HOURS: "nope",
      }),
    ).toEqual({
      MAX_FREE_GRANTS_PER_IP_DAILY: 3,
      WINDOW_HOURS: 24,
    });
  });

  test("accepts positive integer cap and window overrides", () => {
    expect(
      resolveSignupGrantIpLimits({
        MAX_FREE_GRANTS_PER_IP_DAILY: "12",
        FREE_GRANT_IP_WINDOW_HOURS: "6",
      }),
    ).toEqual({
      MAX_FREE_GRANTS_PER_IP_DAILY: 12,
      WINDOW_HOURS: 6,
    });
  });
});

describe("runWithSignupGrantIpCap (anti-sybil free-grant cap)", () => {
  beforeEach(() => {
    transaction.mockClear();
    committedGrants = [];
    executedSql = [];
    lockHolders.clear();
    countRowOverride = undefined;
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
  // sees the first's committed row and is denied -- only ONE grant lands. The old
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

  // Fail-closed regression: an unreadable per-IP COUNT must WITHHOLD the bonus.
  // The old `Number(count ?? 0)` produced NaN, and `NaN >= cap` === false, so a
  // corrupt/unexpected count silently GRANTED the free credits — an unbounded
  // anti-sybil faucet. Each of these malformed shapes must now deny the grant.
  const malformedCounts: Array<[string, { count: unknown } | null]> = [
    ["non-numeric string", { count: "NaN" }],
    ["empty string", { count: "" }],
    ["fractional string", { count: "1.5" }],
    ["negative string", { count: "-1" }],
    ["null count field", { count: null }],
    ["missing count field", null],
  ];

  for (const [label, override] of malformedCounts) {
    test(`withholds the grant (fail-closed) when the COUNT is unreadable: ${label}`, async () => {
      countRowOverride = override;
      let granted = false;
      const decision = await runWithSignupGrantIpCapDetailed("4.4.4.4", async () => {
        granted = true;
      });
      expect(decision.granted).toBe(false);
      expect(decision.withheldReason).toBe("count_unavailable");
      // The grant callback must never run on an unverifiable count.
      expect(granted).toBe(false);
      expect(committedGrants.filter((g) => g.ip === "4.4.4.4").length).toBe(0);
    });
  }

  test("still grants when the COUNT reads a valid below-cap integer string", async () => {
    // Force a well-formed "0" so the healthy path is exercised via the override.
    countRowOverride = { count: "0" };
    let granted = false;
    const decision = await runWithSignupGrantIpCapDetailed("6.6.6.6", async () => {
      granted = true;
    });
    expect(decision.granted).toBe(true);
    expect(granted).toBe(true);
  });
});

describe("parseGrantCount (fail-closed anti-sybil count boundary)", () => {
  test("accepts non-negative integer strings and numbers", () => {
    expect(parseGrantCount("0")).toBe(0);
    expect(parseGrantCount("3")).toBe(3);
    expect(parseGrantCount(" 42 ")).toBe(42);
    expect(parseGrantCount(0)).toBe(0);
    expect(parseGrantCount(7)).toBe(7);
    expect(parseGrantCount(5n)).toBe(5);
  });

  test("throws on any unverifiable/malformed count (never returns NaN)", () => {
    for (const bad of [
      "NaN",
      "",
      "   ",
      "1.5",
      "-1",
      "1e3",
      "0x10",
      "abc",
      null,
      undefined,
      Number.NaN,
      Infinity,
      -1,
      1.5,
      -3n,
      {},
    ]) {
      expect(() => parseGrantCount(bad)).toThrow();
    }
  });
});
