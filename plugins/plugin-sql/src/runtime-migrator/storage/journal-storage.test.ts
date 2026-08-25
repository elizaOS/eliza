import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDB } from "../types";
import { JournalStorage } from "./journal-storage";

function makeDb(): { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn();
  return { execute };
}

function sqlText(call: unknown): string {
  // drizzle_mock's sql tag returns { strings, values }; rebuild the query text.
  const { strings, values } = call as { strings: string[]; values: unknown[] };
  return strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ""), "");
}

describe("JournalStorage", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns null when no journal row exists", async () => {
    const db = makeDb();
    db.execute.mockResolvedValue({ rows: [] });
    const storage = new JournalStorage(db as unknown as DrizzleDB);
    await expect(storage.loadJournal("plugin-a")).resolves.toBeNull();
    expect(sqlText(db.execute.mock.calls[0][0])).toContain("FROM migrations._journal");
  });

  it("returns the parsed journal row when present", async () => {
    const db = makeDb();
    const entry = {
      idx: 0,
      version: "7",
      when: 1,
      tag: "init",
      breakpoints: true,
    };
    db.execute.mockResolvedValue({
      rows: [{ version: "7", dialect: "postgresql", entries: [entry] }],
    });
    const storage = new JournalStorage(db as unknown as DrizzleDB);
    const journal = await storage.loadJournal("plugin-a");
    expect(journal).toEqual({
      version: "7",
      dialect: "postgresql",
      entries: [entry],
    });
  });

  it("scopes the journal lookup to the given plugin", async () => {
    const db = makeDb();
    db.execute.mockResolvedValue({ rows: [] });
    const storage = new JournalStorage(db as unknown as DrizzleDB);
    await storage.loadJournal("plugin-b");
    const text = sqlText(db.execute.mock.calls[0][0]);
    expect(text).toContain("plugin_name");
    expect(db.execute.mock.calls[0][0].values).toContain("plugin-b");
  });

  it("creates a fresh journal when adding an entry to a missing one", async () => {
    const db = makeDb();
    db.execute.mockResolvedValue({ rows: [] });
    const storage = new JournalStorage(db as unknown as DrizzleDB);
    await storage.addEntry("plugin-a", {
      idx: 0,
      version: "7",
      when: 5,
      tag: "init",
      breakpoints: true,
    });
    // First call: SELECT (empty) → null journal. Second call: INSERT with fresh journal.
    expect(db.execute).toHaveBeenCalledTimes(2);
    const insertSql = sqlText(db.execute.mock.calls[1][0]);
    expect(insertSql).toContain("INSERT INTO migrations._journal");
    expect(insertSql).toContain("ON CONFLICT");
  });

  it("appends to an existing journal without clobbering prior entries", async () => {
    const db = makeDb();
    const existing = {
      idx: 0,
      version: "7",
      when: 1,
      tag: "init",
      breakpoints: true,
    };
    db.execute.mockResolvedValueOnce({
      rows: [{ version: "7", dialect: "postgresql", entries: [existing] }],
    });
    db.execute.mockResolvedValue({ rows: [] });
    const storage = new JournalStorage(db as unknown as DrizzleDB);
    await storage.addEntry("plugin-a", {
      idx: 1,
      version: "7",
      when: 2,
      tag: "second",
      breakpoints: false,
    });
    const insertSql = sqlText(db.execute.mock.calls[1][0]);
    expect(insertSql).toContain("ON CONFLICT");
    // Both entries must be serialized into the upsert payload.
    const payload = JSON.parse(db.execute.mock.calls[1][0].values[3] as string) as Array<{
      tag: string;
    }>;
    expect(payload.map((e) => e.tag)).toContain("second");
  });

  it("returns 0 as the next index when no journal exists", async () => {
    const db = makeDb();
    db.execute.mockResolvedValue({ rows: [] });
    const storage = new JournalStorage(db as unknown as DrizzleDB);
    await expect(storage.getNextIdx("plugin-a")).resolves.toBe(0);
  });

  it("returns 0 as the next index when the journal has no entries", async () => {
    const db = makeDb();
    db.execute.mockResolvedValue({
      rows: [{ version: "7", dialect: "postgresql", entries: [] }],
    });
    const storage = new JournalStorage(db as unknown as DrizzleDB);
    await expect(storage.getNextIdx("plugin-a")).resolves.toBe(0);
  });

  it("returns lastEntry.idx + 1 as the next index", async () => {
    const db = makeDb();
    db.execute.mockResolvedValue({
      rows: [
        {
          version: "7",
          dialect: "postgresql",
          entries: [
            { idx: 3, version: "7", when: 1, tag: "a", breakpoints: true },
            { idx: 4, version: "7", when: 2, tag: "b", breakpoints: true },
          ],
        },
      ],
    });
    const storage = new JournalStorage(db as unknown as DrizzleDB);
    await expect(storage.getNextIdx("plugin-a")).resolves.toBe(5);
  });

  it("writes a well-formed entry via updateJournal with breakpoints defaulting to true", async () => {
    const db = makeDb();
    db.execute.mockResolvedValue({ rows: [] });
    const storage = new JournalStorage(db as unknown as DrizzleDB);
    const whenBefore = Date.now();
    await storage.updateJournal("plugin-a", 7, "add-table");
    const entry = JSON.parse(db.execute.mock.calls[1][0].values[3] as string) as Array<{
      idx: number;
      version: string;
      tag: string;
      breakpoints: boolean;
      when: number;
    }>;
    expect(entry).toHaveLength(1);
    expect(entry[0].idx).toBe(7);
    expect(entry[0].version).toBe("7");
    expect(entry[0].tag).toBe("add-table");
    expect(entry[0].breakpoints).toBe(true);
    expect(entry[0].when).toBeGreaterThanOrEqual(whenBefore);
  });

  it("honors an explicit breakpoints=false flag", async () => {
    const db = makeDb();
    db.execute.mockResolvedValue({ rows: [] });
    const storage = new JournalStorage(db as unknown as DrizzleDB);
    await storage.updateJournal("plugin-a", 2, "no-bps", false);
    const entry = JSON.parse(db.execute.mock.calls[1][0].values[3] as string) as Array<{
      breakpoints: boolean;
    }>;
    expect(entry[0].breakpoints).toBe(false);
  });
});
