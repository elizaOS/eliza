// Explicit real-native suite. Missing artifact is an error, never a skipped proof.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSqlCipherTaskProvider } from "../task-sqlcipher.mjs";
import { openTaskDatabase } from "../task-storage.mjs";
import { spawnTestRuntime } from "./test-runtime.mjs";

const buildPath = process.env.ELIZA_TASK_SQLCIPHER_BUILD;
if (!buildPath)
  throw new Error(
    "ELIZA_TASK_SQLCIPHER_BUILD must name the actual native build.json",
  );
const build = JSON.parse(await readFile(buildPath, "utf8"));
const root = await mkdtemp(join(tmpdir(), "task-cipher-real-"));
const canary = `CONTROLLED_TASK_SECRET_${randomBytes(32).toString("hex")}`;
const key = randomBytes(32);
const provider = (value = key) =>
  createSqlCipherTaskProvider({
    libraryPath: build.library,
    sha256: build.sha256,
    machine: build.machine,
    libraryMode: "private-snapshot",
    resolveKey: async () => new Uint8Array(value),
  });
const open = async (path, value = key) =>
  openTaskDatabase({
    databasePath: path,
    requireEncryption: true,
    databaseProvider: provider(value),
  });
const scan = async () => {
  for (const name of await readdir(root)) {
    const file = join(root, name);
    const bytes = await readFile(file);
    assert.equal(
      (await stat(file)).mode & 0o777,
      0o600,
      `Non-private sidecar: ${name}`,
    );
    assert.equal(
      bytes.includes(Buffer.from(canary)),
      false,
      `Plaintext canary in ${name}`,
    );
  }
};

test("actual SQLCipher task driver", async (t) => {
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "tasks.db");
  await t.test(
    "keyed real engine, durable store, WAL and memory-only temp policy",
    async () => {
      const db = await open(path);
      assert.equal(
        db.prepare("PRAGMA cipher_version").get().cipher_version,
        build.pins.sqlcipher.version,
      );
      assert.equal(db.prepare("PRAGMA temp_store").get().temp_store, 2);
      assert.equal(db.prepare("SELECT ? AS value").get(null).value, null);
      assert.equal(db.prepare("PRAGMA synchronous").get().synchronous, 2);
      db.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT); CREATE TEMP TABLE temporary(value TEXT)",
      );
      db.prepare("INSERT INTO records(value) VALUES (?)").run(canary);
      db.prepare("INSERT INTO temporary VALUES (?)").run(canary);
      assert.equal(
        db.prepare("SELECT value FROM records WHERE id=?").get(1).value,
        canary,
      );
      assert.equal(
        db.prepare("SELECT value FROM records WHERE id=?").get(999),
        undefined,
      );
      assert.equal(
        db.prepare("PRAGMA cipher_integrity_check").get(),
        undefined,
      );
      db.prepare("INSERT INTO records(value) VALUES (?)").run("second");
      assert.deepEqual(
        db.prepare("SELECT id, value FROM records ORDER BY id").all(),
        [
          { id: 1, value: canary },
          { id: 2, value: "second" },
        ],
      );
      assert.deepEqual(
        db
          .prepare("SELECT value FROM records WHERE id > ? ORDER BY id DESC")
          .all(1),
        [{ value: "second" }],
      );
      assert.deepEqual(
        db.prepare("SELECT value FROM records WHERE id > ?").all(99),
        [],
      );
      assert.throws(() => db.prepare("SELECT ?").all());
      db.prepare("DELETE FROM records WHERE id = ?").run(2);
      const wal = await readFile(`${path}-wal`);
      assert.ok(wal.length > 32);
      await scan();
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE records SET value=?").run("rolled-back");
      db.exec("ROLLBACK");
      assert.equal(db.prepare("SELECT value FROM records").get().value, canary);
      for (const sql of [
        "PRAGMA cipher_migrate",
        "PRAGMA cipher_memory_security=OFF",
        "PRAGMA key='';",
        "PRAGMA rekey='';",
        "PRAGMA temp_store=FILE",
        "PRAGMA synchronous=OFF",
        "ATTACH DATABASE ':memory:' AS other",
        `VACUUM INTO '${join(root, "plain.db")}'`,
        "SELECT load_extension('no')",
        "SELECT sqlcipher_export('other')",
      ])
        assert.throws(() => db.exec(sql));
      assert.throws(() => db.prepare("SELECT ?; SELECT 2").get(1));
      assert.throws(() => db.prepare("SELECT ?").get(NaN));
      assert.throws(() => db.prepare("SELECT ?").get());
      assert.throws(() => db.prepare("SELECT ?").get({}));
      db.close();
      db.close();
      assert.throws(() => db.exec("SELECT 1"));
      await scan();
      const again = await open(path);
      assert.equal(
        again.prepare("SELECT value FROM records").get().value,
        canary,
      );
      again.close();
    },
  );
  await t.test(
    "wrong key refuses without modifying encrypted source",
    async () => {
      const before = await readFile(path);
      await assert.rejects(open(path, randomBytes(32)), {
        code: "TASK_STORAGE_UNAVAILABLE",
      });
      assert.deepEqual(await readFile(path), before);
    },
  );
  await t.test(
    "ordinary SQLite cannot read ciphertext; plaintext source is refused intact",
    async () => {
      const Database = process.versions.bun
        ? (await import("bun:sqlite")).Database
        : (await import("node:sqlite")).DatabaseSync;
      const unkeyed = new Database(path);
      assert.throws(() => unkeyed.prepare("SELECT * FROM records").get());
      unkeyed.close();
      const plainPath = join(root, "ordinary.db"),
        plain = new Database(plainPath);
      plain.exec(
        "CREATE TABLE existing(value TEXT); INSERT INTO existing VALUES ('preserved')",
      );
      plain.close();
      await chmod(plainPath, 0o600);
      const bytes = await readFile(plainPath);
      await assert.rejects(open(plainPath), {
        code: "TASK_STORAGE_UNAVAILABLE",
      });
      assert.deepEqual(await readFile(plainPath), bytes);
    },
  );
  await t.test(
    "private creation and symlink refusal preserve existing files",
    async () => {
      const exposed = join(root, "exposed.db");
      await writeFile(exposed, "untouched", { mode: 0o644 });
      await chmod(exposed, 0o644);
      await assert.rejects(open(exposed), { code: "TASK_STORAGE_UNAVAILABLE" });
      assert.equal(await readFile(exposed, "utf8"), "untouched");
      await rm(exposed);
      const link = join(root, "symlink.db");
      await symlink(path, link);
      await assert.rejects(open(link), { code: "TASK_STORAGE_UNAVAILABLE" });
      await rm(link);
    },
  );
  await t.test("integrity detects altered ciphertext", async () => {
    const corrupt = join(root, "corrupt.db"),
      bytes = await readFile(path);
    bytes[bytes.length - 40] ^= 1;
    await writeFile(corrupt, bytes, { mode: 0o600 });
    await assert.rejects(open(corrupt), { code: "TASK_STORAGE_UNAVAILABLE" });
  });
  await t.test(
    "committed WAL survives process death, uncommitted canary remains private",
    async () => {
      const crashPath = join(root, "crash.db");
      const child = spawnTestRuntime(
        [
          join(dirname(fileURLToPath(import.meta.url)), "process-death.mjs"),
          buildPath,
          crashPath,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      t.after(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      const exited = once(child, "exit");
      child.stdin.end(JSON.stringify({ key: [...key], canary }));
      let output = "",
        errors = "";
      child.stderr.on("data", (chunk) => (errors += chunk));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error("Controlled child did not reach committed WAL")),
          20000,
        );
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("READY\n")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("exit", () => {
          clearTimeout(timer);
          if (!output.includes("READY\n"))
            reject(new Error(`Controlled child failed: ${errors}`));
        });
      });
      await scan();
      child.kill("SIGKILL");
      await exited;
      const reopened = await open(crashPath);
      assert.equal(
        reopened.prepare("SELECT value FROM records").get().value,
        canary,
      );
      reopened.close();
      await scan();
    },
  );
});
