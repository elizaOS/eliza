#!/usr/bin/env node

// End-to-end regression proof for #17245. A parent and its descendant both
// ignore graceful termination and keep native event-loop handles open. The
// batch watchdog must still return promptly and remove the whole process tree.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runCommandWithWatchdog } from "./test-cloud-run.mjs";

const descendantSource = `
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;
const parentSource = `
import { spawn } from "node:child_process";
const descendant = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendantSource)}], {
  stdio: "ignore",
});
process.stdout.write("DESCENDANT_PID=" + descendant.pid + "\\n");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;

let stdout = "";
let timeoutObserved = false;
let childPid;
let descendantPid;

function isAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function bestEffortKillTree(pid, { processGroup = false } = {}) {
  if (!Number.isInteger(pid)) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 2000,
      });
    } else if (processGroup) {
      // A descendant may keep the detached group alive after its leader exits,
      // so target the group even when the leader PID itself is already gone.
      process.kill(-pid, "SIGKILL");
    } else if (isAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  } catch (error) {
    if (error?.code !== "ESRCH") {
      process.stderr.write(
        `[test-cloud-run-watchdog] cleanup warning for PID ${pid}: ${String(error)}\n`,
      );
    }
  }
}

try {
  const startedAt = Date.now();
  const result = await runCommandWithWatchdog(
    process.execPath,
    ["--input-type=module", "-e", parentSource],
    {
      timeoutMs: 250,
      terminationGraceMs: 400,
      forceKillSettleMs: 500,
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: () => {},
      onTimeout: () => {
        timeoutObserved = true;
      },
    },
  );
  const elapsedMs = Date.now() - startedAt;
  childPid = result.pid;
  descendantPid = Number(stdout.match(/DESCENDANT_PID=(\d+)/)?.[1]);

  assert.equal(timeoutObserved, true, "watchdog must announce the deadline");
  assert.equal(
    result.timedOut,
    true,
    "non-exiting child must fail as timed out",
  );
  assert.equal(
    result.terminationError,
    undefined,
    "successful escalation must not report a teardown error",
  );
  assert.ok(
    elapsedMs < 5000,
    `watchdog took too long to return (${elapsedMs} ms)`,
  );
  assert.ok(
    Number.isInteger(descendantPid),
    "child must report its descendant PID live",
  );
  assert.ok(
    Number.isInteger(childPid),
    "watchdog result must retain the child PID",
  );

  const descendantDeadline = Date.now() + 1500;
  while (
    (isAlive(childPid) || isAlive(descendantPid)) &&
    Date.now() < descendantDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(isAlive(childPid), false, "watchdog must terminate the child");
  assert.equal(
    isAlive(descendantPid),
    false,
    "watchdog must terminate the descendant",
  );

  console.log(
    `[test-cloud-run-watchdog] self-test passed (${elapsedMs} ms, platform=${process.platform})`,
  );
} finally {
  bestEffortKillTree(childPid, { processGroup: true });
  bestEffortKillTree(descendantPid);
}
