import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { withDeviceInstallLock } from "../android/install-lock.mjs";
import { openInstallJournal } from "../android/install-release.mjs";

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-lock-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("journal creation flushes its data and every ancestor before returning", (t) => {
  const root = directory(t);
  const parent = path.join(root, "new", "attempt");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const file = path.join(parent, "journal.jsonl");
  const opened = new Map();
  const flushed = [];
  const open = fs.openSync;
  const sync = fs.fsyncSync;
  t.mock.method(fs, "openSync", (...args) => {
    const fd = open(...args);
    opened.set(fd, args[0]);
    return fd;
  });
  t.mock.method(fs, "fsyncSync", (fd) => {
    flushed.push(opened.get(fd));
    sync(fd);
  });
  const authorization = { event: "authorized", serial: "SERIAL" };
  const fd = openInstallJournal(file, authorization);
  try {
    const expected = [file];
    let current = parent;
    while (true) {
      expected.push(current);
      if (path.dirname(current) === current) break;
      current = path.dirname(current);
    }
    assert.deepEqual(flushed, expected);
    assert.equal(fs.fstatSync(fd).mode & 0o777, 0o600);
    assert.equal(
      fs.readFileSync(file, "utf8"),
      `${JSON.stringify(authorization)}\n`,
    );
    assert.throws(() => openInstallJournal(file, {}), { code: "EEXIST" });
  } finally {
    fs.closeSync(fd);
  }
});

test("directory flush failure closes the journal and prevents device admission", (t) => {
  const root = directory(t);
  const file = path.join(root, "journal.jsonl");
  const failure = Object.assign(new Error("fixture directory sync failure"), {
    code: "EIO",
  });
  const open = fs.openSync;
  const sync = fs.fsyncSync;
  let journal;
  t.mock.method(fs, "openSync", (...args) => {
    const fd = open(...args);
    if (args[0] === file) journal = fd;
    return fd;
  });
  let fail = true;
  t.mock.method(fs, "fsyncSync", (fd) => {
    if (fail && fs.fstatSync(fd).isDirectory()) {
      fail = false;
      throw failure;
    }
    sync(fd);
  });
  assert.throws(
    () => openInstallJournal(file, { event: "authorized" }),
    (error) => error === failure,
  );
  assert.throws(() => fs.fstatSync(journal), { code: "EBADF" });
  fail = true;
  let admitted = false;
  assert.throws(
    () =>
      withDeviceInstallLock(
        "SERIAL",
        {},
        () => {
          admitted = true;
        },
        root,
      ),
    (error) => error === failure,
  );
  assert.equal(admitted, false);
  assert.equal(fs.readFileSync(file, "utf8"), '{"event":"authorized"}\n');
});

test("same serial is exclusive across processes; other serials remain independent", (t) => {
  const root = directory(t);
  withDeviceInstallLock(
    "SERIAL",
    {},
    () => {
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {withDeviceInstallLock} from ${JSON.stringify(new URL("../android/install-lock.mjs", import.meta.url).href)}; withDeviceInstallLock("SERIAL", {}, () => {}, process.argv[1]);`,
          root,
        ],
        { encoding: "utf8" },
      );
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /device installation locked/);
      withDeviceInstallLock("OTHER", {}, () => {}, root);
    },
    root,
  );
  assert.deepEqual(fs.readdirSync(root), []);
  withDeviceInstallLock(
    "SERIAL",
    {},
    ({ beforeWrites }) => beforeWrites(),
    root,
  );
  assert.deepEqual(fs.readdirSync(root), []);
});

test("preflight failure releases lock, but failed writes persist and block retries", (t) => {
  const root = directory(t);
  assert.throws(
    () =>
      withDeviceInstallLock(
        "SERIAL",
        {},
        () => {
          throw new Error("preflight failed");
        },
        root,
      ),
    /preflight failed/,
  );
  assert.deepEqual(fs.readdirSync(root), []);
  assert.throws(
    () =>
      withDeviceInstallLock(
        "SERIAL",
        { journal: "/private/journal" },
        ({ beforeWrites }) => {
          beforeWrites();
          throw new Error("USB disconnected");
        },
        root,
      ),
    /USB disconnected/,
  );
  const lock = path.join(root, fs.readdirSync(root)[0]);
  assert.equal(fs.statSync(lock).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(lock, "utf8"), /writes-started/);
  assert.throws(
    () =>
      withDeviceInstallLock(
        "SERIAL",
        {},
        () => {
          assert.fail("must not retry");
        },
        root,
      ),
    /device installation locked/,
  );
});

test("killed writer leaves an interlock instead of automatically resuming a partial install", (t) => {
  const root = directory(t);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {withDeviceInstallLock} from ${JSON.stringify(new URL("../android/install-lock.mjs", import.meta.url).href)}; withDeviceInstallLock("SERIAL", {}, ({beforeWrites}) => { beforeWrites(); process.kill(process.pid, "SIGKILL"); }, process.argv[1]);`,
      root,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.signal, "SIGKILL");
  assert.throws(
    () =>
      withDeviceInstallLock(
        "SERIAL",
        {},
        () => {
          assert.fail("must not run");
        },
        root,
      ),
    /device installation locked/,
  );
});

test("unsafe lock directory and replaced lock fail closed", (t) => {
  const root = directory(t);
  fs.chmodSync(root, 0o755);
  assert.throws(
    () => withDeviceInstallLock("SERIAL", {}, () => {}, root),
    /private/,
  );
  fs.chmodSync(root, 0o700);
  const link = path.join(root, "link");
  fs.symlinkSync(root, link);
  assert.throws(
    () => withDeviceInstallLock("SERIAL", {}, () => {}, link),
    /private/,
  );
  fs.unlinkSync(link);
  assert.throws(
    () =>
      withDeviceInstallLock(
        "SERIAL",
        {},
        () => {
          const file = path.join(root, fs.readdirSync(root)[0]);
          fs.renameSync(file, `${file}.old`);
          fs.writeFileSync(file, "replacement");
        },
        root,
      ),
    /identity changed/,
  );
  assert.equal(fs.readdirSync(root).length, 2);
});
