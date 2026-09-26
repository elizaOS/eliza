/** Exercises real Node/Bun processes against one built SQLite format and atomic legacy migration. */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import type { UUID } from "@elizaos/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SQLiteStorage } from "./storage";

let directory: string;
const agentId = randomUUID() as UUID;
const fixture = fileURLToPath(
  new URL("./__tests__/fixtures/portable-record.mjs", import.meta.url),
);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sqlite-portable-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function child(runtime: string, path: string, mode: string) {
  return execFileSync(runtime, [fixture, path, agentId, mode], {
    encoding: "utf8",
    timeout: 60000,
  });
}
function legacy(path: string, entries: Array<[string, unknown]>) {
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT; CREATE TABLE records(collection TEXT NOT NULL,id TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(collection,id)) STRICT; PRAGMA user_version=1;",
  );
  db.prepare("INSERT INTO metadata VALUES('agent_id',?)").run(agentId);
  for (const [id, value] of entries)
    db.prepare("INSERT INTO records VALUES('probe',?,?)").run(
      id,
      serialize(value),
    );
  db.close();
}

it("moves complete state both directions and retains Bun transaction semantics", () => {
  const nodeFirst = join(directory, "node.sqlite");
  expect(child(process.execPath, nodeFirst, "write")).toContain(
    '"complete":true',
  );
  expect(child("bun", nodeFirst, "exercise")).toContain(
    '"runtime":"bun-1.4.2"',
  );
  expect(child(process.execPath, nodeFirst, "verify")).toContain(
    '"complete":true',
  );
  const bunFirst = join(directory, "bun.sqlite");
  child("bun", bunFirst, "write");
  child(process.execPath, bunFirst, "exercise");
  child("bun", bunFirst, "verify");
}, 120000);

it("migrates existing Node records without changing their values", async () => {
  const path = join(directory, "legacy.sqlite");
  const value = {
    date: new Date("2026-09-23T00:00:00Z"),
    big: 2n ** 90n,
    missing: undefined,
    bytes: Buffer.from([1, 2, 3]),
  };
  legacy(path, [["value", value]]);
  const refused = spawnSync("bun", [fixture, path, agentId, "legacy"], {
    encoding: "utf8",
    timeout: 60000,
  });
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("SQLITE_MIGRATION_REQUIRES_NODE");
  const untouched = new DatabaseSync(path);
  try {
    expect(untouched.prepare("PRAGMA user_version").get()?.user_version).toBe(
      1,
    );
  } finally {
    untouched.close();
  }
  const storage = new SQLiteStorage(path, agentId);
  await storage.init();
  try {
    expect(await storage.get("probe", "value")).toStrictEqual(value);
  } finally {
    await storage.close();
  }
  const db = new DatabaseSync(path);
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
  db.close();
  expect(child("bun", path, "legacy")).toContain('"complete":true');
});

it("rolls every migrated row back when a legacy value cannot be represented", async () => {
  const path = join(directory, "unsupported.sqlite");
  const original = { text: "must remain readable by the old runtime" };
  legacy(path, [
    ["a", original],
    ["z", new Error("unsupported legacy error")],
  ]);
  const storage = new SQLiteStorage(path, agentId);
  await expect(storage.init()).rejects.toMatchObject({
    code: "SQLITE_OPEN_FAILED",
  });
  const db = new DatabaseSync(path);
  try {
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(
      Buffer.from(
        db.prepare("SELECT data FROM records WHERE id='a'").get()
          ?.data as Uint8Array,
      ),
    ).toEqual(serialize(original));
    expect(
      db.prepare("SELECT value FROM metadata WHERE key='record_codec'").get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});

it("does not assign an existing database whose agent binding is missing", async () => {
  const path = join(directory, "missing-owner.sqlite");
  const storage = new SQLiteStorage(path, agentId);
  await storage.init();
  await storage.close();
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM metadata WHERE key='agent_id'");
  db.close();
  await expect(storage.init()).rejects.toMatchObject({
    code: "SQLITE_OPEN_FAILED",
    cause: { code: "SQLITE_AGENT_BINDING_MISSING" },
  });
  const inspection = new DatabaseSync(path);
  try {
    expect(
      inspection
        .prepare("SELECT value FROM metadata WHERE key='agent_id'")
        .get(),
    ).toBeUndefined();
  } finally {
    inspection.close();
  }
});
