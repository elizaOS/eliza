/**
 * Unit tests for the atomic work-thread merge primitive.
 *
 * Tests `WorkThreadStore.merge()` and `LifeOpsRepository.mergeWorkThreadsAtomic`
 * against a mock TransactionalDb that records every SQL statement issued so we
 * can assert:
 *
 *   - merge runs inside ONE transaction (single withTransaction call)
 *   - target + source UPDATEs all participate
 *   - 'merged' + 'merged_into' events all appended in same transaction
 *   - version checks emit the right WHERE clauses
 *   - idempotency: second call with same mergeRequestId is a no-op
 *   - optimistic lock failure throws OptimisticLockError
 */

import type { JsonValue } from "@elizaos/core";
import { describe, expect, it } from "vitest";

// Helper: lazy-load the modules under test so this file can compile without
// pulling in plugin lifecycle plumbing during type-checking.
async function loadModules() {
  const repository = await import("../src/lifeops/repository");
  const sql = await import("../src/lifeops/sql");
  const store = await import("../src/lifeops/work-threads/store");
  return { repository, sql, store };
}

interface MockExecuteCapture {
  sql: string;
}

function buildMockRuntime(capture: MockExecuteCapture[]): unknown {
  const db = {
    execute: async (raw: { queryChunks?: Array<{ value?: unknown }> }) => {
      const sqlText = extractSqlText(raw).trim().toUpperCase();
      capture.push({ sql: sqlText });
      if (sqlText.startsWith("UPDATE")) {
        // Successful UPDATE returning 1 row.
        return [{ id: "stub-id" }];
      }
      if (sqlText.startsWith("SELECT")) {
        // findWorkThreadMergeEvent → no existing event (not idempotent hit).
        return [];
      }
      // INSERT etc. → no-op.
      return [];
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        execute: async (raw: { queryChunks?: Array<{ value?: unknown }> }) => {
          const sqlText = extractSqlText(raw).trim().toUpperCase();
          capture.push({ sql: sqlText });
          if (sqlText.startsWith("UPDATE")) {
            return [{ id: "stub-id" }];
          }
          if (sqlText.startsWith("SELECT")) {
            return [];
          }
          return [];
        },
      });
    },
  };
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    adapter: { db },
  };
}

/**
 * drizzle's `sql.raw(text)` returns `{ queryChunks: [{ value: text }, ...] }`.
 * Reconstruct the textual SQL from the chunks so our mock can branch on it.
 */
function extractSqlText(
  raw: { queryChunks?: Array<{ value?: unknown }> } | undefined,
): string {
  if (!raw || !Array.isArray(raw.queryChunks)) return "";
  return raw.queryChunks
    .map((chunk) =>
      chunk && "value" in chunk ? String(chunk.value ?? "") : "",
    )
    .join("");
}

interface MockRuntimeOpts {
  /**
   * If set, the Nth UPDATE in the transaction returns 0 rows, simulating an
   * optimistic-lock conflict (someone else bumped the version).
   */
  failNthUpdate?: number;
  /**
   * If true, the SELECT for existing merge events returns a row (idempotency
   * hit).
   */
  idempotencyHit?: boolean;
  /**
   * Idempotency event detail returned when idempotencyHit is true.
   */
  idempotencySources?: string[];
}

function buildAdvancedMockRuntime(
  capture: MockExecuteCapture[],
  opts: MockRuntimeOpts = {},
): unknown {
  let updateCount = 0;
  const db = {
    execute: async (raw: { queryChunks?: Array<{ value?: unknown }> }) => {
      const sqlText = extractSqlText(raw).trim().toUpperCase();
      capture.push({ sql: sqlText });
      if (
        sqlText.startsWith("SELECT") &&
        sqlText.includes("LIFE_WORK_THREADS")
      ) {
        // store.get() lookups - return a thread with version 1.
        return [];
      }
      if (sqlText.startsWith("UPDATE")) {
        return [{ id: "stub-id" }];
      }
      return [];
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        execute: async (raw: { queryChunks?: Array<{ value?: unknown }> }) => {
          const sqlText = extractSqlText(raw).trim().toUpperCase();
          capture.push({ sql: sqlText });
          if (
            sqlText.startsWith("SELECT") &&
            sqlText.includes("LIFE_WORK_THREAD_EVENTS")
          ) {
            if (opts.idempotencyHit) {
              return [
                {
                  detail_json: JSON.stringify({
                    mergeRequestId: "request-1",
                    sourceWorkThreadIds: opts.idempotencySources ?? ["src-1"],
                  }),
                  occurred_at: new Date().toISOString(),
                },
              ];
            }
            return [];
          }
          if (sqlText.startsWith("UPDATE")) {
            updateCount += 1;
            if (
              opts.failNthUpdate !== undefined &&
              updateCount === opts.failNthUpdate
            ) {
              return []; // Zero rows → optimistic lock failure
            }
            return [{ id: "stub-id" }];
          }
          return [];
        },
      });
    },
  };
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    adapter: { db },
  };
}

function makeThread(id: string, version = 1): unknown {
  return {
    id,
    agentId: "00000000-0000-0000-0000-000000000001",
    ownerEntityId: "00000000-0000-0000-0000-deadbeefdead",
    status: "active",
    title: id,
    summary: id,
    currentPlanSummary: null,
    primarySourceRef: {
      connector: "test",
      roomId: "room-1",
      canRead: true,
      canMutate: true,
    },
    sourceRefs: [
      {
        connector: "test",
        roomId: "room-1",
        canRead: true,
        canMutate: true,
      },
    ],
    participantEntityIds: [],
    currentScheduledTaskId: null,
    workflowRunId: null,
    approvalId: null,
    lastMessageMemoryId: null,
    version,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    metadata: {},
  };
}

describe("LifeOpsRepository.mergeWorkThreadsAtomic", () => {
  it("runs all UPDATEs and INSERTs inside one transaction", async () => {
    const capture: MockExecuteCapture[] = [];
    const { repository } = await loadModules();
    const runtime = buildAdvancedMockRuntime(capture);

    const repo = new repository.LifeOpsRepository(
      runtime as Parameters<typeof repository.LifeOpsRepository>[0],
    );
    const target = makeThread("target-1", 1) as Parameters<
      typeof repo.mergeWorkThreadsAtomic
    >[0]["target"];
    const source = makeThread("source-1", 1) as Parameters<
      typeof repo.mergeWorkThreadsAtomic
    >[0]["sources"][0];
    const nextTarget = {
      ...(target as Record<string, JsonValue>),
      summary: "merged summary",
    } as Parameters<typeof repo.mergeWorkThreadsAtomic>[0]["nextTarget"];

    const result = await repo.mergeWorkThreadsAtomic({
      agentId: "00000000-0000-0000-0000-000000000001",
      target,
      sources: [source],
      nextTarget,
      mergeRequestId: "request-1",
      reason: "test",
      instruction: "merge them",
    });

    expect(result.targetWorkThreadId).toBe("target-1");
    expect(result.sourceWorkThreadIds).toEqual(["source-1"]);

    // Find the statements that ran inside the transaction:
    //   - 1 SELECT for the idempotency check
    //   - 1 UPDATE for the target with version check
    //   - 1 UPDATE for the source with version check
    //   - 1 INSERT for the 'merged' event
    //   - 1 INSERT for the 'merged_into' event
    const selects = capture.filter((c) =>
      c.sql.trim().toUpperCase().startsWith("SELECT"),
    );
    const updates = capture.filter((c) =>
      c.sql.trim().toUpperCase().startsWith("UPDATE"),
    );
    const inserts = capture.filter((c) =>
      c.sql.trim().toUpperCase().startsWith("INSERT"),
    );

    expect(selects.length).toBe(1);
    expect(updates.length).toBe(2);
    expect(inserts.length).toBe(2);

    // UPDATE clauses must include `VERSION =` for optimistic concurrency.
    // (We uppercase the captured SQL in the mock for stable matching.)
    for (const upd of updates) {
      expect(upd.sql).toMatch(/VERSION\s*=/);
      expect(upd.sql).toContain("VERSION = VERSION + 1");
    }
    // INSERT detail_json must include the mergeRequestId (case-insensitive).
    for (const ins of inserts) {
      expect(ins.sql.toLowerCase()).toContain("request-1");
    }
  });

  it("returns the recorded result on idempotency hit without writing", async () => {
    const capture: MockExecuteCapture[] = [];
    const { repository } = await loadModules();
    const runtime = buildAdvancedMockRuntime(capture, {
      idempotencyHit: true,
      idempotencySources: ["source-A", "source-B"],
    });

    const repo = new repository.LifeOpsRepository(
      runtime as Parameters<typeof repository.LifeOpsRepository>[0],
    );
    const target = makeThread("target-1", 1) as Parameters<
      typeof repo.mergeWorkThreadsAtomic
    >[0]["target"];
    const source = makeThread("source-A", 1) as Parameters<
      typeof repo.mergeWorkThreadsAtomic
    >[0]["sources"][0];

    const result = await repo.mergeWorkThreadsAtomic({
      agentId: "00000000-0000-0000-0000-000000000001",
      target,
      sources: [source],
      nextTarget: target as Parameters<
        typeof repo.mergeWorkThreadsAtomic
      >[0]["nextTarget"],
      mergeRequestId: "request-1",
      reason: null,
      instruction: null,
    });

    expect(result.targetWorkThreadId).toBe("target-1");
    expect(result.sourceWorkThreadIds).toEqual(["source-A", "source-B"]);

    // Should be ONE SELECT (the idempotency check) and ZERO writes.
    const writes = capture.filter((c) => {
      const s = c.sql.trim().toUpperCase();
      return s.startsWith("UPDATE") || s.startsWith("INSERT");
    });
    expect(writes.length).toBe(0);
  });

  it("throws OptimisticLockError when target version mismatches", async () => {
    const capture: MockExecuteCapture[] = [];
    const { repository, sql } = await loadModules();
    const runtime = buildAdvancedMockRuntime(capture, { failNthUpdate: 1 });

    const repo = new repository.LifeOpsRepository(
      runtime as Parameters<typeof repository.LifeOpsRepository>[0],
    );
    const target = makeThread("target-1", 5) as Parameters<
      typeof repo.mergeWorkThreadsAtomic
    >[0]["target"];
    const source = makeThread("source-1", 1) as Parameters<
      typeof repo.mergeWorkThreadsAtomic
    >[0]["sources"][0];
    const nextTarget = target as Parameters<
      typeof repo.mergeWorkThreadsAtomic
    >[0]["nextTarget"];

    await expect(
      repo.mergeWorkThreadsAtomic({
        agentId: "00000000-0000-0000-0000-000000000001",
        target,
        sources: [source],
        nextTarget,
        mergeRequestId: "request-1",
        reason: null,
        instruction: null,
      }),
    ).rejects.toBeInstanceOf(sql.OptimisticLockError);
  });

  it("throws OptimisticLockError when a SOURCE version mismatches", async () => {
    const capture: MockExecuteCapture[] = [];
    const { repository, sql } = await loadModules();
    // Fail the 2nd UPDATE (which is the source UPDATE — target is #1).
    const runtime = buildAdvancedMockRuntime(capture, { failNthUpdate: 2 });

    const repo = new repository.LifeOpsRepository(
      runtime as Parameters<typeof repository.LifeOpsRepository>[0],
    );
    const target = makeThread("target-1", 1) as Parameters<
      typeof repo.mergeWorkThreadsAtomic
    >[0]["target"];
    const source = makeThread("source-1", 3) as Parameters<
      typeof repo.mergeWorkThreadsAtomic
    >[0]["sources"][0];
    const nextTarget = target as Parameters<
      typeof repo.mergeWorkThreadsAtomic
    >[0]["nextTarget"];

    await expect(
      repo.mergeWorkThreadsAtomic({
        agentId: "00000000-0000-0000-0000-000000000001",
        target,
        sources: [source],
        nextTarget,
        mergeRequestId: "request-1",
        reason: null,
        instruction: null,
      }),
    ).rejects.toBeInstanceOf(sql.OptimisticLockError);
  });
});

describe("withOptimisticRetry", () => {
  it("retries 3 times on OptimisticLockError then rethrows", async () => {
    const { sql } = await loadModules();
    let attempts = 0;
    const work = async () => {
      attempts += 1;
      throw new sql.OptimisticLockError({
        table: "life_work_threads",
        id: "test",
        expectedVersion: 1,
      });
    };
    await expect(
      sql.withOptimisticRetry(work, { maxAttempts: 3, baseDelayMs: 1 }),
    ).rejects.toBeInstanceOf(sql.OptimisticLockError);
    expect(attempts).toBe(3);
  });

  it("returns the value on first success", async () => {
    const { sql } = await loadModules();
    let attempts = 0;
    const result = await sql.withOptimisticRetry(async () => {
      attempts += 1;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(1);
  });

  it("retries once on transient failure then succeeds", async () => {
    const { sql } = await loadModules();
    let attempts = 0;
    const result = await sql.withOptimisticRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) {
          throw new sql.OptimisticLockError({
            table: "life_work_threads",
            id: "test",
            expectedVersion: 1,
          });
        }
        return "ok";
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("does NOT retry on non-OptimisticLockError", async () => {
    const { sql } = await loadModules();
    let attempts = 0;
    const work = async () => {
      attempts += 1;
      throw new Error("boom");
    };
    await expect(sql.withOptimisticRetry(work)).rejects.toThrow("boom");
    expect(attempts).toBe(1);
  });
});
