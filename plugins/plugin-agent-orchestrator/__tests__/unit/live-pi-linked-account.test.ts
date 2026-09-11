/** Exercises live-harness admission and owned child cleanup with real keyless subprocesses; no provider is contacted. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { runOwnedChild } from "../../scripts/live-pi-linked-account.mjs";

const script = fileURLToPath(
  new URL("../../scripts/live-pi-linked-account.mjs", import.meta.url),
);
test("selected live check fails when its credential is absent and emits no success receipt", () => {
  const result = spawnSync(process.execPath, [script], {
    env: { PATH: process.env.PATH, RUN_LIVE_PI_LINKED_ACCOUNT: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /failed during admission/);
});
test("live credentials alone do not arm a provider request", () => {
  const result = spawnSync(process.execPath, [script], {
    env: {
      PATH: process.env.PATH,
      OPENROUTER_API_KEY: "synthetic-not-a-provider-key",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(!result.stderr.includes("synthetic-not-a-provider-key"));
});
test.skipIf(process.platform === "win32")(
  "owned child records completion and exits naturally",
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-parent-test-"));
    try {
      const file = path.join(dir, "complete");
      const result = await runOwnedChild(
        process.execPath,
        [
          "-e",
          'require("node:fs").writeFileSync(process.argv[1], "done")',
          file,
        ],
        { env: { PATH: process.env.PATH } },
        5_000,
      );
      assert.equal(result.code, 0);
      assert.equal(await readFile(file, "utf8"), "done");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test.skipIf(process.platform === "win32")(
  "owned deadline kills a signal-resistant child and rejects instead of hanging",
  async () => {
    const start = Date.now();
    await assert.rejects(
      runOwnedChild(
        process.execPath,
        ["-e", 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],
        { env: { PATH: process.env.PATH } },
        200,
      ),
      /owned-process deadline/,
    );
    assert.ok(Date.now() - start < 6_000);
  },
);

test("internal child cannot write to a profile without parent authorization", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-child-guard-"));
  try {
    const result = spawnSync(process.execPath, [script, "--child"], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        ELIZA_HOME: root,
        RUN_LIVE_PI_LINKED_ACCOUNT: "1",
        OPENROUTER_API_KEY: "synthetic-not-a-provider-key",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    await assert.rejects(readFile(path.join(root, "failure.json")), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(path.join(root, "receipt.json")), {
      code: "ENOENT",
    });
    assert.ok(!result.stderr.includes("synthetic-not-a-provider-key"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed admission writes only a sanitized failure receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-failure-receipt-"));
  try {
    const result = spawnSync(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
        RUN_LIVE_PI_LINKED_ACCOUNT: "1",
        LIVE_PI_EVIDENCE_DIR: root,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    const receipt = JSON.parse(
      await readFile(path.join(root, "receipt.json"), "utf8"),
    );
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.phase, "admission");
    assert.ok(!JSON.stringify(receipt).includes(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "parent kills retained descendants and rejects incomplete natural cleanup",
  async () => {
    await assert.rejects(
      runOwnedChild(
        process.execPath,
        [
          "-e",
          `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); child.unref();`,
        ],
        { env: { PATH: process.env.PATH } },
        5_000,
      ),
      /retained descendants/,
    );
  },
);

test.skipIf(process.platform === "win32")(
  "parent cancellation terminates the owned child group",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-signal-parent-"));
    const pidFile = path.join(root, "child.pid");
    const helperUrl = new URL(
      "../../scripts/live-pi-linked-account.mjs",
      import.meta.url,
    ).href;
    const childCode = `require("node:fs").writeFileSync(process.argv[1],String(process.pid)); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);`;
    const parentCode = `import {runOwnedChild} from ${JSON.stringify(helperUrl)}; try { await runOwnedChild(process.execPath,["-e",${JSON.stringify(childCode)},${JSON.stringify(pidFile)}],{env:{PATH:process.env.PATH}},10000); } catch {process.exitCode=1;}`;
    const parent = spawn(
      process.execPath,
      ["--input-type=module", "-e", parentCode],
      { env: { PATH: process.env.PATH }, stdio: "ignore" },
    );
    const exited = new Promise((resolve, reject) => {
      parent.once("exit", resolve);
      parent.once("error", reject);
    });
    let childPid: number | undefined;
    try {
      const until = Date.now() + 5000;
      while (!childPid && Date.now() < until) {
        try {
          childPid = Number(await readFile(pidFile, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (!childPid) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(childPid);
      parent.kill("SIGTERM");
      await exited;
      assert.equal(parent.exitCode, 1);
      assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    } finally {
      parent.kill("SIGKILL");
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch (error) {
          assert.ok(
            error instanceof Error && "code" in error && error.code === "ESRCH",
          );
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  10000,
);
