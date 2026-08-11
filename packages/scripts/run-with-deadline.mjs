#!/usr/bin/env node
/**
 * Run a command under a wall-clock deadline, killing its whole process group
 * when the deadline passes. Exists for test suites that can wedge instead of
 * exiting (leaked handles keep a runner's event loop alive after the last
 * test): a bounded failure with output beats holding a CI job to its cap.
 * Exit codes: the child's own code on normal completion, 124 on deadline
 * kill, 127 when the command cannot start, 2 on usage errors.
 *
 * usage: node packages/scripts/run-with-deadline.mjs <deadline-ms> -- <command> [args...]
 */
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const deadlineRaw = argv[0] ?? "";
const deadlineMs = /^\d+$/.test(deadlineRaw) ? Number(deadlineRaw) : NaN;
if (
  argv[1] !== "--" ||
  !Number.isSafeInteger(deadlineMs) ||
  deadlineMs <= 0 ||
  argv.length < 3
) {
  console.error(
    "usage: node packages/scripts/run-with-deadline.mjs <deadline-ms> -- <command> [args...]",
  );
  process.exit(2);
}
const [command, ...args] = argv.slice(2);

// detached: the child leads its own process group, so the deadline kill
// reaches grandchildren (per-file test workers, spawned engines) too.
const child = spawn(command, args, { stdio: "inherit", detached: true });

const killGroup = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // error-policy:J6 group teardown fallback — the group leader may already
    // have exited; direct-kill the child instead and let 'close' settle.
    try {
      child.kill(signal);
    } catch {
      // error-policy:J6 child already gone; 'close' has fired or will fire.
    }
  }
};

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(
    `[run-with-deadline] wall-clock deadline of ${deadlineMs}ms exceeded; killing "${command}" process group`,
  );
  killGroup("SIGTERM");
  const escalation = setTimeout(() => killGroup("SIGKILL"), 10_000);
  escalation.unref();
}, deadlineMs);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => killGroup(signal));
}

child.on("error", (error) => {
  clearTimeout(timer);
  console.error(
    `[run-with-deadline] failed to start "${command}": ${error.message}`,
  );
  process.exit(127);
});
child.on("close", (code, signal) => {
  clearTimeout(timer);
  if (timedOut) process.exit(124);
  process.exit(code ?? (signal ? 1 : 0));
});
