/**
 * Verifies BaseDrizzleAdapter's atomic cache compare-and-set against a real
 * isolated PGlite instance: insert-only-if-absent, replace-if-equal with jsonb
 * equality (order-insensitive keys, collapsed numeric scale), conflict `false`
 * for both value-mismatch and absent-row-while-expected, and racing writers
 * converging to exactly one winner per round (the cross-process lost-update
 * cure this primitive exists for — simulated here by concurrent statements on
 * one backend, which the row-level conditional UPDATE serializes).
 */

import { CACHE_CAS_FAILED_CODE, ElizaError, isElizaError, type UUID } from "@elizaos/core";
import { v4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import { PgDatabaseAdapter as PgAdapterCtor } from "../../pg/adapter";
import type { PostgresConnectionManager } from "../../pg/manager";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { PgliteDatabaseAdapter as PgliteAdapterCtor } from "../../pglite/adapter";
import type { PGliteClientManager } from "../../pglite/manager";
import { agentTable, cacheTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("Cache compare-and-set (real PGlite)", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let sharedManager: PGliteClientManager | undefined;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("cache-cas-tests", [], {
      exposeManager: true,
    });
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
    sharedManager = setup.manager;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  beforeEach(async () => {
    await (adapter.getDatabase() as DrizzleDatabase).delete(cacheTable);
  });

  it("inserts when expected is undefined and the key is absent", async () => {
    await expect(adapter.compareAndSetCache("cas-key", undefined, { v: 1 })).resolves.toBe(true);
    await expect(adapter.getCache("cas-key")).resolves.toEqual({ v: 1 });
  });

  it("returns false on the insert branch when the key already exists", async () => {
    await adapter.setCache("cas-key", "original");
    await expect(adapter.compareAndSetCache("cas-key", undefined, "replacement")).resolves.toBe(
      false
    );
    await expect(adapter.getCache("cas-key")).resolves.toBe("original");
  });

  it("replaces when expected deep-equals the stored value (jsonb equality)", async () => {
    await adapter.setCache("cas-key", { a: [1, 2], b: "x" });
    await expect(
      // reversed key order and 2.0-vs-2 must still compare equal as jsonb
      adapter.compareAndSetCache("cas-key", { b: "x", a: [1, 2.0] }, "next")
    ).resolves.toBe(true);
    await expect(adapter.getCache("cas-key")).resolves.toBe("next");
  });

  it("returns false when the stored value differs", async () => {
    await adapter.setCache("cas-key", { a: 1 });
    await expect(adapter.compareAndSetCache("cas-key", { a: 2 }, "next")).resolves.toBe(false);
    await expect(adapter.getCache("cas-key")).resolves.toEqual({ a: 1 });
  });

  it("returns false when expected is supplied but the row is absent", async () => {
    await expect(adapter.compareAndSetCache("never-written", { a: 1 }, "next")).resolves.toBe(
      false
    );
    await expect(adapter.getCache("never-written")).resolves.toBeUndefined();
  });

  it("keeps createdAt untouched on a replace (setCache parity)", async () => {
    await adapter.setCache("cas-key", "v1");
    const before = await (adapter.getDatabase() as DrizzleDatabase).select().from(cacheTable);
    await adapter.compareAndSetCache("cas-key", "v1", "v2");
    const after = await (adapter.getDatabase() as DrizzleDatabase).select().from(cacheTable);
    expect(after[0]?.createdAt).toEqual(before[0]?.createdAt);
  });

  it.skipIf(Boolean(process.env.POSTGRES_URL))(
    "isolates agents on the replace branch: a CAS naming another agent's value cannot touch that row (composite PK scoping)",
    async () => {
      // Skipped under POSTGRES_URL: the pg PostgresConnectionManager pools
      // per-URL, and a second adapter against the same live server would need
      // the same schema/search-path dance the helper performs, mutating shared
      // state. This regression is only meaningful on the shared-connection
      // PGlite path, where two adapters legitimately front one database
      // process (the tenant model in issue #28875).
      if (!sharedManager) {
        throw new Error("exposeManager option did not yield a manager on the PGlite path");
      }
      const otherAgentId = v4() as UUID;
      // Create the second agent row first: cache.agent_id FK-references
      // agents.id, so agent B must exist before it can own cache rows.
      await (adapter.getDatabase() as DrizzleDatabase).insert(agentTable).values({
        id: otherAgentId,
        name: "cross-agent-cas-b",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const adapterB = new PgliteAdapterCtor(otherAgentId, sharedManager);
      try {
        // Seed the same key independently for both agents.
        await adapter.setCache("shared-key", "agent-a-value");
        await adapterB.setCache("shared-key", "agent-b-value");

        // Agent A CASes naming agent B's stored value as `expected` — the value
        // matches a row in the table, but that row belongs to another agent.
        // Under the tenant contract it must resolve false and change nothing.
        await expect(
          adapter.compareAndSetCache("shared-key", "agent-b-value", "hijacked")
        ).resolves.toBe(false);
        // Agent B's row is untouched; agent A's row is untouched too.
        await expect(adapterB.getCache("shared-key")).resolves.toBe("agent-b-value");
        await expect(adapter.getCache("shared-key")).resolves.toBe("agent-a-value");

        // A legitimate same-agent replace still succeeds after the refusal.
        await expect(
          adapter.compareAndSetCache("shared-key", "agent-a-value", "agent-a-next")
        ).resolves.toBe(true);
        await expect(adapterB.getCache("shared-key")).resolves.toBe("agent-b-value");
      } finally {
        // adapterB shares the manager's connection and lifecycle; closing it
        // would close the shared PGlite instance for every later test. The
        // suite's afterAll cleanup owns manager teardown — here only the rows
        // this test created need to go.
        await (adapter.getDatabase() as DrizzleDatabase).delete(cacheTable);
      }
    }
  );

  it.skipIf(Boolean(process.env.POSTGRES_URL))(
    "isolates agents on the insert branch: a present other-agent row does not block this agent's insert-only CAS",
    async () => {
      // Skipped under POSTGRES_URL for the same shared-state reason as the
      // replace-branch twin above.
      if (!sharedManager) {
        throw new Error("exposeManager option did not yield a manager on the PGlite path");
      }
      const otherAgentId = v4() as UUID;
      await (adapter.getDatabase() as DrizzleDatabase).insert(agentTable).values({
        id: otherAgentId,
        name: "cross-agent-cas-insert-b",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const adapterB = new PgliteAdapterCtor(otherAgentId, sharedManager);
      try {
        await adapter.setCache("tenant-key", { owner: "a" });
        // The composite PK is (key, agentId): agent B's insert-only CAS on the
        // same key must succeed — agent A's row is not a conflict for B.
        await expect(
          adapterB.compareAndSetCache("tenant-key", undefined, { owner: "b" })
        ).resolves.toBe(true);
        await expect(adapterB.getCache("tenant-key")).resolves.toEqual({
          owner: "b",
        });
        await expect(adapter.getCache("tenant-key")).resolves.toEqual({
          owner: "a",
        });
      } finally {
        // Shared manager: no adapter-level close here (see note above).
        await (adapter.getDatabase() as DrizzleDatabase).delete(cacheTable);
      }
    }
  );

  it("exactly one of N racing insert-only CASes wins", async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => adapter.compareAndSetCache("race-insert", undefined, i))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = await adapter.getCache("race-insert");
    expect(typeof winner).toBe("number");
  });

  it("exactly one of N racing replace CASes wins; losers see the new value", async () => {
    await adapter.setCache("race-replace", 0);
    const results = await Promise.all(
      Array.from({ length: 16 }, () => adapter.compareAndSetCache("race-replace", 0, 1))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(adapter.getCache("race-replace")).resolves.toBe(1);
  });

  it("sequential CAS chains advance: v0→v1→v2 each conditioned on the prior", async () => {
    await expect(adapter.compareAndSetCache("chain", undefined, "v0")).resolves.toBe(true);
    await expect(adapter.compareAndSetCache("chain", "v0", "v1")).resolves.toBe(true);
    await expect(adapter.compareAndSetCache("chain", "v1", "v2")).resolves.toBe(true);
    // stale expected now conflicts
    await expect(adapter.compareAndSetCache("chain", "v0", "v3")).resolves.toBe(false);
    await expect(adapter.getCache("chain")).resolves.toBe("v2");
  });

  describe("storage failure surfacing (real PGlite)", () => {
    it("throws the typed CAS error (not false) when the statement fails", async () => {
      // Break the drizzle handle: a failed statement is a storage failure and
      // must surface as the typed error, never as a conflict `false`. This is
      // the path the M5 fail-open mutant opens (catch -> return false).
      const internal = adapter as unknown as { db: DrizzleDatabase };
      const originalDb = internal.db;
      const boom: DrizzleDatabase = new Proxy(originalDb, {
        get(target, prop, receiver) {
          if (prop === "insert" || prop === "update") {
            return () => {
              throw new Error("statement failed");
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      internal.db = boom;
      try {
        const insertPromise = adapter.compareAndSetCache("failing", undefined, {
          v: 1,
        });
        await expect(insertPromise).rejects.toBeInstanceOf(ElizaError);
        await expect(insertPromise).rejects.toMatchObject({
          code: CACHE_CAS_FAILED_CODE,
          context: { table: "cache", key: "failing" },
        });
      } finally {
        internal.db = originalDb;
      }
    });

    it("a healthy CAS still works after a statement failure (no poison)", async () => {
      const internal = adapter as unknown as { db: DrizzleDatabase };
      const originalDb = internal.db;
      const proxyDb: DrizzleDatabase = new Proxy(originalDb, {
        get(target, prop, receiver) {
          if (prop === "insert" || prop === "update") {
            return () => {
              throw new Error("statement failed");
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      internal.db = proxyDb;
      await expect(
        adapter.compareAndSetCache("failing", undefined, { v: 1 })
      ).rejects.toMatchObject({
        code: CACHE_CAS_FAILED_CODE,
      });
      internal.db = originalDb;
      await expect(adapter.compareAndSetCache("healthy", undefined, { v: 2 })).resolves.toBe(true);
      await expect(adapter.getCache("healthy")).resolves.toEqual({ v: 2 });
    });
  });

  /**
   * Committed-write / lost-response fault injection through the REAL Pg
   * retry facade (#29438 review follow-up).
   *
   * `PgDatabaseAdapter.withDatabase` wraps every operation in
   * `withRetry` (3 attempts). A CAS statement that commits on the server but
   * whose response is lost in flight surfaces as `CACHE_CAS_FAILED` with an
   * UNCERTAIN outcome. If the retry facade replayed it, the replay would
   * re-evaluate the conditional UPDATE's WHERE against the committed
   * replacement and resolve `false` — corrupting the documented
   * conflict-only meaning of the CAS boolean for a write that actually
   * succeeded. These tests prove: exactly one attempt, a typed failure, and
   * the persisted state readback showing the committed replacement.
   *
   * The fault is injected at the drizzle boundary with a one-shot proxy:
   * attempt 1 executes the real statement (it commits), then the response is
   * discarded and an exception is thrown; any later attempt would run clean.
   * The PGlite backend is real — the commit is real.
   */
  describe("retry-facade fault injection (real Pg withDatabase → withRetry)", () => {
    let pgAdapter: InstanceType<typeof PgDatabaseAdapter>;
    let pgManager: PostgresConnectionManager;

    beforeEach(async () => {
      if (!sharedManager) {
        throw new Error("exposeManager option did not yield a manager on the PGlite path");
      }
      // Reuse the suite's real PGlite backend, but front it with the Pg
      // adapter's withDatabase facade (the retrying one) instead of the
      // PGlite adapter's pass-through, so the retry policy is actually in
      // the path under test.
      const raw = (adapter as unknown as { getRawConnection?: () => unknown }).getRawConnection?.();
      if (!raw) throw new Error("PGlite adapter did not expose a raw connection");
      // The Pg adapter needs a NodePgDatabase; PGlite's drizzle handle is
      // API-compatible for this statement shape.
      pgManager = {
        getDatabase: () => (adapter as unknown as { db: DrizzleDatabase }).db,
      } as unknown as PostgresConnectionManager;
      pgAdapter = new PgAdapterCtor(testAgentId, pgManager);
    });

    it("committed-write/lost-response: one attempt, typed failure, persisted replacement", async () => {
      await adapter.setCache("lost-response", "expected-value");

      const internal = pgAdapter as unknown as { db: DrizzleDatabase };
      const originalDb = internal.db;
      let lostResponseFaultArmed = true;
      let statementAttempts = 0;
      // Delegate the drizzle builder chain (`update().set().where().returning()`)
      // to the REAL handle so the statement genuinely executes and commits.
      // Drizzle builders are themselves thenable (QueryPromise), so the fault
      // must attach ONLY at the explicit terminal `.returning()` call — on the
      // first attempt the resolved rows are discarded and a lost-response
      // error is thrown after the real commit. A later attempt would run
      // clean: exactly the replay a retry facade must NOT perform for an
      // uncertain CAS mutation.
      const faulting = (node: object): object =>
        new Proxy(node, {
          get(target, prop) {
            if (prop === "returning") {
              return (...args: unknown[]) => {
                statementAttempts += 1;
                const real = Reflect.get(target, prop, target) as (...a: unknown[]) => unknown;
                const out = real.apply(target, args) as Promise<unknown>;
                if (lostResponseFaultArmed) {
                  lostResponseFaultArmed = false;
                  return out.then(() => {
                    throw new Error("response lost in flight");
                  });
                }
                return out;
              };
            }
            const value = Reflect.get(target, prop, target) as unknown;
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              const out = (value as (...a: unknown[]) => unknown).apply(target, args);
              if (out && typeof out === "object") return faulting(out);
              return out;
            };
          },
        });
      internal.db = faulting(originalDb) as DrizzleDatabase;
      let caught: unknown;
      try {
        await pgAdapter.compareAndSetCache(
          "lost-response",
          "expected-value",
          "committed-replacement"
        );
      } catch (error) {
        caught = error;
      } finally {
        internal.db = originalDb;
      }
      // A typed CAS failure, not a conflict `false` for a write that landed.
      expect(caught, "expected CACHE_CAS_FAILED, got a normal return").toBeDefined();
      expect(isElizaError(caught), `expected ElizaError, got ${String(caught)}`).toBe(true);
      expect((caught as ElizaError).code).toBe(CACHE_CAS_FAILED_CODE);
      expect((caught as ElizaError).cause).toBeDefined();
      // Exactly ONE statement execution — the retry facade must not replay
      // the uncertain mutation.
      expect(statementAttempts).toBe(1);
      // Persisted-state readback on the REAL backend: the write committed.
      await expect(adapter.getCache("lost-response")).resolves.toBe("committed-replacement");
    });
  });
});
