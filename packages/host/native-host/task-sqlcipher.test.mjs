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
  process.dlopen = (addon) => {
    addon.exports = {
      acquireLease: () => ({ lease: true }),
      releaseLease: () => {},
      open: () => ({ handle: true }),
      exec: () => {},
      query: () => undefined,
      queryAll: (...args) => {
        calls.push(args);
        return [{ id: 1 }, { id: 2 }];
      },
      close: () => {},
      verify: () => true,
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
        if (!current) throw new Error("retired");
      },
    });
    const db = await provider.open({ path: join(root, "tasks.sqlite") });
    const statement = db.prepare("SELECT id FROM records WHERE id > ?");
    assert.deepEqual(statement.all(0), [{ id: 1 }, { id: 2 }]);
    assert.equal(calls[0][1], "SELECT id FROM records WHERE id > ?");
    assert.deepEqual(calls[0][2], [0]);
    current = false;
    assert.throws(() => statement.all(0), {
      code: "TASK_STORAGE_UNAVAILABLE",
    });
    assert.equal(calls.length, 1);
    current = true;
    db.close();
    assert.throws(() => statement.all(0), {
      code: "TASK_STORAGE_UNAVAILABLE",
    });
  } finally {
    process.dlopen = originalDlopen;
    fs.fstatSync = originalFstat;
    syncBuiltinESMExports();
  }
});
