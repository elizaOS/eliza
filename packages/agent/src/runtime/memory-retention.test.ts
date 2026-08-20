/**
 * Unit tests for bounded memory retention.
 *
 * Two layers:
 *   1. The pure planner ({@link planRetention} / {@link resolveRetentionConfig}):
 *      off-by-default, age bound, count bound, both, per-room isolation,
 *      oldest-first clamping, missing-timestamp keep-safe, config parsing.
 *   2. The service ({@link MemoryRetentionService}) against an in-memory fake
 *      adapter: synthetic growth then prune keeps the bound, the newest rows
 *      survive, ONLY memory partitions are touched (no other table), the global
 *      per-sweep delete budget is shared across partitions, off-by-default never
 *      schedules or deletes, and stop()/restart is clean/idempotent.
 *
 * No database, no real runtime — the eviction policy is proven deterministically.
 */

import { describe, expect, it } from "vitest";
import {
  planRetention,
  policyIsActive,
  type RetainableRow,
  resolveRetentionConfig,
} from "./memory-retention.ts";
import {
  MemoryRetentionService,
  RETENTION_PARTITIONS,
  type RetentionAdapter,
} from "./memory-retention-service.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed epoch for determinism

function row(id: string, roomId: string, ageDays: number): RetainableRow {
  return { id, roomId, createdAt: NOW - ageDays * DAY };
}

describe("planRetention — pure planner", () => {
  it("is OFF by default: no bound => empty plan even with old rows", () => {
    const rows = [row("a", "r1", 999), row("b", "r1", 1000)];
    const plan = planRetention(rows, {}, NOW);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.evictable).toBe(0);
    expect(plan.clamped).toBe(false);
    expect(policyIsActive({})).toBe(false);
  });

  it("treats non-positive bounds as disabled (never delete-everything)", () => {
    const rows = [row("a", "r1", 5), row("b", "r1", 10)];
    expect(planRetention(rows, { retentionDays: 0 }, NOW).deleteIds).toEqual(
      [],
    );
    expect(planRetention(rows, { retentionDays: -3 }, NOW).deleteIds).toEqual(
      [],
    );
    expect(planRetention(rows, { maxRowsPerRoom: 0 }, NOW).deleteIds).toEqual(
      [],
    );
    expect(policyIsActive({ retentionDays: 0, maxRowsPerRoom: 0 })).toBe(false);
  });

  it("AGE bound: deletes rows strictly older than retentionDays", () => {
    const rows = [
      row("fresh", "r1", 1),
      row("edge", "r1", 7), // == cutoff, kept (strictly older only)
      row("old1", "r1", 8),
      row("old2", "r1", 30),
    ];
    const plan = planRetention(rows, { retentionDays: 7 }, NOW);
    expect(new Set(plan.deleteIds)).toEqual(new Set(["old1", "old2"]));
    expect(plan.evictable).toBe(2);
  });

  it("COUNT bound: keeps only the N most-recent rows per room", () => {
    const rows = [
      row("n0", "r1", 1),
      row("n1", "r1", 2),
      row("n2", "r1", 3),
      row("n3", "r1", 4),
      row("n4", "r1", 5),
    ];
    const plan = planRetention(rows, { maxRowsPerRoom: 2 }, NOW);
    // keep n0,n1 (newest two); delete n2,n3,n4
    expect(new Set(plan.deleteIds)).toEqual(new Set(["n2", "n3", "n4"]));
  });

  it("BOTH bounds: a row is evicted if EITHER bound would evict it", () => {
    const rows = [
      row("keep", "r1", 1), // young + within count
      row("oldButFew", "r1", 40), // within count(2) but past age(7) => evict
      row("youngButMany", "r1", 2), // young but pushed out by count => evict
    ];
    // maxRows=2 keeps the 2 newest: keep(1d), youngButMany(2d); oldButFew evicted by count too
    const plan = planRetention(
      rows,
      { retentionDays: 7, maxRowsPerRoom: 2 },
      NOW,
    );
    expect(plan.deleteIds).toContain("oldButFew");
  });

  it("is per-room: one room's overflow never evicts another room's rows", () => {
    const rows = [
      row("r1a", "r1", 1),
      row("r1b", "r1", 2),
      row("r1c", "r1", 3), // r1 has 3, cap 2 => evict oldest r1
      row("r2a", "r2", 1), // r2 has 1, cap 2 => keep
    ];
    const plan = planRetention(rows, { maxRowsPerRoom: 2 }, NOW);
    expect(plan.deleteIds).toEqual(["r1c"]);
  });

  it("orders deleteIds oldest-first regardless of input order", () => {
    const rows = [
      row("mid", "r1", 20),
      row("oldest", "r1", 100),
      row("old", "r1", 30),
    ];
    const plan = planRetention(rows, { retentionDays: 7 }, NOW);
    expect(plan.deleteIds).toEqual(["oldest", "old", "mid"]);
  });

  it("clamps to maxDeletePerSweep, dropping the OLDEST backlog first", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row(`m${i}`, "r1", 100 - i),
    ); // m0 oldest(100d) ... m9 newest(91d)
    const plan = planRetention(
      rows,
      { retentionDays: 7, maxDeletePerSweep: 3 },
      NOW,
    );
    expect(plan.evictable).toBe(10);
    expect(plan.deleteIds).toHaveLength(3);
    expect(plan.clamped).toBe(true);
    // oldest three
    expect(plan.deleteIds).toEqual(["m0", "m1", "m2"]);
  });

  it("keeps rows with missing/NaN createdAt (fail-safe, never age-evicted)", () => {
    const rows: RetainableRow[] = [
      { id: "noTs", roomId: "r1", createdAt: NaN as unknown as number },
      row("old", "r1", 100),
    ];
    const plan = planRetention(rows, { retentionDays: 7 }, NOW);
    expect(plan.deleteIds).toEqual(["old"]);
    expect(plan.deleteIds).not.toContain("noTs");
  });
});

describe("resolveRetentionConfig — config parsing", () => {
  const cfg = (m: Record<string, string>) =>
    resolveRetentionConfig((k) => m[k]);

  it("returns all-undefined (OFF) for an empty map", () => {
    expect(cfg({})).toEqual({
      retentionDays: undefined,
      maxRowsPerRoom: undefined,
      maxDeletePerSweep: undefined,
      intervalMinutes: undefined,
    });
  });

  it("parses positive numeric values", () => {
    const r = cfg({
      ELIZA_MEMORY_RETENTION_DAYS: "30",
      ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM: "5000",
      ELIZA_MEMORY_RETENTION_MAX_DELETE_PER_SWEEP: "2000",
      ELIZA_MEMORY_RETENTION_INTERVAL_MINUTES: "60",
    });
    expect(r).toEqual({
      retentionDays: 30,
      maxRowsPerRoom: 5000,
      maxDeletePerSweep: 2000,
      intervalMinutes: 60,
    });
  });

  it("treats blank / non-numeric / non-positive as unset (fail safe)", () => {
    expect(
      cfg({
        ELIZA_MEMORY_RETENTION_DAYS: "  ",
        ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM: "abc",
        ELIZA_MEMORY_RETENTION_MAX_DELETE_PER_SWEEP: "0",
        ELIZA_MEMORY_RETENTION_INTERVAL_MINUTES: "-5",
      }),
    ).toEqual({
      retentionDays: undefined,
      maxRowsPerRoom: undefined,
      maxDeletePerSweep: undefined,
      intervalMinutes: undefined,
    });
  });

  it("rejects fractional row and deletion counts instead of rounding to zero", () => {
    const config = cfg({
      ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM: "0.5",
      ELIZA_MEMORY_RETENTION_MAX_DELETE_PER_SWEEP: "2.5",
    });

    expect(config.maxRowsPerRoom).toBeUndefined();
    expect(config.maxDeletePerSweep).toBeUndefined();
    expect(
      planRetention([row("keep", "r1", 1)], config, NOW).deleteIds,
    ).toEqual([]);
  });
});

/** In-memory adapter that records every table it is asked about + deletes. */
class FakeAdapter implements RetentionAdapter {
  tables = new Map<
    string,
    Array<{ id: string; roomId: string; createdAt: number }>
  >();
  queriedTables: string[] = [];
  deletedIds: string[] = [];

  seed(
    table: string,
    rows: Array<{ id: string; roomId: string; createdAt: number }>,
  ) {
    this.tables.set(table, [...rows]);
  }

  async getMemories(params: {
    tableName: string;
    limit?: number;
  }): Promise<Array<{ id?: string; roomId: string; createdAt?: number }>> {
    this.queriedTables.push(params.tableName);
    return [...(this.tables.get(params.tableName) ?? [])];
  }

  async deleteManyMemories(ids: string[]): Promise<void> {
    this.deletedIds.push(...ids);
    for (const [, rows] of this.tables) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (ids.includes(rows[i].id)) rows.splice(i, 1);
      }
    }
  }
}

/** Build a service with an injected fake adapter + settings map, no scheduling. */
function makeService(
  adapter: FakeAdapter,
  settings: Record<string, string>,
  agentId = "agent-1",
): MemoryRetentionService {
  const runtime = {
    agentId,
    adapter,
    getSetting: (k: string) => settings[k],
    getService: () => null,
  } as unknown as import("@elizaos/core").IAgentRuntime;
  // Construct without start() so no timers are created; init config manually.
  const svc = Object.create(
    MemoryRetentionService.prototype,
  ) as MemoryRetentionService;
  // @ts-expect-error assign protected runtime for the test harness
  svc.runtime = runtime;
  // @ts-expect-error assign private retentionConfig to resolve config (no timers unless active + start())
  svc.retentionConfig = resolveRetentionConfig(
    (k) => settings[k] ?? process.env[k],
  );
  return svc;
}

describe("MemoryRetentionService.sweep — against a fake adapter", () => {
  it("off-by-default: empty settings => no deletes, sweep is a no-op", async () => {
    const adapter = new FakeAdapter();
    adapter.seed("memories", [
      { id: "old", roomId: "r1", createdAt: NOW - 1000 * DAY },
    ]);
    const svc = makeService(adapter, {});
    const results = await svc.sweep();
    expect(results).toEqual([]);
    expect(adapter.deletedIds).toEqual([]);
  });

  it("synthetic growth then prune keeps the row-count bound; newest survive", async () => {
    const adapter = new FakeAdapter();
    // 500 rows in one room, ascending age (id_i is i days old)
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: `m${String(i).padStart(3, "0")}`,
      roomId: "r1",
      createdAt: NOW - i * 60_000, // i minutes old; m000 newest
    }));
    adapter.seed("memories", rows);

    const svc = makeService(adapter, {
      ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM: "100",
    });
    await svc.sweep();

    const remaining = adapter.tables.get("memories") ?? [];
    expect(remaining).toHaveLength(100);
    // the 100 newest (m000..m099) survive; m100+ deleted
    const survivorIds = new Set(remaining.map((r) => r.id));
    expect(survivorIds.has("m000")).toBe(true);
    expect(survivorIds.has("m099")).toBe(true);
    expect(survivorIds.has("m100")).toBe(false);
    expect(adapter.deletedIds).toHaveLength(400);
  });

  it("age bound prunes rows past retentionDays, keeps recent", async () => {
    // The service stamps its own `Date.now()`, so these fixtures are relative
    // to real wall-clock time, not the frozen NOW used by the pure-planner tests.
    const realNow = Date.now();
    const adapter = new FakeAdapter();
    adapter.seed("memories", [
      { id: "recent", roomId: "r1", createdAt: realNow - 2 * DAY },
      { id: "stale1", roomId: "r1", createdAt: realNow - 40 * DAY },
      { id: "stale2", roomId: "r1", createdAt: realNow - 90 * DAY },
    ]);
    const svc = makeService(adapter, {
      ELIZA_MEMORY_RETENTION_DAYS: "30",
    });
    await svc.sweep();
    const remaining = (adapter.tables.get("memories") ?? []).map((r) => r.id);
    expect(remaining).toEqual(["recent"]);
    expect(new Set(adapter.deletedIds)).toEqual(new Set(["stale1", "stale2"]));
  });

  it("ONLY touches memory partitions — never other tables", async () => {
    const adapter = new FakeAdapter();
    adapter.seed("memories", [
      { id: "old", roomId: "r1", createdAt: NOW - 100 * DAY },
    ]);
    // Tables that MUST NOT be touched by retention:
    adapter.seed("central_messages", [
      { id: "cm1", roomId: "r1", createdAt: NOW - 100 * DAY },
    ]);
    adapter.seed("logs", [
      { id: "log1", roomId: "r1", createdAt: NOW - 100 * DAY },
    ]);
    adapter.seed("auth_audit_events", [
      { id: "aae1", roomId: "r1", createdAt: NOW - 100 * DAY },
    ]);

    const svc = makeService(adapter, { ELIZA_MEMORY_RETENTION_DAYS: "7" });
    await svc.sweep();

    // Only the canonical memory partitions were queried.
    for (const t of adapter.queriedTables) {
      expect(RETENTION_PARTITIONS as readonly string[]).toContain(t);
    }
    expect(adapter.queriedTables).not.toContain("central_messages");
    expect(adapter.queriedTables).not.toContain("logs");
    expect(adapter.queriedTables).not.toContain("auth_audit_events");
    // Non-memory tables untouched.
    expect(adapter.tables.get("central_messages")).toHaveLength(1);
    expect(adapter.tables.get("logs")).toHaveLength(1);
    expect(adapter.tables.get("auth_audit_events")).toHaveLength(1);
    // The old memory row was pruned.
    expect(adapter.deletedIds).toEqual(["old"]);
  });

  it("shares a global maxDeletePerSweep budget across partitions", async () => {
    const adapter = new FakeAdapter();
    adapter.seed(
      "memories",
      Array.from({ length: 5 }, (_, i) => ({
        id: `mem${i}`,
        roomId: "r1",
        createdAt: NOW - (100 + i) * DAY,
      })),
    );
    adapter.seed(
      "facts",
      Array.from({ length: 5 }, (_, i) => ({
        id: `fact${i}`,
        roomId: "r1",
        createdAt: NOW - (100 + i) * DAY,
      })),
    );
    const svc = makeService(adapter, {
      ELIZA_MEMORY_RETENTION_DAYS: "7",
      ELIZA_MEMORY_RETENTION_MAX_DELETE_PER_SWEEP: "6",
    });
    const results = await svc.sweep();
    const totalDeleted = results.reduce((n, r) => n + r.deleted, 0);
    expect(totalDeleted).toBe(6); // budget respected across partitions
    expect(adapter.deletedIds).toHaveLength(6);
    // The rest remains for the next sweep (idempotent progress).
    const rest = await svc.sweep();
    expect(rest.reduce((n, r) => n + r.deleted, 0)).toBe(4);
  });

  it("is restart-safe: a fresh service re-plans from current DB (idempotent)", async () => {
    const adapter = new FakeAdapter();
    // Real-time-relative fixtures (service uses Date.now()).
    const realNow = Date.now();
    adapter.tables.set("memories", [
      { id: "old", roomId: "r1", createdAt: realNow - 100 * DAY },
      { id: "new", roomId: "r1", createdAt: realNow - 1 * DAY },
    ]);
    const settings = { ELIZA_MEMORY_RETENTION_DAYS: "7" };

    const first = makeService(adapter, settings);
    await first.sweep();
    expect((adapter.tables.get("memories") ?? []).map((r) => r.id)).toEqual([
      "new",
    ]);

    // Simulate restart: brand-new service instance, same DB, sweep again.
    const second = makeService(adapter, settings);
    const results = await second.sweep();
    // Nothing new to delete — no duplicate work, no error.
    expect(results.every((r) => r.deleted === 0)).toBe(true);
    expect((adapter.tables.get("memories") ?? []).map((r) => r.id)).toEqual([
      "new",
    ]);
  });

  it("stop() is safe to call with no timers running", async () => {
    const adapter = new FakeAdapter();
    const svc = makeService(adapter, {});
    await expect(svc.stop()).resolves.toBeUndefined();
  });

  it("skips overlapping sweeps (re-entrancy guard)", async () => {
    const adapter = new FakeAdapter();
    adapter.seed("memories", [
      { id: "old", roomId: "r1", createdAt: NOW - 100 * DAY },
    ]);
    const svc = makeService(adapter, { ELIZA_MEMORY_RETENTION_DAYS: "7" });
    // Force the guard on, then confirm a concurrent sweep no-ops.
    // @ts-expect-error toggle private guard for the test
    svc.sweeping = true;
    const results = await svc.sweep();
    expect(results).toEqual([]);
    expect(adapter.deletedIds).toEqual([]);
  });
});
