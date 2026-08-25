/**
 * Behavioral coverage for the scheduled memory-partition retention sweep:
 * adapter narrowing, start/stop timers, re-entrancy, shared delete budget,
 * id-less and timestamp-less rows, per-partition query isolation, and the
 * service resolver.
 *
 * Drives the real service against an in-memory RetentionAdapter. Eviction
 * math lives in memory-retention.test.ts; this suite asserts the service's
 * I/O wiring and control-flow branches. No database and no production mocks.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveRetentionConfig } from "./memory-retention.ts";
import {
  MEMORY_RETENTION_SERVICE,
  MemoryRetentionService,
  RETENTION_PARTITIONS,
  type RetentionAdapter,
  resolveMemoryRetentionService,
} from "./memory-retention-service.ts";

const DAY = 24 * 60 * 60 * 1000;

type MemoryRow = { id?: string; roomId: string; createdAt?: number };

type GetMemoriesParams = {
  agentId?: string;
  tableName: string;
  limit?: number;
  orderBy?: "createdAt";
  orderDirection?: "asc" | "desc";
};

class FakeAdapter implements RetentionAdapter {
  tables = new Map<string, MemoryRow[]>();
  queriedTables: string[] = [];
  getMemoriesCalls: GetMemoriesParams[] = [];
  deletedIds: string[] = [];
  failTables = new Set<string>();
  deleteError: Error | null = null;

  seed(table: string, rows: MemoryRow[]): void {
    this.tables.set(table, [...rows]);
  }

  async getMemories(params: GetMemoriesParams): Promise<MemoryRow[]> {
    this.queriedTables.push(params.tableName);
    this.getMemoriesCalls.push(params);
    if (this.failTables.has(params.tableName)) {
      throw new Error(`query failed: ${params.tableName}`);
    }
    return [...(this.tables.get(params.tableName) ?? [])];
  }

  async deleteManyMemories(ids: string[]): Promise<void> {
    if (this.deleteError) {
      throw this.deleteError;
    }
    this.deletedIds.push(...ids);
    for (const [, rows] of this.tables) {
      for (let i = rows.length - 1; i >= 0; i--) {
        const id = rows[i].id;
        if (id !== undefined && ids.includes(id)) {
          rows.splice(i, 1);
        }
      }
    }
  }
}

function makeRuntime(opts: {
  adapter?: unknown;
  settings?: Record<string, string | number | boolean | null | undefined>;
  agentId?: string;
  services?: Record<string, unknown | null>;
}): IAgentRuntime {
  const settings = opts.settings ?? {};
  const services = opts.services ?? {};
  return {
    agentId: opts.agentId ?? "agent-1",
    adapter: opts.adapter,
    getSetting: (key: string) => {
      if (!Object.hasOwn(settings, key)) {
        return undefined;
      }
      return settings[key] as string | number | boolean | null;
    },
    getService: (serviceType: string) => {
      if (!Object.hasOwn(services, serviceType)) {
        return null;
      }
      return services[serviceType];
    },
  } as unknown as IAgentRuntime;
}

function makeService(
  adapter: unknown,
  settings: Record<string, string | number | boolean | null | undefined>,
  agentId = "agent-1",
): MemoryRetentionService {
  const runtime = makeRuntime({ adapter, settings, agentId });
  const svc = Object.create(
    MemoryRetentionService.prototype,
  ) as MemoryRetentionService;
  // @ts-expect-error assign protected runtime for the test harness
  svc.runtime = runtime;
  // @ts-expect-error seed resolved config without scheduling timers
  svc.retentionConfig = resolveRetentionConfig((key) => {
    if (!Object.hasOwn(settings, key)) {
      return process.env[key];
    }
    const value = settings[key];
    if (value === undefined || value === null) {
      return process.env[key];
    }
    return String(value);
  });
  // @ts-expect-error init private re-entrancy guard
  svc.sweeping = false;
  return svc;
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previous;
}

describe("MEMORY_RETENTION_SERVICE and RETENTION_PARTITIONS", () => {
  it("exports the registered service type string", () => {
    expect(MEMORY_RETENTION_SERVICE).toBe("eliza_memory_retention");
    expect(MemoryRetentionService.serviceType).toBe(MEMORY_RETENTION_SERVICE);
  });

  it("governs memories, messages, facts, and documents in that order", () => {
    expect(RETENTION_PARTITIONS).toEqual([
      "memories",
      "messages",
      "facts",
      "documents",
    ]);
  });

  it("describes the disk-bound capability", () => {
    const svc = new MemoryRetentionService(
      makeRuntime({ adapter: new FakeAdapter() }),
    );
    expect(svc.capabilityDescription.length).toBeGreaterThan(0);
    expect(svc.capabilityDescription).toMatch(/retention/i);
  });
});

describe("resolveMemoryRetentionService", () => {
  it("returns null when the runtime has no retention service", () => {
    const runtime = makeRuntime({});
    expect(resolveMemoryRetentionService(runtime)).toBeNull();
  });

  it("returns the registered instance for MEMORY_RETENTION_SERVICE", () => {
    const svc = makeService(new FakeAdapter(), {});
    const runtime = makeRuntime({
      services: { [MEMORY_RETENTION_SERVICE]: svc },
    });
    expect(resolveMemoryRetentionService(runtime)).toBe(svc);
  });
});

describe("MemoryRetentionService.start / stop", () => {
  it("returns immediately and schedules nothing when no bound is active", async () => {
    const before = Date.now();
    const svc = await MemoryRetentionService.start(
      makeRuntime({ adapter: new FakeAdapter(), settings: {} }),
    );
    expect(Date.now() - before).toBeLessThan(5_000);
    // @ts-expect-error private start delay timer
    expect(svc.startTimer).toBeNull();
    // @ts-expect-error private interval timer
    expect(svc.timer).toBeNull();
    await expect(svc.stop()).resolves.toBeUndefined();
  });

  it("schedules a boot-settle timer when a bound is active, and stop() clears it", async () => {
    const svc = await MemoryRetentionService.start(
      makeRuntime({
        adapter: new FakeAdapter(),
        settings: { ELIZA_MEMORY_RETENTION_DAYS: "30" },
      }),
    );
    // @ts-expect-error private start delay timer
    expect(svc.startTimer).not.toBeNull();
    // Interval is created only after the 30s settle delay.
    // @ts-expect-error private interval timer
    expect(svc.timer).toBeNull();
    await svc.stop();
    // @ts-expect-error private start delay timer
    expect(svc.startTimer).toBeNull();
    // @ts-expect-error private interval timer
    expect(svc.timer).toBeNull();
    await expect(svc.stop()).resolves.toBeUndefined();
  });

  it("prefers runtime.getSetting over process.env", async () => {
    const key = "ELIZA_MEMORY_RETENTION_DAYS";
    const previous = process.env[key];
    process.env[key] = "999";
    try {
      const svc = await MemoryRetentionService.start(
        makeRuntime({
          adapter: new FakeAdapter(),
          settings: { [key]: "7" },
        }),
      );
      // @ts-expect-error private resolved config
      expect(svc.retentionConfig.retentionDays).toBe(7);
      await svc.stop();
    } finally {
      restoreEnv(key, previous);
    }
  });

  it("falls back to process.env when getSetting returns undefined", async () => {
    const key = "ELIZA_MEMORY_RETENTION_DAYS";
    const previous = process.env[key];
    process.env[key] = "14";
    try {
      const svc = await MemoryRetentionService.start(
        makeRuntime({ adapter: new FakeAdapter(), settings: {} }),
      );
      // @ts-expect-error private resolved config
      expect(svc.retentionConfig.retentionDays).toBe(14);
      await svc.stop();
    } finally {
      restoreEnv(key, previous);
    }
  });

  it("falls back to process.env when getSetting returns null", async () => {
    const key = "ELIZA_MEMORY_RETENTION_DAYS";
    const previous = process.env[key];
    process.env[key] = "21";
    try {
      const svc = await MemoryRetentionService.start(
        makeRuntime({
          adapter: new FakeAdapter(),
          settings: { [key]: null },
        }),
      );
      // @ts-expect-error private resolved config
      expect(svc.retentionConfig.retentionDays).toBe(21);
      await svc.stop();
    } finally {
      restoreEnv(key, previous);
    }
  });

  it("stringifies a numeric getSetting value", async () => {
    const svc = await MemoryRetentionService.start(
      makeRuntime({
        adapter: new FakeAdapter(),
        settings: { ELIZA_MEMORY_RETENTION_DAYS: 30 },
      }),
    );
    // @ts-expect-error private resolved config
    expect(svc.retentionConfig.retentionDays).toBe(30);
    await svc.stop();
  });
});

describe("MemoryRetentionService.sweep — adapter narrowing", () => {
  const settings = { ELIZA_MEMORY_RETENTION_DAYS: "7" };

  it("skips when adapter is null", async () => {
    const svc = makeService(null, settings);
    expect(await svc.sweep()).toEqual([]);
  });

  it("skips when adapter is a non-object", async () => {
    const svc = makeService("not-an-adapter", settings);
    expect(await svc.sweep()).toEqual([]);
  });

  it("skips when getMemories is missing", async () => {
    const svc = makeService(
      { deleteManyMemories: async () => undefined },
      settings,
    );
    expect(await svc.sweep()).toEqual([]);
  });

  it("skips when deleteManyMemories is missing", async () => {
    const svc = makeService({ getMemories: async () => [] }, settings);
    expect(await svc.sweep()).toEqual([]);
  });
});

describe("MemoryRetentionService.sweep — against a fake adapter", () => {
  it("off-by-default: empty settings never query or delete", async () => {
    const adapter = new FakeAdapter();
    adapter.seed("memories", [
      { id: "old", roomId: "r1", createdAt: Date.now() - 1000 * DAY },
    ]);
    const svc = makeService(adapter, {});
    expect(await svc.sweep()).toEqual([]);
    expect(adapter.getMemoriesCalls).toEqual([]);
    expect(adapter.deletedIds).toEqual([]);
  });

  it("returns [] and does not query when a sweep is already in progress", async () => {
    const adapter = new FakeAdapter();
    adapter.seed("memories", [
      { id: "old", roomId: "r1", createdAt: Date.now() - 100 * DAY },
    ]);
    const svc = makeService(adapter, { ELIZA_MEMORY_RETENTION_DAYS: "7" });
    // @ts-expect-error toggle private re-entrancy guard
    svc.sweeping = true;
    expect(await svc.sweep()).toEqual([]);
    expect(adapter.getMemoriesCalls).toEqual([]);
    expect(adapter.deletedIds).toEqual([]);
  });

  it("queries every retention partition in order with SCAN_LIMIT and agentId", async () => {
    const adapter = new FakeAdapter();
    const svc = makeService(
      adapter,
      { ELIZA_MEMORY_RETENTION_DAYS: "7" },
      "agent-xyz",
    );
    const results = await svc.sweep();
    expect(adapter.queriedTables).toEqual([...RETENTION_PARTITIONS]);
    expect(results.map((r) => r.partition)).toEqual([...RETENTION_PARTITIONS]);
    for (const call of adapter.getMemoriesCalls) {
      expect(call.agentId).toBe("agent-xyz");
      expect(call.limit).toBe(100_000);
      expect(call.orderBy).toBe("createdAt");
      expect(call.orderDirection).toBe("asc");
    }
    expect(results.every((r) => r.scanned === 0 && r.deleted === 0)).toBe(true);
  });

  it("empty partitions produce zero-scan results and no deletes", async () => {
    const adapter = new FakeAdapter();
    const svc = makeService(adapter, {
      ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM: "10",
    });
    const results = await svc.sweep();
    expect(results).toHaveLength(RETENTION_PARTITIONS.length);
    expect(results.every((r) => r.scanned === 0 && r.evictable === 0)).toBe(
      true,
    );
    expect(adapter.deletedIds).toEqual([]);
  });

  it("keeps a single in-bound row", async () => {
    const now = Date.now();
    const adapter = new FakeAdapter();
    adapter.seed("memories", [
      { id: "only", roomId: "r1", createdAt: now - 1 * DAY },
    ]);
    const svc = makeService(adapter, { ELIZA_MEMORY_RETENTION_DAYS: "7" });
    const results = await svc.sweep();
    const memories = results.find((r) => r.partition === "memories");
    expect(memories?.scanned).toBe(1);
    expect(memories?.deleted).toBe(0);
    expect(adapter.tables.get("memories")?.map((r) => r.id)).toEqual(["only"]);
    expect(adapter.deletedIds).toEqual([]);
  });

  it("evicts a single row past the age bound", async () => {
    const now = Date.now();
    const adapter = new FakeAdapter();
    adapter.seed("memories", [
      { id: "stale", roomId: "r1", createdAt: now - 40 * DAY },
    ]);
    const svc = makeService(adapter, { ELIZA_MEMORY_RETENTION_DAYS: "7" });
    const results = await svc.sweep();
    const memories = results.find((r) => r.partition === "memories");
    expect(memories?.scanned).toBe(1);
    expect(memories?.deleted).toBe(1);
    expect(adapter.deletedIds).toEqual(["stale"]);
    expect(adapter.tables.get("memories")).toEqual([]);
  });

  it("skips rows with no id so they are never deleted", async () => {
    const now = Date.now();
    const adapter = new FakeAdapter();
    adapter.seed("memories", [
      { roomId: "r1", createdAt: now - 100 * DAY },
      { id: "named", roomId: "r1", createdAt: now - 100 * DAY },
    ]);
    const svc = makeService(adapter, { ELIZA_MEMORY_RETENTION_DAYS: "7" });
    const results = await svc.sweep();
    const memories = results.find((r) => r.partition === "memories");
    expect(memories?.scanned).toBe(1);
    expect(adapter.deletedIds).toEqual(["named"]);
    expect(adapter.tables.get("memories")?.map((r) => r.id)).toEqual([
      undefined,
    ]);
  });

  it("treats a missing createdAt as now, so the row is not age-evicted", async () => {
    const now = Date.now();
    const adapter = new FakeAdapter();
    adapter.seed("memories", [
      { id: "no-ts", roomId: "r1" },
      { id: "old", roomId: "r1", createdAt: now - 90 * DAY },
    ]);
    const svc = makeService(adapter, { ELIZA_MEMORY_RETENTION_DAYS: "7" });
    await svc.sweep();
    expect(adapter.deletedIds).toEqual(["old"]);
    expect(adapter.tables.get("memories")?.map((r) => r.id)).toEqual(["no-ts"]);
  });

  it("count-bound with identical timestamps still drops overflow in input order", async () => {
    const now = Date.now();
    const adapter = new FakeAdapter();
    adapter.seed("memories", [
      { id: "a", roomId: "r1", createdAt: now },
      { id: "b", roomId: "r1", createdAt: now },
      { id: "c", roomId: "r1", createdAt: now },
    ]);
    const svc = makeService(adapter, {
      ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM: "2",
    });
    await svc.sweep();
    expect(adapter.deletedIds).toEqual(["c"]);
    expect(adapter.tables.get("memories")?.map((r) => r.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("skips a partition whose query throws and continues the remaining partitions", async () => {
    const now = Date.now();
    const adapter = new FakeAdapter();
    adapter.failTables.add("memories");
    adapter.seed("messages", [
      { id: "stale-msg", roomId: "r1", createdAt: now - 90 * DAY },
    ]);
    const svc = makeService(adapter, { ELIZA_MEMORY_RETENTION_DAYS: "7" });
    const results = await svc.sweep();
    expect(results.map((r) => r.partition)).toEqual([
      "messages",
      "facts",
      "documents",
    ]);
    expect(adapter.deletedIds).toEqual(["stale-msg"]);
    expect(adapter.queriedTables).toEqual([...RETENTION_PARTITIONS]);
  });

  it("does not query later partitions once the shared delete budget is exhausted", async () => {
    const now = Date.now();
    const adapter = new FakeAdapter();
    adapter.seed(
      "memories",
      Array.from({ length: 3 }, (_, i) => ({
        id: `mem${i}`,
        roomId: "r1",
        createdAt: now - (100 + i) * DAY,
      })),
    );
    adapter.seed(
      "messages",
      Array.from({ length: 3 }, (_, i) => ({
        id: `msg${i}`,
        roomId: "r1",
        createdAt: now - (100 + i) * DAY,
      })),
    );
    adapter.seed(
      "facts",
      Array.from({ length: 3 }, (_, i) => ({
        id: `fact${i}`,
        roomId: "r1",
        createdAt: now - (100 + i) * DAY,
      })),
    );
    const svc = makeService(adapter, {
      ELIZA_MEMORY_RETENTION_DAYS: "7",
      ELIZA_MEMORY_RETENTION_MAX_DELETE_PER_SWEEP: "2",
    });
    const results = await svc.sweep();
    expect(adapter.queriedTables).toEqual(["memories"]);
    expect(adapter.deletedIds).toHaveLength(2);
    expect(results.find((r) => r.partition === "memories")).toEqual({
      partition: "memories",
      scanned: 3,
      evictable: 3,
      deleted: 2,
      clamped: true,
    });
    expect(results.find((r) => r.partition === "messages")).toEqual({
      partition: "messages",
      scanned: 0,
      evictable: 0,
      deleted: 0,
      clamped: true,
    });
    expect(results.find((r) => r.partition === "facts")).toEqual({
      partition: "facts",
      scanned: 0,
      evictable: 0,
      deleted: 0,
      clamped: true,
    });
    expect(results.find((r) => r.partition === "documents")).toEqual({
      partition: "documents",
      scanned: 0,
      evictable: 0,
      deleted: 0,
      clamped: true,
    });
  });

  it("shares leftover budget with the next partition, then clamps the rest", async () => {
    const now = Date.now();
    const adapter = new FakeAdapter();
    adapter.seed(
      "memories",
      Array.from({ length: 2 }, (_, i) => ({
        id: `mem${i}`,
        roomId: "r1",
        createdAt: now - (100 + i) * DAY,
      })),
    );
    adapter.seed(
      "messages",
      Array.from({ length: 3 }, (_, i) => ({
        id: `msg${i}`,
        roomId: "r1",
        createdAt: now - (100 + i) * DAY,
      })),
    );
    const svc = makeService(adapter, {
      ELIZA_MEMORY_RETENTION_DAYS: "7",
      ELIZA_MEMORY_RETENTION_MAX_DELETE_PER_SWEEP: "3",
    });
    const results = await svc.sweep();
    expect(adapter.queriedTables).toEqual(["memories", "messages"]);
    expect(adapter.deletedIds).toHaveLength(3);
    expect(results.find((r) => r.partition === "memories")?.deleted).toBe(2);
    expect(results.find((r) => r.partition === "messages")).toMatchObject({
      scanned: 3,
      evictable: 3,
      deleted: 1,
      clamped: true,
    });
    expect(results.find((r) => r.partition === "facts")?.clamped).toBe(true);
    expect(results.find((r) => r.partition === "facts")?.scanned).toBe(0);
  });

  it("does not throw when deleteManyMemories fails, and resets the re-entrancy guard", async () => {
    const now = Date.now();
    const adapter = new FakeAdapter();
    adapter.deleteError = new Error("delete boom");
    adapter.seed("memories", [
      { id: "old", roomId: "r1", createdAt: now - 90 * DAY },
    ]);
    const svc = makeService(adapter, { ELIZA_MEMORY_RETENTION_DAYS: "7" });
    const first = await svc.sweep();
    expect(first).toEqual([]);
    expect(adapter.deletedIds).toEqual([]);
    // @ts-expect-error private re-entrancy guard
    expect(svc.sweeping).toBe(false);

    adapter.deleteError = null;
    const second = await svc.sweep();
    expect(second.find((r) => r.partition === "memories")?.deleted).toBe(1);
    expect(adapter.deletedIds).toEqual(["old"]);
  });

  it("keeps earlier partition results when a later delete throws", async () => {
    const now = Date.now();
    const adapter = new FakeAdapter();
    adapter.seed("memories", [
      { id: "old-mem", roomId: "r1", createdAt: now - 90 * DAY },
    ]);
    adapter.seed("messages", [
      { id: "old-msg", roomId: "r1", createdAt: now - 90 * DAY },
    ]);
    const originalDelete = adapter.deleteManyMemories.bind(adapter);
    adapter.deleteManyMemories = async (ids: string[]) => {
      if (ids.includes("old-msg")) {
        throw new Error("messages delete boom");
      }
      await originalDelete(ids);
    };
    const svc = makeService(adapter, { ELIZA_MEMORY_RETENTION_DAYS: "7" });
    const results = await svc.sweep();
    expect(results.map((r) => r.partition)).toEqual(["memories"]);
    expect(adapter.deletedIds).toEqual(["old-mem"]);
    // @ts-expect-error private re-entrancy guard
    expect(svc.sweeping).toBe(false);
  });

  it("is restart-safe: a fresh service re-plans from the current adapter", async () => {
    const now = Date.now();
    const adapter = new FakeAdapter();
    adapter.seed("memories", [
      { id: "old", roomId: "r1", createdAt: now - 100 * DAY },
      { id: "new", roomId: "r1", createdAt: now - 1 * DAY },
    ]);
    const settings = { ELIZA_MEMORY_RETENTION_DAYS: "7" };
    await makeService(adapter, settings).sweep();
    expect(adapter.tables.get("memories")?.map((r) => r.id)).toEqual(["new"]);

    const second = await makeService(adapter, settings).sweep();
    expect(second.every((r) => r.deleted === 0)).toBe(true);
    expect(adapter.tables.get("memories")?.map((r) => r.id)).toEqual(["new"]);
  });

  it("stop() is safe when no timers were scheduled", async () => {
    const svc = makeService(new FakeAdapter(), {});
    await expect(svc.stop()).resolves.toBeUndefined();
  });
});
