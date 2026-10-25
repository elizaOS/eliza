// Explicit actual-native qualification; missing build artifact fails, never skips.
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createSqlCipherTaskProvider,
  loadTaskSqlCipher,
} from "../task-sqlcipher.mjs";
import { spawnTestRuntime } from "./test-runtime.mjs";

const buildPath = process.env.ELIZA_TASK_SQLCIPHER_BUILD;
if (!buildPath) throw Error("Explicit native build required");
const build = JSON.parse(await readFile(buildPath, "utf8"));
const options = {
  libraryPath: build.library,
  sha256: build.sha256,
  machine: build.machine,
  libraryMode: "private-snapshot",
};
const key = () => new Uint8Array(32).fill(19);
const provider = (extra = {}) =>
  createSqlCipherTaskProvider({ ...options, resolveKey: key, ...extra });
const worker = fileURLToPath(new URL("./lease-worker.mjs", import.meta.url));
const stop = (pid) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
};
async function child(mode, path) {
  const child = spawnTestRuntime([worker, mode, buildPath, path], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    errors = "";
  child.stderr.on("data", (b) => (errors += b));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Writer readiness timed out")),
      10000,
    );
    child.stdout.on("data", (b) => {
      output += b;
      const match = output.match(/(?:READY|EXEC_CHILD) (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      if (code && !output) {
        clearTimeout(timer);
        reject(Error(`Writer failed: ${errors}`));
      }
    });
  });
  try {
    return { child, pid: await ready };
  } catch (e) {
    stop(child.pid);
    throw e;
  }
}
async function reopen(path) {
  const end = Date.now() + 5000;
  while (true) {
    try {
      return await provider().open({ path });
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}
test("actual SQLCipher writer lease", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "task-writer-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await t.test(
    "one writer before key retrieval; close reuses persistent inode",
    async () => {
      const path = join(root, "single.db");
      const db = await provider().open({ path });
      db.exec("CREATE TABLE test(value INTEGER)");
      const before = await stat(path + ".writer.lock");
      let keyCalls = 0;
      await assert.rejects(
        provider({
          resolveKey: () => {
            keyCalls++;
            return key();
          },
        }).open({ path }),
      );
      assert.equal(keyCalls, 0);
      db.close();
      const next = await provider().open({ path });
      next.close();
      const after = await stat(path + ".writer.lock");
      assert.equal(after.ino, before.ino);
      assert.equal(after.mode & 0o777, 0o600);
    },
  );
  await t.test(
    "all admission failures release; retirement wipes fetched key",
    async () => {
      const path = join(root, "failure.db");
      let calls = 0;
      await assert.rejects(
        provider({
          checkOwner: () => {
            throw Error("wrong owner");
          },
          resolveKey: () => {
            calls++;
            return key();
          },
        }).open({ path }),
      );
      assert.equal(calls, 0);
      await assert.rejects(stat(`${path}.writer.lock`), { code: "ENOENT" });
      await assert.rejects(
        provider({
          resolveKey: () => {
            throw Error("synthetic unavailable");
          },
        }).open({ path }),
      );
      await assert.rejects(stat(path), { code: "ENOENT" });
      let retired = false;
      const transferred = key();
      await assert.rejects(
        provider({
          checkOwner: () => {
            if (retired) throw Error("retired");
          },
          resolveKey: () => {
            retired = true;
            return transferred;
          },
        }).open({ path }),
      );
      assert.ok(transferred.every((v) => v === 0));
      let db = await provider().open({ path });
      db.exec("CREATE TABLE test(value INTEGER)");
      db.close();
      await assert.rejects(
        provider({ resolveKey: () => new Uint8Array(32).fill(7) }).open({
          path,
        }),
      );
      db = await provider().open({ path });
      db.close();
    },
  );
  await t.test(
    "rename fences old handle while close releases it; symlink and modes refused",
    async () => {
      const path = join(root, "rename.db");
      const db = await provider().open({ path });
      db.exec("CREATE TABLE test(value INTEGER)");
      const lock = path + ".writer.lock";
      await rename(lock, lock + ".old");
      await writeFile(lock, "", { mode: 0o600 });
      assert.throws(() => db.exec("INSERT INTO test VALUES(1)"));
      db.close();
      const next = await provider().open({ path });
      next.close();
      await rm(lock);
      await symlink(lock + ".old", lock);
      await assert.rejects(provider().open({ path }));
      await rm(lock);
      await writeFile(lock, "", { mode: 0o644 });
      await chmod(lock, 0o644);
      await assert.rejects(provider().open({ path }));
      await chmod(lock, 0o600);
      (await provider().open({ path })).close();
    },
  );
  await t.test(
    "native hardlink refusal when the OS permits fixture creation",
    async (t) => {
      const path = join(root, "hardlink.db");
      const lock = `${path}.writer.lock`;
      const original = `${lock}.original`;
      await writeFile(original, "", { mode: 0o600 });
      try {
        await link(original, lock);
      } catch (error) {
        if (error.code !== "EACCES" && error.code !== "EPERM") throw error;
        console.info(
          `QUALIFICATION_SKIP native-hardlink-guard: OS refused fixture (${error.code})`,
        );
        t.skip(
          `OS refused hardlink fixture (${error.code}); native hardlink guard not exercised`,
        );
        return;
      }
      await assert.rejects(provider().open({ path }));
    },
  );
  await t.test(
    "post-open retirement releases and post-write refusal does not imply rollback",
    async () => {
      const path = join(root, "retirement.db");
      let checks = 0;
      const transferred = key();
      await assert.rejects(
        provider({
          resolveKey: () => transferred,
          checkOwner: () => {
            if (++checks === 4) throw Error("retired after open");
          },
        }).open({ path }),
      );
      assert.ok(transferred.every((v) => v === 0));
      const db = await provider().open({ path });
      db.exec("CREATE TABLE test(value INTEGER)");
      db.close();
      checks = 0;
      const writer = await provider({
        checkOwner: () => {
          if (++checks === 6) throw Error("retired after write");
        },
      }).open({ path });
      assert.throws(() => writer.exec("INSERT INTO test VALUES(1)"));
      writer.close();
      const next = await provider().open({ path });
      assert.equal(
        next.prepare("SELECT count(*) AS count FROM test").get().count,
        1,
      );
      next.close();
    },
  );
  await t.test("lease native handle is path-bound and single-use", async () => {
    const native = loadTaskSqlCipher(options),
      path = join(root, "handle.db"),
      lease = native.acquireLease(path);
    try {
      assert.throws(() => native.open(join(root, "wrong.db"), key(), lease));
      const handle = native.open(path, key(), lease);
      assert.throws(() => native.open(path, key(), lease));
      native.releaseLease(lease);
      assert.throws(() => native.acquireLease(path));
      native.close(handle);
    } finally {
      native.releaseLease(lease);
    }
  });
  await t.test(
    "killed broker leaves orphan writer lease held; killing writer permits recovery",
    async () => {
      const path = join(root, "orphan.db");
      const { child: broker, pid: writer } = await child("broker", path);
      try {
        const exit = once(broker, "exit");
        stop(broker.pid);
        await exit;
        await assert.rejects(provider().open({ path }));
        stop(writer);
        (await reopen(path)).close();
      } finally {
        stop(writer);
        stop(broker.pid);
      }
    },
  );
  await t.test(
    "actual writer death releases lease; CLOEXEC child cannot retain it",
    async () => {
      let path = join(root, "death.db");
      let running = await child("writer", path);
      try {
        const exit = once(running.child, "exit");
        stop(running.pid);
        await exit;
        (await reopen(path)).close();
      } finally {
        stop(running.pid);
      }
      path = join(root, "exec.db");
      running = await child("exec-child", path);
      try {
        if (running.child.exitCode === null) await once(running.child, "exit");
        (await reopen(path)).close();
      } finally {
        stop(running.pid);
        stop(running.child.pid);
      }
    },
  );
});
