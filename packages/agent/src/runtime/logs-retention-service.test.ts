/**
 * Unit tests for bounded LOGS-table retention.
 *
 * Mirrors the memory-retention test matrix (#16714), re-scoped to the `logs`
 * table + its own adapter surface:
 *   1. Config parsing under the INDEPENDENT `ELIZA_LOGS_RETENTION_*` prefix
 *      (OFF-by-default, positive parse, blank/non-numeric/non-positive => unset).
 *   2. The service ({@link LogsRetentionService}) against an in-memory fake
 *      adapter: synthetic 500-row growth then prune keeps the bound with the
 *      newest surviving; age prune; the global per-sweep delete budget clamps;
 *      ONLY the logs table is touched (memories / central_messages / auth-audit
 *      are never queried or deleted); restart-safe / idempotent; re-entrancy
 *      guard; Date-valued timestamps; null-room bucketing; safe stop().
 *
 * The eviction MATH itself is already proven table-agnostically in
 * memory-retention.test.ts (both share `planRetention`), so this file focuses on
 * the logs adapter wiring + scope isolation rather than re-deriving the planner.
 *
 * No database, no real runtime — deterministic.
 */

import { describe, expect, it } from "vitest";
import {
  LOGS_RETENTION_PREFIX,
  type LogsRetentionAdapter,
  LogsRetentionService,
} from "./logs-retention-service.ts";
import { resolveRetentionConfigWithPrefix } from "./memory-retention.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed epoch for determinism

describe("resolveRetentionConfigWithPrefix — logs config parsing", () => {
  const cfg = (m: Record<string, string>) =>
    resolveRetentionConfigWithPrefix((k) => m[k], LOGS_RETENTION_PREFIX);

  it("returns all-undefined (OFF) for an empty map", () => {
    expect(cfg({})).toEqual({
      retentionDays: undefined,
      maxRowsPerRoom: undefined,
      maxDeletePerSweep: undefined,
      intervalMinutes: undefined,
    });
  });

  it("parses positive numeric values under the ELIZA_LOGS_RETENTION_ prefix", () => {
    const r = cfg({
      ELIZA_LOGS_RETENTION_DAYS: "14",
      ELIZA_LOGS_RETENTION_MAX_ROWS_PER_ROOM: "10000",
      ELIZA_LOGS_RETENTION_MAX_DELETE_PER_SWEEP: "5000",
      ELIZA_LOGS_RETENTION_INTERVAL_MINUTES: "120",
    });
    expect(r).toEqual({
      retentionDays: 14,
      maxRowsPerRoom: 10000,
      maxDeletePerSweep: 5000,
      intervalMinutes: 120,
    });
  });

  it("treats blank / non-numeric / non-positive as unset (fail safe)", () => {
    expect(
      cfg({
        ELIZA_LOGS_RETENTION_DAYS: " ",
        ELIZA_LOGS_RETENTION_MAX_ROWS_PER_ROOM: "xyz",
        ELIZA_LOGS_RETENTION_MAX_DELETE_PER_SWEEP: "0",
        ELIZA_LOGS_RETENTION_INTERVAL_MINUTES: "-1",
      }),
    ).toEqual({
      retentionDays: undefined,
      maxRowsPerRoom: undefined,
      maxDeletePerSweep: undefined,
      intervalMinutes: undefined,
    });
  });

  it("does NOT read the memory-retention keys (independent config)", () => {
    // Setting the memory keys must leave the logs config OFF.
    expect(
      cfg({
        ELIZA_MEMORY_RETENTION_DAYS: "30",
        ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM: "5000",
      }),
    ).toEqual({
      retentionDays: undefined,
      maxRowsPerRoom: undefined,
      maxDeletePerSweep: undefined,
      intervalMinutes: undefined,
    });
  });
});

/**
 * In-memory adapter that records the logs it serves + deletes, PLUS decoy
 * memory/central_messages/auth tables that must never be touched (the logs
 * service has no method to reach them, but we assert it anyway).
 */
class FakeLogsAdapter implements LogsRetentionAdapter {
  logsTable: Array<{ id: string; roomId?: string; createdAt: number | Date }> =
    [];
  deletedIds: string[] = [];
  getLogsCalls = 0;

  // Decoy tables to prove scope isolation — the service can't see these.
  memories = [{ id: "mem1", roomId: "r1", createdAt: NOW - 999 * DAY }];
  centralMessages = [{ id: "cm1", roomId: "r1", createdAt: NOW - 999 * DAY }];
  authAudit = [{ id: "aae1", roomId: "r1", createdAt: NOW - 999 * DAY }];

  seed(rows: Array<{ id: string; roomId?: string; createdAt: number | Date }>) {
    this.logsTable = [...rows];
  }

  async getLogs(params: {
    limit?: number;
  }): Promise<
    Array<{ id?: string; roomId?: string; createdAt?: number | Date }>
  > {
    this.getLogsCalls++;
    return this.logsTable.slice(0, params.limit ?? this.logsTable.length);
  }

  async deleteLogs(ids: string[]): Promise<void> {
    this.deletedIds.push(...ids);
    for (let i = this.logsTable.length - 1; i >= 0; i--) {
      if (ids.includes(this.logsTable[i].id)) this.logsTable.splice(i, 1);
    }
  }
}

/** Build a service with an injected fake adapter + settings map, no scheduling. */
function makeService(
  adapter: FakeLogsAdapter,
  settings: Record<string, string>,
): LogsRetentionService {
  const runtime = {
    agentId: "agent-1",
    adapter,
    getSetting: (k: string) => settings[k],
    getService: () => null,
  } as unknown as import("@elizaos/core").IAgentRuntime;
  const svc = Object.create(
    LogsRetentionService.prototype,
  ) as LogsRetentionService;
  // @ts-expect-error assign protected runtime for the test harness
  svc.runtime = runtime;
  // @ts-expect-error seed resolved config (no timers unless active + start())
  svc.retentionConfig = resolveRetentionConfigWithPrefix(
    (k) => settings[k] ?? process.env[k],
    LOGS_RETENTION_PREFIX,
  );
  // @ts-expect-error init private guard field
  svc.sweeping = false;
  return svc;
}

describe("LogsRetentionService.sweep — against a fake logs adapter", () => {
  it("off-by-default: empty settings => no getLogs, no deletes, no-op", async () => {
    const adapter = new FakeLogsAdapter();
    adapter.seed([{ id: "old", roomId: "r1", createdAt: NOW - 1000 * DAY }]);
    const svc = makeService(adapter, {});
    const result = await svc.sweep();
    expect(result.deleted).toBe(0);
    expect(adapter.getLogsCalls).toBe(0);
    expect(adapter.deletedIds).toEqual([]);
  });

  it("synthetic 500-row growth then prune keeps the count bound; newest survive", async () => {
    const adapter = new FakeLogsAdapter();
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: `log${String(i).padStart(3, "0")}`,
      roomId: "r1",
      createdAt: NOW - i * 60_000, // i minutes old; log000 newest
    }));
    adapter.seed(rows);

    const svc = makeService(adapter, {
      ELIZA_LOGS_RETENTION_MAX_ROWS_PER_ROOM: "100",
    });
    const result = await svc.sweep();

    expect(adapter.logsTable).toHaveLength(100);
    const survivors = new Set(adapter.logsTable.map((r) => r.id));
    expect(survivors.has("log000")).toBe(true); // newest kept
    expect(survivors.has("log099")).toBe(true);
    expect(survivors.has("log100")).toBe(false); // pruned
    expect(result.deleted).toBe(400);
    expect(adapter.deletedIds).toHaveLength(400);
  });

  it("AGE bound prunes rows past retentionDays, keeps recent (Date-valued ts)", async () => {
    const realNow = Date.now();
    const adapter = new FakeLogsAdapter();
    // Timestamps as Date objects (matches the real Log.createdAt shape).
    adapter.seed([
      { id: "recent", roomId: "r1", createdAt: new Date(realNow - 2 * DAY) },
      { id: "stale1", roomId: "r1", createdAt: new Date(realNow - 40 * DAY) },
      { id: "stale2", roomId: "r1", createdAt: new Date(realNow - 90 * DAY) },
    ]);
    const svc = makeService(adapter, { ELIZA_LOGS_RETENTION_DAYS: "30" });
    await svc.sweep();
    expect(adapter.logsTable.map((r) => r.id)).toEqual(["recent"]);
    expect(new Set(adapter.deletedIds)).toEqual(new Set(["stale1", "stale2"]));
  });

  it("buckets null-room logs together so the count bound still applies", async () => {
    const adapter = new FakeLogsAdapter();
    // 4 logs with NO roomId; cap 2 => 2 oldest pruned from the shared bucket.
    adapter.seed([
      { id: "nr0", createdAt: NOW - 1 * 60_000 },
      { id: "nr1", createdAt: NOW - 2 * 60_000 },
      { id: "nr2", createdAt: NOW - 3 * 60_000 },
      { id: "nr3", createdAt: NOW - 4 * 60_000 },
    ]);
    const svc = makeService(adapter, {
      ELIZA_LOGS_RETENTION_MAX_ROWS_PER_ROOM: "2",
    });
    await svc.sweep();
    // newest two (nr0, nr1) survive.
    expect(new Set(adapter.logsTable.map((r) => r.id))).toEqual(
      new Set(["nr0", "nr1"]),
    );
    expect(new Set(adapter.deletedIds)).toEqual(new Set(["nr2", "nr3"]));
  });

  it("clamps to the global maxDeletePerSweep; remainder pruned next sweep", async () => {
    const adapter = new FakeLogsAdapter();
    adapter.seed(
      Array.from({ length: 10 }, (_, i) => ({
        id: `l${i}`,
        roomId: "r1",
        createdAt: NOW - (100 + i) * DAY, // all past age; l9 oldest
      })),
    );
    const svc = makeService(adapter, {
      ELIZA_LOGS_RETENTION_DAYS: "7",
      ELIZA_LOGS_RETENTION_MAX_DELETE_PER_SWEEP: "4",
    });
    const first = await svc.sweep();
    expect(first.deleted).toBe(4);
    expect(first.clamped).toBe(true);
    expect(adapter.logsTable).toHaveLength(6);
    // Idempotent progress: the rest drains on subsequent sweeps.
    const second = await svc.sweep();
    expect(second.deleted).toBe(4);
    const third = await svc.sweep();
    expect(third.deleted).toBe(2);
    expect(adapter.logsTable).toHaveLength(0);
  });

  it("ONLY touches the logs table — memories/central_messages/auth untouched", async () => {
    const adapter = new FakeLogsAdapter();
    adapter.seed([{ id: "old", roomId: "r1", createdAt: NOW - 100 * DAY }]);
    const svc = makeService(adapter, { ELIZA_LOGS_RETENTION_DAYS: "7" });
    await svc.sweep();

    // Only the logs table was pruned.
    expect(adapter.deletedIds).toEqual(["old"]);
    expect(adapter.logsTable).toHaveLength(0);
    // Decoy tables are structurally unreachable AND provably unchanged.
    expect(adapter.memories).toHaveLength(1);
    expect(adapter.centralMessages).toHaveLength(1);
    expect(adapter.authAudit).toHaveLength(1);
  });

  it("is restart-safe: a fresh service re-plans from current DB (idempotent)", async () => {
    const realNow = Date.now();
    const adapter = new FakeLogsAdapter();
    adapter.seed([
      { id: "old", roomId: "r1", createdAt: new Date(realNow - 100 * DAY) },
      { id: "new", roomId: "r1", createdAt: new Date(realNow - 1 * DAY) },
    ]);
    const settings = { ELIZA_LOGS_RETENTION_DAYS: "7" };

    const first = makeService(adapter, settings);
    await first.sweep();
    expect(adapter.logsTable.map((r) => r.id)).toEqual(["new"]);

    // Simulate restart: brand-new instance, same DB, sweep again.
    const second = makeService(adapter, settings);
    const result = await second.sweep();
    expect(result.deleted).toBe(0); // no duplicate work
    expect(adapter.logsTable.map((r) => r.id)).toEqual(["new"]);
  });

  it("skips overlapping sweeps (re-entrancy guard)", async () => {
    const adapter = new FakeLogsAdapter();
    adapter.seed([{ id: "old", roomId: "r1", createdAt: NOW - 100 * DAY }]);
    const svc = makeService(adapter, { ELIZA_LOGS_RETENTION_DAYS: "7" });
    // @ts-expect-error toggle private guard for the test
    svc.sweeping = true;
    const result = await svc.sweep();
    expect(result.deleted).toBe(0);
    expect(adapter.getLogsCalls).toBe(0);
    expect(adapter.deletedIds).toEqual([]);
  });

  it("stop() is safe to call with no timers running", async () => {
    const adapter = new FakeLogsAdapter();
    const svc = makeService(adapter, {});
    await expect(svc.stop()).resolves.toBeUndefined();
  });

  it("tolerates a getLogs failure without throwing (sweep no-ops)", async () => {
    const adapter = new FakeLogsAdapter();
    adapter.getLogs = async () => {
      throw new Error("boom");
    };
    const svc = makeService(adapter, { ELIZA_LOGS_RETENTION_DAYS: "7" });
    const result = await svc.sweep();
    expect(result.deleted).toBe(0);
    expect(adapter.deletedIds).toEqual([]);
  });
});
