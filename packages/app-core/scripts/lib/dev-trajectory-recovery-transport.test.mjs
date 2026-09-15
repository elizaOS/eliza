/** Exercises the real child transport across parent acknowledgement, timeout and disconnect. */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDevTrajectoryRecoveryCoordinator } from "./dev-trajectory-recovery.mjs";

const fixture = fileURLToPath(
  new URL(
    "./fixtures/trajectory-recovery-transport-child.mjs",
    import.meta.url,
  ),
);
const children = new Set();
const owner = () => ({
  agentId: "agent-one",
  runtimeInstanceId: "same-installation",
  runtimeExecutionOwnerId: randomUUID(),
  storageScope: {
    kind: "pglite",
    realPath: "/tmp/transport-db",
    device: "1",
    inode: "2",
  },
});
function matchingMessage(child, matches) {
  return new Promise((resolve) => {
    const listener = (message) => {
      if (!matches(message)) return;
      child.off("message", listener);
      resolve(message);
    };
    child.on("message", listener);
  });
}
const runtimes = [
  {
    name: "Node",
    command: process.execPath,
    args: ["--conditions=eliza-source", "--import", "tsx"],
  },
  { name: "Bun", command: "bun", args: ["--conditions=eliza-source"] },
];
async function start(runtime, parent) {
  const child = spawn(runtime.command, [...runtime.args, fixture], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    serialization: "json",
    env: { PATH: process.env.PATH, NODE_ENV: "test" },
  });
  children.add(child);
  parent?.attach(child);
  const ready = await matchingMessage(
    child,
    (message) => message.qa === "ready",
  );
  expect(ready.runtime).toBe(runtime.name);
  expect(ready.version).toBeTruthy();
  return child;
}
afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }),
  );
  children.clear();
});

describe.each(runtimes)(
  "$name child trajectory recovery transport",
  (runtime) => {
    it("completes the real two-phase handshake", async () => {
      const parent = createDevTrajectoryRecoveryCoordinator({
        warn: (message) => {
          throw new Error(message);
        },
      });
      const child = await start(runtime, parent);
      const reply = matchingMessage(
        child,
        (message) => message.qa === "result",
      );
      child.send({ qa: "prepare", owner: owner() });
      expect(await reply).toEqual({ qa: "result", owners: [] });
    });

    it("rejects a mismatched registered owner instead of acknowledging its batch", async () => {
      const child = await start(runtime);
      child.on("message", (message) => {
        if (message.type === "eliza:trajectory-recovery:register")
          child.send({
            type: "eliza:trajectory-recovery:registered",
            version: 1,
            requestId: message.requestId,
            owner: owner(),
            recoveryBatchId: randomUUID(),
            owners: [],
          });
      });
      const reply = matchingMessage(
        child,
        (message) => message.qa === "result",
      );
      child.send({ qa: "prepare", owner: owner() });
      expect((await reply).error).toContain("does not match this runtime");
    });

    it("times out without publishing a successful registration", async () => {
      const child = await start(runtime);
      const reply = matchingMessage(
        child,
        (message) => message.qa === "result",
      );
      child.send({ qa: "prepare", owner: owner() });
      expect((await reply).error).toContain("acknowledgement timed out");
    });

    it("rejects when the real parent IPC channel disconnects during registration", async () => {
      const child = await start(runtime);
      const registered = matchingMessage(
        child,
        (message) => message.type === "eliza:trajectory-recovery:register",
      );
      const exit = once(child, "exit");
      child.send({ qa: "prepare", owner: owner() });
      await registered;
      child.disconnect();
      expect((await exit)[0]).toBe(23);
    });

    it("transfers ownership only after exact child SIGKILL, excluding live siblings and acknowledged owners", async () => {
      const parent = createDevTrajectoryRecoveryCoordinator({
        warn: (message) => {
          throw new Error(message);
        },
      });
      const dead = await start(runtime, parent);
      const deadOwner = owner();
      let reply = matchingMessage(dead, (message) => message.qa === "result");
      dead.send({ qa: "prepare", owner: deadOwner });
      expect(await reply).toEqual({ qa: "result", owners: [] });

      const live = await start(runtime, parent);
      reply = matchingMessage(live, (message) => message.qa === "result");
      live.send({ qa: "prepare", owner: owner() });
      expect(await reply).toEqual({ qa: "result", owners: [] });

      const exit = once(dead, "exit");
      expect(dead.kill("SIGKILL")).toBe(true);
      expect(await exit).toEqual([null, "SIGKILL"]);
      const replacement = await start(runtime, parent);
      reply = matchingMessage(
        replacement,
        (message) => message.qa === "result",
      );
      replacement.send({ qa: "prepare", owner: owner() });
      expect(await reply).toEqual({ qa: "result", owners: [deadOwner] });

      reply = matchingMessage(
        replacement,
        (message) => message.qa === "result",
      );
      replacement.send({ qa: "prepare", owner: owner() });
      expect(await reply).toEqual({ qa: "result", owners: [] });
      expect(live.exitCode).toBeNull();
      expect(live.signalCode).toBeNull();
    });
  },
);

describe("Bun dev supervisor", () => {
  it("runs the actual Bun parent coordinator and Bun child through exact-exit recovery", () => {
    const supervisorFixture = fileURLToPath(
      new URL(
        "./fixtures/trajectory-recovery-supervisor-parent.mjs",
        import.meta.url,
      ),
    );
    const stdout = execFileSync(
      "bun",
      ["--conditions=eliza-source", supervisorFixture],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { PATH: process.env.PATH, NODE_ENV: "test" },
      },
    );
    expect(JSON.parse(stdout.trim())).toEqual({
      parent: "Bun",
      child: "Bun",
      version: expect.any(String),
      recoveredOwners: 1,
      liveSiblingPreserved: true,
      acknowledgedBatchCleared: true,
    });
  }, 35_000);
});
