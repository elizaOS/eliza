#!/usr/bin/env node

/**
 * Exercises the Cloud batch watchdog against a real parent and descendant.
 * The parent exits on graceful termination while the descendant resists it;
 * the watchdog must anchor the group and remove the complete tree promptly.
 */

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
process.stdout.write("PARENT_PID=" + process.pid + "\\n");
process.stdout.write("DESCENDANT_PID=" + descendant.pid + "\\n");
process.on("SIGTERM", () => {
  process.stdout.write("PARENT_TERM_EXIT\\n", () => process.exit(0));
});
setInterval(() => {}, 1000);
`;

let stdout = "";
let timeoutObserved = false;
let supervisorPid;
let parentPid;
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
  supervisorPid = result.pid;
  parentPid = Number(stdout.match(/PARENT_PID=(\d+)/)?.[1]);
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
    Number.isInteger(supervisorPid),
    "watchdog result must retain the supervisor PID",
  );
  assert.ok(
    Number.isInteger(parentPid),
    "supervised command must report its PID live",
  );
  assert.match(
    stdout,
    /PARENT_TERM_EXIT/,
    "parent must handle TERM and exit before forced group teardown",
  );

  const descendantDeadline = Date.now() + 1500;
  while (
    (isAlive(supervisorPid) || isAlive(parentPid) || isAlive(descendantPid)) &&
    Date.now() < descendantDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(
    isAlive(supervisorPid),
    false,
    "watchdog must terminate the supervisor",
  );
  assert.equal(isAlive(parentPid), false, "watchdog must terminate the parent");
  assert.equal(
    isAlive(descendantPid),
    false,
    "watchdog must terminate the descendant",
  );

  console.log(
    `[test-cloud-run-watchdog] self-test passed (${elapsedMs} ms, platform=${process.platform})`,
  );
} finally {
  bestEffortKillTree(supervisorPid, { processGroup: true });
  bestEffortKillTree(parentPid);
  bestEffortKillTree(descendantPid);
}
