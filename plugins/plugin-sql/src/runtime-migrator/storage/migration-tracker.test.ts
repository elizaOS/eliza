import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../types", () => ({
  getRow: (result: { rows: unknown[] }, index = 0) => result.rows[index],
}));

import { MigrationTracker } from "./migration-tracker";

function sqlText(sqlLike: unknown): string {
  const s = sqlLike as { strings: string[]; values: unknown[] };
  let out = s.strings[0] ?? "";
  for (let i = 0; i < (s.values?.length ?? 0); i += 1) {
    out += `?${s.strings[i + 1] ?? ""}`;
  }
  return out;
}

describe("MigrationTracker", () => {
  let db: { execute: ReturnType<typeof vi.fn> };
  let tracker: MigrationTracker;

  beforeEach(() => {
    db = { execute: vi.fn(async () => ({ rows: [] })) };
    tracker = new MigrationTracker(db as never);
  });

  it("creates the migrations schema on demand", async () => {
    await tracker.ensureSchema();
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(sqlText(db.execute.mock.calls[0][0])).toContain(
      "CREATE SCHEMA IF NOT EXISTS migrations"
    );
  });

  it("creates all three bookkeeping tables with IF NOT EXISTS semantics", async () => {
    await tracker.ensureTables();
    expect(db.execute).toHaveBeenCalledTimes(4); // schema + 3 tables
    const ddl = db.execute.mock.calls.map((c) => sqlText(c[0])).join("\n");
    expect(ddl).toContain("migrations._migrations");
    expect(ddl).toContain("migrations._journal");
    expect(ddl).toContain("migrations._snapshots");
    expect(ddl.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(3);
  });

  it("reads the newest migration row for a plugin", async () => {
    db.execute.mockResolvedValue({
      rows: [{ id: 7, hash: "abc123", created_at: "2026-01-01" }],
    });
    await expect(tracker.getLastMigration("plugin-a")).resolves.toEqual({
      id: 7,
      hash: "abc123",
      created_at: "2026-01-01",
    });
    const q = sqlText(db.execute.mock.calls[0][0]);
    expect(q).toContain("plugin_name = ?");
    expect(q).toContain("ORDER BY created_at DESC");
    expect(q).toContain("LIMIT 1");
    expect(db.execute.mock.calls[0][0].values).toEqual(["plugin-a"]);
  });

  it("returns null when no migration has been recorded yet", async () => {
    await expect(tracker.getLastMigration("plugin-a")).resolves.toBeNull();
  });

  it("records a migration with parameterized values (no string interpolation)", async () => {
    await tracker.recordMigration("plugin-a", "deadbeef", 1700000000000);
    expect(db.execute).toHaveBeenCalledTimes(1);
    const call = db.execute.mock.calls[0][0];
    expect(sqlText(call)).toContain(
      "INSERT INTO migrations._migrations (plugin_name, hash, created_at)"
    );
    expect(call.values).toEqual(["plugin-a", "deadbeef", 1700000000000]);
  });
});
