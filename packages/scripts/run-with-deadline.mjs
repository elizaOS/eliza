#!/usr/bin/env node
/**
 * Run a command under a wall-clock deadline, killing its whole process group
 * when the deadline passes. Exists for test suites that can wedge instead of
 * exiting (leaked handles keep a runner's event loop alive after the last
 * test): a bounded failure with output beats holding a CI job to its cap.
 * Exit codes: the child's own code on normal completion, 124 on deadline
 * kill, 127 when the command cannot start, 2 on usage errors.
 *
 * The deadline must be a positive decimal integer no greater than Node's
 * maximum timer delay (`2^31 - 1` ms). Larger values would clamp to 1 ms and
 * kill the child immediately.
 *
 * usage: node packages/scripts/run-with-deadline.mjs <deadline-ms> -- <command> [args...]
 */
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Node clamps `setTimeout` delays above this to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Parse a wall-clock deadline for the CLI boundary.
 * @param {string} raw
 * @returns {number}
 */
export function parseDeadlineMs(raw) {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
    throw new Error(
      `deadline-ms must be a positive decimal integer from 1 to ${MAX_TIMER_DELAY_MS}`,
    );
  }
  const deadlineMs = Number(raw);
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `deadline-ms must be a positive decimal integer from 1 to ${MAX_TIMER_DELAY_MS}`,
    );
  }
  return deadlineMs;
}

/**
 * Parse CLI argv into deadline and command. Exported for focused tests.
 * @param {string[]} argv process.argv slice after the script path
 * @returns {{ deadlineMs: number, command: string, args: string[] }}
 */
export function parseArgs(argv) {
  const deadlineRaw = argv[0] ?? "";
  if (argv[1] !== "--" || argv.length < 3) {
    throw new Error(
      "usage: node packages/scripts/run-with-deadline.mjs <deadline-ms> -- <command> [args...]",
    );
  }
  const deadlineMs = parseDeadlineMs(deadlineRaw);
  const [command, ...args] = argv.slice(2);
  return { deadlineMs, command, args };
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    // error-policy:J1 CLI boundary — invalid deadline/usage fails before spawn
    console.error(
      error instanceof Error
        ? error.message
        : "usage: node packages/scripts/run-with-deadline.mjs <deadline-ms> -- <command> [args...]",
    );
    process.exit(2);
  }

  const { deadlineMs, command, args } = options;

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
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2));
}
