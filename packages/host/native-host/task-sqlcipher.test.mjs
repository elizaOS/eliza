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
