#!/usr/bin/env node

/**
 * Exercises the Cloud batch watchdog against real parent/descendant trees.
 * It covers both a parent that exits on graceful termination and a command
 * that exits before timeout while a resistant descendant retains its pipes.
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
const exitedParentSource = `
import { spawn } from "node:child_process";
const descendant = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendantSource)}], {
  stdio: ["ignore", "inherit", "inherit"],
});
process.stdout.write("EXITED_PARENT_PID=" + process.pid + "\\n");
process.stdout.write("RETAINING_DESCENDANT_PID=" + descendant.pid + "\\n", () => process.exit(0));
`;

let stdout = "";
let timeoutObserved = false;
let supervisorPid;
let parentPid;
let descendantPid;
let exitedSupervisorPid;
let exitedParentPid;
let retainingDescendantPid;

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
    elapsedMs < 30_000,
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
  if (process.platform !== "win32") {
    // Windows taskkill removes the console process tree without delivering
    // Node's POSIX SIGTERM event; tree disappearance below is the authority.
    assert.match(
      stdout,
      /PARENT_TERM_EXIT/,
      "parent must handle TERM and exit before forced group teardown",
    );
  }

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
    `[test-cloud-run-watchdog] TERM-exit scenario passed (${elapsedMs} ms, platform=${process.platform})`,
  );

  if (process.platform !== "win32") {
    let exitedStdout = "";
    let exitedTimeoutObserved = false;
    let exitedParentGoneAtTimeout = false;
    const exitedStartedAt = Date.now();
    const exitedResult = await runCommandWithWatchdog(
      process.execPath,
      ["--input-type=module", "-e", exitedParentSource],
      {
        timeoutMs: 250,
        terminationGraceMs: 400,
        forceKillSettleMs: 500,
        writeOut: (text) => {
          exitedStdout += text;
        },
        writeErr: () => {},
        onTimeout: () => {
          exitedTimeoutObserved = true;
          const reportedParentPid = Number(
            exitedStdout.match(/EXITED_PARENT_PID=(\d+)/)?.[1],
          );
          exitedParentGoneAtTimeout =
            Number.isInteger(reportedParentPid) && !isAlive(reportedParentPid);
        },
      },
    );
    const exitedElapsedMs = Date.now() - exitedStartedAt;
    exitedSupervisorPid = exitedResult.pid;
    exitedParentPid = Number(
      exitedStdout.match(/EXITED_PARENT_PID=(\d+)/)?.[1],
    );
    retainingDescendantPid = Number(
      exitedStdout.match(/RETAINING_DESCENDANT_PID=(\d+)/)?.[1],
    );

    assert.equal(
      exitedTimeoutObserved,
      true,
      "retained descendant pipes must keep the watchdog armed",
    );
    assert.equal(
      exitedResult.timedOut,
      true,
      "an exited command with retained descendant pipes must time out",
    );
    assert.equal(
      exitedParentGoneAtTimeout,
      true,
      "the command must already be gone when the watchdog fires",
    );
    assert.equal(
      exitedResult.terminationError,
      undefined,
      "the retained supervisor anchor must make teardown provable",
    );
    assert.ok(
      Number.isInteger(exitedSupervisorPid),
      "watchdog must retain the second supervisor PID",
    );
    assert.ok(
      Number.isInteger(exitedParentPid),
      "exited command must report its PID",
    );
    assert.ok(
      Number.isInteger(retainingDescendantPid),
      "pipe-retaining descendant must report its PID",
    );
    assert.equal(
      isAlive(exitedParentPid),
      false,
      "command must have exited before watchdog teardown",
    );

    const retainedPipeDeadline = Date.now() + 1500;
    while (
      (isAlive(exitedSupervisorPid) || isAlive(retainingDescendantPid)) &&
      Date.now() < retainedPipeDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      isAlive(exitedSupervisorPid),
      false,
      "watchdog must terminate the retained supervisor anchor",
    );
    assert.equal(
      isAlive(retainingDescendantPid),
      false,
      "watchdog must terminate the pipe-retaining descendant",
    );
    assert.ok(
      exitedElapsedMs < 5000,
      `retained-pipe watchdog took too long (${exitedElapsedMs} ms)`,
    );

    console.log(
      `[test-cloud-run-watchdog] exited-command scenario passed (${exitedElapsedMs} ms, platform=${process.platform})`,
    );
  }
} finally {
  bestEffortKillTree(supervisorPid, { processGroup: true });
  bestEffortKillTree(parentPid);
  bestEffortKillTree(descendantPid);
  bestEffortKillTree(exitedSupervisorPid, { processGroup: true });
  bestEffortKillTree(exitedParentPid);
  bestEffortKillTree(retainingDescendantPid);
}
