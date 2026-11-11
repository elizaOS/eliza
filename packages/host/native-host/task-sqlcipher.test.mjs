import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, {
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createSqlCipherTaskProvider,
  loadTaskSqlCipher,
} from "./task-sqlcipher.mjs";

test("encrypted driver requires explicit absolute artifact, exact hash and independent ABI", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cipher-admission-"));
  t.after(() => rmSync(root, { recursive: true }));
  const path = join(root, "addon.so");
  const bytes = Buffer.alloc(20);
  bytes.set([127, 69, 76, 70, 2, 1]);
  bytes.writeUInt16LE(62, 18);
  writeFileSync(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  for (const options of [
    {},
    { libraryPath: "relative", sha256, machine: 62 },
    { libraryPath: path, sha256: "0".repeat(64), machine: 62 },
    { libraryPath: path, sha256, machine: 183 },
    { libraryPath: path, sha256, machine: 1 },
    { libraryPath: path, sha256, machine: 62 },
  ])
    assert.throws(
      () => loadTaskSqlCipher({ libraryMode: "private-snapshot", ...options }),
      { code: "TASK_STORAGE_UNAVAILABLE" },
    );
  assert.throws(
    () =>
      createSqlCipherTaskProvider({ libraryPath: path, sha256, machine: 62 }),
    { code: "TASK_STORAGE_UNAVAILABLE" },
  );
});

test("failed native loads close descriptors and remove private snapshots", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cipher-failure-"));
  t.after(() => rmSync(root, { recursive: true }));
  const libraryPath = join(root, "broken.so");
  const bytes = Buffer.alloc(20);
  bytes.set([127, 69, 76, 70, 2, 1]);
  bytes.writeUInt16LE(62, 18);
  writeFileSync(libraryPath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const descriptors = readdirSync("/proc/self/fd").length;
  const temporary = readdirSync(tmpdir()).filter((name) =>
    name.startsWith("task-cipher-addon-"),
  );
  for (let attempt = 0; attempt < 10; attempt++)
    assert.throws(
      () =>
        loadTaskSqlCipher({
          libraryPath,
          sha256,
          machine: 62,
          libraryMode: "private-snapshot",
        }),
      { code: "TASK_STORAGE_UNAVAILABLE" },
    );
  assert.equal(readdirSync("/proc/self/fd").length, descriptors);
  assert.deepEqual(
    readdirSync(tmpdir()).filter((name) =>
      name.startsWith("task-cipher-addon-"),
    ),
    temporary,
  );
  const link = join(root, "link.so");
  symlinkSync(libraryPath, link);
  assert.throws(
    () =>
      loadTaskSqlCipher({
        libraryPath: link,
        sha256,
        machine: 62,
        libraryMode: "private-snapshot",
      }),
    { code: "TASK_STORAGE_UNAVAILABLE" },
  );
  assert.throws(
    () =>
      loadTaskSqlCipher({
        libraryPath,
        sha256,
        machine: 62,
        libraryMode: "installed-readonly",
      }),
    { code: "TASK_STORAGE_UNAVAILABLE" },
  );
});

test("installed artifacts reject a different unprivileged owner before native loading", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cipher-owner-"));
  t.after(() => rmSync(root, { recursive: true }));
  const libraryPath = join(root, "addon.so");
  const bytes = Buffer.alloc(20);
  bytes.set([127, 69, 76, 70, 2, 1]);
  bytes.writeUInt16LE(62, 18);
  writeFileSync(libraryPath, bytes, { mode: 0o444 });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const originalGetuid = process.getuid;
  const originalDlopen = process.dlopen;
  const originalFstat = fs.fstatSync;
  let loaded = false;
  // Model the consuming application as another unprivileged identity. The file
  // still belongs to its untrusted non-root owner, who can rewrite its inode.
  process.getuid = () => 1002;
  fs.fstatSync = (...args) =>
    Object.assign(originalFstat(...args), { uid: 1001 });
  syncBuiltinESMExports();
  process.dlopen = (addon) => {
    loaded = true;
    addon.exports = Object.fromEntries(
      ["open", "exec", "query", "close", "verify"].map((name) => [
        name,
        () => {},
      ]),
    );
  };
  try {
    assert.throws(
      () =>
        loadTaskSqlCipher({
          libraryPath,
          sha256,
          machine: 62,
          libraryMode: "installed-readonly",
        }),
      { code: "TASK_STORAGE_UNAVAILABLE" },
    );
    assert.equal(loaded, false);
  } finally {
    process.getuid = originalGetuid;
    process.dlopen = originalDlopen;
    fs.fstatSync = originalFstat;
    syncBuiltinESMExports();
  }
});

test("Android-installed libraries admit only an installer-owned file the app cannot rewrite", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cipher-android-"));
  t.after(() => rmSync(root, { recursive: true }));
  const libraryPath = join(root, "libeliza_task_sqlcipher.so");
  const bytes = Buffer.alloc(20);
  bytes.set([127, 69, 76, 70, 2, 1]);
  bytes.writeUInt16LE(183, 18);
  writeFileSync(libraryPath, bytes, { mode: 0o755 });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const originalGetuid = process.getuid;
  const originalDlopen = process.dlopen;
  const originalFstat = fs.fstatSync;
  let owner = 1000,
    mode = 0o100755,
    loads = 0;
  process.getuid = () => 10123;
  fs.fstatSync = (...args) =>
    Object.assign(originalFstat(...args), { uid: owner, mode });
  syncBuiltinESMExports();
  const exports = Object.fromEntries(
    [
      "acquireLease",
      "releaseLease",
      "open",
      "exec",
      "query",
      "queryAll",
      "close",
      "verify",
    ].map((name) => [name, () => {}]),
  );
  process.dlopen = (addon) => {
    loads++;
    addon.exports = exports;
  };
  const load = () =>
    loadTaskSqlCipher({
      libraryPath,
      sha256,
      machine: 183,
      libraryMode: "android-installed",
    });
  try {
    // The app's own file, another app's file and a group- or world-writable file are refused.
    for (const [uid, bits] of [
      [10123, 0o100755],
      [10200, 0o100755],
      [1000, 0o100775],
      [1000, 0o100757],
    ]) {
      owner = uid;
      mode = bits;
      assert.throws(load, { code: "TASK_STORAGE_UNAVAILABLE" });
    }
    process.getuid = () => 0;
    owner = 1000;
    mode = 0o100755;
    assert.throws(load, { code: "TASK_STORAGE_UNAVAILABLE" });
    assert.equal(loads, 0);
    process.getuid = () => 10123;
    assert.equal(load(), exports);
    assert.equal(loads, 1);
  } finally {
    process.getuid = originalGetuid;
    process.dlopen = originalDlopen;
    fs.fstatSync = originalFstat;
    syncBuiltinESMExports();
  }
});

test("provider reads every row through the guarded native queryAll", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cipher-rows-"));
  t.after(() => rmSync(root, { recursive: true }));
  fs.chmodSync(root, 0o700);
  const libraryPath = join(root, "libeliza_task_sqlcipher.so");
  const bytes = Buffer.alloc(24);
  bytes.set([127, 69, 76, 70, 2, 1]);
  bytes.writeUInt16LE(183, 18);
  bytes.writeUInt32LE(7, 20);
  writeFileSync(libraryPath, bytes, { mode: 0o755 });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const originalDlopen = process.dlopen;
  const originalFstat = fs.fstatSync;
  const uid = process.getuid();
  fs.fstatSync = (...args) => {
    const metadata = originalFstat(...args);
    // Only the library is installer-owned; the database stays the caller's own.
    return metadata.size === 24
      ? Object.assign(metadata, { uid: uid === 1000 ? 1001 : 1000 })
      : metadata;
  };
  syncBuiltinESMExports();
  const calls = [];
  let current = true;
  let refuseByReturn = false;
  let retireAfterRead = false;
  let retireAfterWrite = false;
  let failClose = false;
  let closes = 0;
  const retired = new Error("retired");
  process.dlopen = (addon) => {
    addon.exports = {
      acquireLease: () => ({ lease: true }),
      releaseLease: () => {},
      // The loader is controlled. The operation and file effects are real
      // SQLite here. This fixture makes no encryption claim.
      open: (path) => new DatabaseSync(path),
      exec: (database, sql) => {
        database.exec(sql);
        if (retireAfterWrite) current = false;
      },
      query: () => undefined,
      queryAll: (database, sql, params) => {
        calls.push({ sql, params });
        const rows = database.prepare(sql).all(...params);
        if (retireAfterRead) current = false;
        return rows.map((row) => ({ ...row }));
      },
      close: (database) => {
        if (failClose) throw new Error("fixture close refused");
        database.close();
        closes++;
      },
      verify: () => false,
    };
  };
  try {
    const provider = createSqlCipherTaskProvider({
      libraryPath,
      sha256,
      machine: 183,
      libraryMode: "android-installed",
      resolveKey: async () => new Uint8Array(32).fill(7),
      checkOwner: () => {
        if (current) return;
        if (refuseByReturn) return false;
        throw retired;
      },
    });
    const path = join(root, "tasks.sqlite");
    const db = await provider.open({ path });
    t.after(() => {
      failClose = false;
      db.close();
    });
    db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY)");
    db.exec("INSERT INTO records (id) VALUES (1), (2)");
    const statement = db.prepare(
      "SELECT id FROM records WHERE id > ? ORDER BY id",
    );
    assert.deepEqual(statement.all(0), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(calls[0], {
      sql: "SELECT id FROM records WHERE id > ? ORDER BY id",
      params: [0],
    });
    const refusesRetiredOwner = (error) =>
      error.code === "TASK_STORAGE_UNAVAILABLE" && error.cause === retired;
    current = false;
    assert.throws(() => statement.all(0), refusesRetiredOwner);
    assert.throws(
      () => db.exec("INSERT INTO records (id) VALUES (0)"),
      refusesRetiredOwner,
    );
    refuseByReturn = true;
    assert.throws(
      () => statement.all(0),
      (error) =>
        error.code === "TASK_STORAGE_UNAVAILABLE" && error.cause === undefined,
    );
    refuseByReturn = false;
    assert.equal(calls.length, 1);
    current = true;
    retireAfterRead = true;
    assert.throws(() => statement.all(0), refusesRetiredOwner);
    assert.equal(calls.length, 2);

    current = true;
    retireAfterWrite = true;
    assert.throws(
      () => db.exec("INSERT INTO records (id) VALUES (3)"),
      refusesRetiredOwner,
    );
    failClose = true;
    assert.throws(() => db.close(), /fixture close refused/);
    assert.equal(closes, 0);
    failClose = false;
    db.close();
    db.close();
    assert.equal(closes, 1);
    assert.throws(() => statement.all(0), {
      code: "TASK_STORAGE_UNAVAILABLE",
    });
    const durable = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(
        durable
          .prepare("SELECT id FROM records ORDER BY id")
          .all()
          .map((row) => row.id),
        [1, 2, 3],
      );
    } finally {
      durable.close();
    }
  } finally {
    process.dlopen = originalDlopen;
    fs.fstatSync = originalFstat;
    syncBuiltinESMExports();
  }
});
