import { describe, expect, it, vi } from "vitest";
import type { DrizzleDB, SchemaSnapshot } from "../types";
import { SnapshotStorage } from "./snapshot-storage";

function makeDb(): { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn();
  return { execute };
}

function sqlText(call: unknown): string {
  const { strings, values } = call as { strings: string[]; values: unknown[] };
  return strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ""), "");
}

const SNAPSHOT: SchemaSnapshot = {
  tables: [{ name: "users", columns: [] }],
} as unknown as SchemaSnapshot;

describe("SnapshotStorage", () => {
  it("saves a snapshot as JSON with an upsert on (plugin_name, idx)", async () => {
    const db = makeDb();
    db.execute.mockResolvedValue({ rows: [] });
    const storage = new SnapshotStorage(db as unknown as DrizzleDB);
    await storage.saveSnapshot("plugin-a", 3, SNAPSHOT);
    const text = sqlText(db.execute.mock.calls[0][0]);
    expect(text).toContain("INSERT INTO migrations._snapshots");
    expect(text).toContain("ON CONFLICT (plugin_name, idx)");
    expect(text).toContain("DO UPDATE SET");
    expect(db.execute.mock.calls[0][0].values).toContain("plugin-a");
    expect(db.execute.mock.calls[0][0].values).toContain(3);
    expect(db.execute.mock.calls[0][0].values[2]).toBe(JSON.stringify(SNAPSHOT));
  });

  it("returns null when no snapshot row exists", async () => {
    const db = makeDb();
    db.execute.mockResolvedValue({ rows: [] });
    const storage = new SnapshotStorage(db as unknown as DrizzleDB);
    await expect(storage.loadSnapshot("plugin-a", 1)).resolves.toBeNull();
  });

  it("returns the stored snapshot for a matching (plugin, idx)", async () => {
    const db = makeDb();
    db.execute.mockResolvedValue({ rows: [{ snapshot: SNAPSHOT }] });
    const storage = new SnapshotStorage(db as unknown as DrizzleDB);
    await expect(storage.loadSnapshot("plugin-a", 1)).resolves.toBe(SNAPSHOT);
    const text = sqlText(db.execute.mock.calls[0][0]);
    expect(text).toContain("WHERE plugin_name");
    expect(text).toContain("AND idx");
    expect(db.execute.mock.calls[0][0].values).toEqual(["plugin-a", 1]);
  });

  it("returns null for getLatestSnapshot when no rows exist", async () => {
    const db = makeDb();
    db.execute.mockResolvedValue({ rows: [] });
    const storage = new SnapshotStorage(db as unknown as DrizzleDB);
    await expect(storage.getLatestSnapshot("plugin-a")).resolves.toBeNull();
  });

  it("returns the latest snapshot ordered by idx DESC", async () => {
    const db = makeDb();
    db.execute.mockResolvedValue({ rows: [{ snapshot: SNAPSHOT }] });
    const storage = new SnapshotStorage(db as unknown as DrizzleDB);
    await expect(storage.getLatestSnapshot("plugin-a")).resolves.toBe(SNAPSHOT);
    const text = sqlText(db.execute.mock.calls[0][0]);
    expect(text).toContain("ORDER BY idx DESC");
    expect(text).toContain("LIMIT 1");
  });

  it("returns all snapshots in ascending idx order", async () => {
    const db = makeDb();
    const s1 = { ...SNAPSHOT };
    const s2 = { ...SNAPSHOT };
    db.execute.mockResolvedValue({
      rows: [{ snapshot: s1 }, { snapshot: s2 }],
    });
    const storage = new SnapshotStorage(db as unknown as DrizzleDB);
    await expect(storage.getAllSnapshots("plugin-a")).resolves.toEqual([s1, s2]);
    const text = sqlText(db.execute.mock.calls[0][0]);
    expect(text).toContain("ORDER BY idx ASC");
  });
});
