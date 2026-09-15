/** Real Bun-parent/Bun-child IPC proof; never boots an API or opens a database. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createDevTrajectoryRecoveryCoordinator } from "../dev-trajectory-recovery.mjs";

assert.ok(process.versions.bun, "This fixture must run under Bun");
const fixture = fileURLToPath(
  new URL("./trajectory-recovery-transport-child.mjs", import.meta.url),
);
const children = new Set();
const parent = createDevTrajectoryRecoveryCoordinator({
  warn: (message) => {
    throw new Error(message);
  },
});
const owner = () => ({
  agentId: "bun-parent-agent",
  runtimeInstanceId: "same-installation",
  runtimeExecutionOwnerId: randomUUID(),
  storageScope: {
    kind: "pglite",
    realPath: "/tmp/bun-supervisor-test-db",
    device: "1",
    inode: "2",
  },
});

function message(child, matches) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", received);
      child.off("exit", exited);
    };
    const received = (value) => {
      if (!matches(value)) return;
      cleanup();
      resolve(value);
    };
    const exited = () => {
      cleanup();
      reject(new Error("Child exited before IPC response"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Fixture IPC response timed out"));
    }, 5_000);
    child.on("message", received);
    child.once("exit", exited);
  });
}

async function start() {
  const child = spawn(
    process.execPath,
    ["--conditions=eliza-source", fixture],
    {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      serialization: "json",
      env: { PATH: process.env.PATH, NODE_ENV: "test" },
    },
  );
  children.add(child);
  parent.attach(child);
  const ready = await message(child, (value) => value.qa === "ready");
  assert.equal(ready.runtime, "Bun");
  assert.equal(ready.version, process.versions.bun);
  return child;
}

async function prepare(child, nextOwner) {
  const result = message(child, (value) => value.qa === "result");
  child.send({ qa: "prepare", owner: nextOwner });
  return result;
}

try {
  const original = await start();
  const originalOwner = owner();
  assert.deepEqual(await prepare(original, originalOwner), {
    qa: "result",
    owners: [],
  });
  const live = await start();
  assert.deepEqual(await prepare(live, owner()), { qa: "result", owners: [] });
  const exited = once(original, "exit");
  assert.equal(original.kill("SIGKILL"), true);
  assert.deepEqual(await exited, [null, "SIGKILL"]);
  const replacement = await start();
  assert.deepEqual(await prepare(replacement, owner()), {
    qa: "result",
    owners: [originalOwner],
  });
  assert.deepEqual(await prepare(replacement, owner()), {
    qa: "result",
    owners: [],
  });
  assert.equal(live.exitCode, null);
  assert.equal(live.signalCode, null);
  console.log(
    JSON.stringify({
      parent: "Bun",
      child: "Bun",
      version: process.versions.bun,
      recoveredOwners: 1,
      liveSiblingPreserved: true,
      acknowledgedBatchCleared: true,
    }),
  );
} finally {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }),
  );
}
