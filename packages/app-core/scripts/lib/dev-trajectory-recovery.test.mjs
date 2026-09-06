/** Exercises recovery authority through real spawned-child IPC and SIGKILL exits. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDevTrajectoryRecoveryCoordinator } from "./dev-trajectory-recovery.mjs";

const fixture = fileURLToPath(
  new URL("./fixtures/trajectory-recovery-child.mjs", import.meta.url),
);
const children = new Set();
const scope = {
  kind: "pglite",
  realPath: "/tmp/dev-recovery-database",
  device: "1",
  inode: "2",
};
const owner = (overrides = {}) => ({
  agentId: "agent-one",
  runtimeInstanceId: "same-installation",
  runtimeExecutionOwnerId: randomUUID(),
  storageScope: scope,
  ...overrides,
});
const registration = (value) => ({
  type: "eliza:trajectory-recovery:register",
  version: 1,
  requestId: randomUUID(),
  owner: value,
});
function coordinator() {
  return createDevTrajectoryRecoveryCoordinator({
    warn: (message) => {
      throw new Error(message);
    },
  });
}
async function start(parent) {
  const child = spawn(process.execPath, [fixture], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.add(child);
  parent.attach(child);
  while ((await once(child, "message"))[0].qa !== "ready") {
    /* await fixture startup */
  }
  return child;
}
async function exchange(child, payload) {
  const reply = new Promise((resolve) => {
    const onMessage = (message) => {
      if (message.qa !== "received") return;
      child.off("message", onMessage);
      resolve(message);
    };
    child.on("message", onMessage);
  });
  child.send({ qa: "send", payload });
  const message = await reply;
  expect(message.qa).toBe("received");
  return message.payload;
}
async function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
async function acknowledge(child, response) {
  return exchange(child, {
    type: "eliza:trajectory-recovery:recovered",
    version: 1,
    requestId: response.requestId,
    recoveryBatchId: response.recoveryBatchId,
  });
}
afterEach(async () => {
  await Promise.all([...children].map(kill));
  children.clear();
});

describe("exact child trajectory recovery", () => {
  it("transfers only exited owners and drops them only after recovery acknowledgement", async () => {
    const parent = coordinator();
    const a = await start(parent);
    const owned = owner();
    expect((await exchange(a, registration(owned))).owners).toEqual([]);
    const b = await start(parent);
    expect((await exchange(b, registration(owner()))).owners).toEqual([]);
    await kill(a);
    const c = await start(parent);
    const restored = await exchange(c, registration(owner()));
    expect(restored.owners).toEqual([owned]);
    expect((await acknowledge(c, restored)).type).toBe(
      "eliza:trajectory-recovery:acknowledged",
    );
    expect((await acknowledge(c, restored)).type).toBe(
      "eliza:trajectory-recovery:acknowledged",
    );
    const d = await start(parent);
    expect((await exchange(d, registration(owner()))).owners).toEqual([]);
  });

  it("retains an unacknowledged batch when its replacement dies", async () => {
    const parent = coordinator();
    const a = await start(parent);
    const firstOwner = owner();
    await exchange(a, registration(firstOwner));
    await kill(a);
    const b = await start(parent);
    const secondOwner = owner();
    const batch = await exchange(b, registration(secondOwner));
    expect(batch.owners).toEqual([firstOwner]);
    await kill(b);
    // A late queued event from the exited object cannot acknowledge recovery.
    b.emit("message", {
      type: "eliza:trajectory-recovery:recovered",
      version: 1,
      requestId: batch.requestId,
      recoveryBatchId: batch.recoveryBatchId,
    });
    const c = await start(parent);
    expect((await exchange(c, registration(owner()))).owners).toEqual([
      firstOwner,
      secondOwner,
    ]);
  });

  it("keeps changed storage, agent, and installation scopes separate", async () => {
    const parent = coordinator();
    const a = await start(parent);
    const original = owner();
    await exchange(a, registration(original));
    await kill(a);
    const b = await start(parent);
    for (const changed of [
      { agentId: "another-agent" },
      { runtimeInstanceId: "another-installation" },
      { storageScope: { ...scope, inode: "3" } },
      { storageScope: { ...scope, realPath: "/tmp/another-database" } },
    ])
      expect((await exchange(b, registration(owner(changed)))).owners).toEqual(
        [],
      );
    expect((await exchange(b, registration(owner()))).owners).toEqual([
      original,
    ]);
  });

  it("makes duplicate registration idempotent without accepting stolen owners or unrelated batches", async () => {
    const parent = coordinator();
    const a = await start(parent);
    const request = registration(owner());
    const first = await exchange(a, request);
    expect(await exchange(a, request)).toEqual(first);
    expect((await exchange(a, { ...request, owner: owner() })).type).toBe(
      "eliza:trajectory-recovery:rejected",
    );
    const b = await start(parent);
    expect((await exchange(b, registration(request.owner))).type).toBe(
      "eliza:trajectory-recovery:rejected",
    );
    expect((await acknowledge(b, first)).type).toBe(
      "eliza:trajectory-recovery:rejected",
    );
  });

  it("does not reconstruct death authority after the supervisor is replaced", async () => {
    const a = await start(coordinator());
    await exchange(a, registration(owner()));
    await kill(a);
    const b = await start(coordinator());
    expect((await exchange(b, registration(owner()))).owners).toEqual([]);
  });

  it("allows overlapping recoveries without clearing a newer live owner", async () => {
    const parent = coordinator();
    const a = await start(parent);
    const original = owner();
    await exchange(a, registration(original));
    await kill(a);
    const b = await start(parent);
    const c = await start(parent);
    const bOwner = owner();
    const first = await exchange(b, registration(bOwner));
    const second = await exchange(c, registration(owner()));
    expect(first.owners).toEqual([original]);
    expect(second.owners).toEqual([original]);
    await acknowledge(b, first);
    await kill(b);
    await acknowledge(c, second);
    const d = await start(parent);
    expect((await exchange(d, registration(owner()))).owners).toEqual([bOwner]);
  });

  it("rejects registration overflow without discarding earlier death proof", async () => {
    const parent = coordinator();
    const a = await start(parent);
    const retained = [];
    for (let i = 0; i < 64; i++) {
      const value = owner();
      retained.push(value);
      expect((await exchange(a, registration(value))).type).toBe(
        "eliza:trajectory-recovery:registered",
      );
    }
    expect((await exchange(a, registration(owner()))).reason).toBe(
      "owner_capacity_exceeded",
    );
    await kill(a);
    const b = await start(parent);
    expect((await exchange(b, registration(owner()))).owners).toEqual(retained);
  });
});
