import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openTaskDatabase } from "./task-storage.mjs";

const temporary = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "task-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "account", "tasks.sqlite");
};
test("encrypted policy without complete provider writes nothing and never opens SQLite", async (t) => {
  const path = await temporary(t);
  let opened = false;
  for (const provider of [
    undefined,
    {},
    {
      open: () => {
        opened = true;
      },
    },
  ])
    await assert.rejects(
      openTaskDatabase({
        databasePath: path,
        requireEncryption: true,
        databaseProvider: provider,
      }),
      { code: "TASK_STORAGE_UNAVAILABLE" },
    );
  assert.equal(opened, false);
  await assert.rejects(access(path));
});
test("legacy profile retains durable SQLite behavior and private permissions", async (t) => {
  const path = await temporary(t);
  const db = await openTaskDatabase({
    databasePath: relative(process.cwd(), path),
  });
  db.exec(
    "CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('controlled')",
  );
  db.close();
  const again = await openTaskDatabase({ databasePath: path });
  assert.equal(
    again.prepare("SELECT value FROM sample").get().value,
    "controlled",
  );
  again.close();
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
test("provider refusal closes before task writes without exposing diagnostics or deleting data", async (t) => {
  const path = await temporary(t);
  let closed = false;
  const provider = {
    open: ({ path }) => {
      const db = new DatabaseSync(path);
      const close = db.close.bind(db);
      db.close = () => {
        closed = true;
        close();
      };
      return db;
    },
    assertEncryption: () => {
      throw new Error("private-key-material");
    },
  };
  const error = await openTaskDatabase({
    databasePath: path,
    requireEncryption: true,
    databaseProvider: provider,
  }).catch((e) => e);
  assert.equal(error.code, "TASK_STORAGE_UNAVAILABLE");
  assert.equal(closed, true);
  assert.ok(!String(error).includes("private-key"));
  assert.equal((await readFile(path)).length, 0);
});
test("provider acknowledgement precedes SQL; false/truthy objects never count as verification", async (t) => {
  for (const answer of [undefined, false, "true", { encrypted: true }]) {
    const path = await temporary(t);
    let writes = 0;
    const provider = {
      open: () => ({
        exec: () => writes++,
        prepare: () => {},
        close: () => {},
      }),
      assertEncryption: async () => answer,
    };
    await assert.rejects(
      openTaskDatabase({
        databasePath: path,
        requireEncryption: true,
        databaseProvider: provider,
      }),
    );
    assert.equal(writes, 0);
  }
});
test("trusted provider verification is called before the first write (contract stub, not crypto proof)", async (t) => {
  const path = await temporary(t),
    events = [];
  const provider = {
    open: ({ path }) => {
      events.push("open");
      const db = new DatabaseSync(path);
      const exec = db.exec.bind(db);
      db.exec = (sql) => {
        events.push("sql");
        return exec(sql);
      };
      return db;
    },
    assertEncryption: async () => {
      events.push("verify");
      return true;
    },
  };
  const db = await openTaskDatabase({
    databasePath: path,
    requireEncryption: true,
    databaseProvider: provider,
  });
  db.close();
  assert.deepEqual(events, ["open", "verify", "sql"]);
});

test("null provider and unusable directory return only fixed admission errors", async (t) => {
  const path = await temporary(t);
  await assert.rejects(
    openTaskDatabase({ databasePath: path, databaseProvider: null }),
    { code: "TASK_STORAGE_UNAVAILABLE" },
  );
  const root = await mkdtemp(join(tmpdir(), "task-storage-denied-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "private-parent");
  await writeFile(parent, "preserve original");
  const error = await openTaskDatabase({
    databasePath: join(parent, "db"),
  }).catch((value) => value);
  assert.equal(error.code, "TASK_STORAGE_UNAVAILABLE");
  assert.ok(!String(error).includes(parent));
  assert.equal(await readFile(parent, "utf8"), "preserve original");
});
