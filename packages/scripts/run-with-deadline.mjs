#!/usr/bin/env node
/**
 * Run a command under a wall-clock deadline, killing its whole process group
 * when the deadline passes. Exists for test suites that can wedge instead of
 * exiting (leaked handles keep a runner's event loop alive after the last
 * test): a bounded failure with output beats holding a CI job to its cap.
 * Exit codes: the child's own code on normal completion, 124 on deadline,
 * 127 when the command cannot start, and 2 on usage errors. On Windows, 1 can
 * be the child's own status or a supervisor failure, including cleanup that
 * could not be proven.
 *
 * The deadline must be a positive decimal integer no greater than Node's
 * maximum timer delay (`2^31 - 1` ms). Larger values would clamp to 1 ms and
 * kill the child immediately.
 *
 * usage: node packages/scripts/run-with-deadline.mjs <deadline-ms> -- <command> [args...]
 */
import { spawn } from "node:child_process";
import { uptime } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Node clamps `setTimeout` delays above this to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Grace period between SIGTERM and forced process-group termination. */
export const TERMINATION_GRACE_MS = 10_000;

/** Poll interval used to prove that a killed process group is gone. */
const PROCESS_GROUP_REAP_POLL_MS = 25;

/** Maximum time spent checking for a reaped process group after SIGKILL. */
const PROCESS_GROUP_REAP_TIMEOUT_MS = 2_000;

const WINDOWS_COMMAND_SPEC_ENV = "ELIZA_RUN_WITH_DEADLINE_COMMAND_SPEC";
// The helper bounds its native job drain at eight seconds; keep four seconds
// for PowerShell finalization and the child's close event.
const WINDOWS_JOB_SETTLE_TIMEOUT_MS = 12_000;
const WINDOWS_SUPERVISOR_KILL_SETTLE_MS = 2_000;
const WINDOWS_JOB_SUPERVISOR = fileURLToPath(
  new URL("./run-with-deadline-windows.ps1", import.meta.url),
);

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

  const isWindows = process.platform === "win32";
  const deadlineAtTickMs = Math.floor(uptime() * 1000) + deadlineMs;
  // POSIX children lead a detached process group. On Windows a PowerShell
  // supervisor creates its worker inside a kill-on-close Job Object before the
  // worker executes the target. The supervisor owns deadline arbitration and
  // reports 124 only after the entire job is empty.
  const child = isWindows
    ? spawn(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          WINDOWS_JOB_SUPERVISOR,
        ],
        {
          stdio: "inherit",
          windowsHide: true,
          env: {
            ...process.env,
            [WINDOWS_COMMAND_SPEC_ENV]: Buffer.from(
              JSON.stringify({ command, args, deadlineMs, deadlineAtTickMs }),
              "utf8",
            ).toString("base64"),
          },
        },
      )
    : spawn(command, args, { stdio: "inherit", detached: true });
  let timer;
  let windowsSettleTimer;
  let windowsForceExitTimer;
  let windowsWatchdogExpired = false;
  child.once("exit", () => {
    clearTimeout(timer);
    clearTimeout(windowsSettleTimer);
  });

  const killGroup = (signal) => {
    try {
      if (isWindows) {
        child.kill(signal);
        return;
      }
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

  const processGroupExists = () => {
    if (isWindows) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      // error-policy:J6 process-group liveness probe: ESRCH proves teardown;
      // permission or transient probe errors conservatively mean still alive.
      return error?.code !== "ESRCH";
    }
  };

  const waitForProcessGroupGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (processGroupExists() && Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, PROCESS_GROUP_REAP_POLL_MS),
      );
    }
    return !processGroupExists();
  };

  let timedOut = false;
  let timeoutDone = false;
  let closeResult = null;
  const finish = () => {
    if (!closeResult) return;
    if (timedOut) {
      // A SIGTERM'd group leader can close before its descendants. If the
      // group is already gone, settle immediately; otherwise keep the wrapper
      // alive for the escalation path below.
      if (!isWindows && !timeoutDone && !processGroupExists()) {
        timeoutDone = true;
      }
      if (!timeoutDone) return;
      process.exit(124);
    }
    process.exit(closeResult.code ?? (closeResult.signal ? 1 : 0));
  };
  if (isWindows) {
    timer = setTimeout(
      () => {
        const settleDeadlineAtTickMs =
          deadlineAtTickMs + WINDOWS_JOB_SETTLE_TIMEOUT_MS;
        windowsSettleTimer = setTimeout(
          () => {
            windowsWatchdogExpired = true;
            console.error(
              `[run-with-deadline] Windows supervisor for "${command}" did not settle within ${WINDOWS_JOB_SETTLE_TIMEOUT_MS}ms after its deadline`,
            );
            killGroup("SIGKILL");
            windowsForceExitTimer = setTimeout(
              () => process.exit(1),
              WINDOWS_SUPERVISOR_KILL_SETTLE_MS,
            );
          },
          Math.max(1, settleDeadlineAtTickMs - Math.floor(uptime() * 1000)),
        );
      },
      Math.max(1, deadlineAtTickMs - Math.floor(uptime() * 1000)),
    );
  } else {
    timer = setTimeout(() => {
      timedOut = true;
      console.error(
        `[run-with-deadline] wall-clock deadline of ${deadlineMs}ms exceeded; killing "${command}" process group`,
      );
      killGroup("SIGTERM");
      void (async () => {
        const gracefullyReaped =
          await waitForProcessGroupGone(TERMINATION_GRACE_MS);
        if (gracefullyReaped) {
          timeoutDone = true;
          finish();
          return;
        }
        console.error(
          `[run-with-deadline] termination grace expired; escalating "${command}" process group to SIGKILL`,
        );
        killGroup("SIGKILL");
        const reaped = await waitForProcessGroupGone(
          PROCESS_GROUP_REAP_TIMEOUT_MS,
        );
        if (!reaped) {
          console.error(
            `[run-with-deadline] process group for "${command}" did not confirm reaping after SIGKILL`,
          );
        }
        timeoutDone = true;
        finish();
      })();
    }, deadlineMs);
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => killGroup(signal));
  }

  child.on("error", (error) => {
    clearTimeout(timer);
    clearTimeout(windowsSettleTimer);
    clearTimeout(windowsForceExitTimer);
    console.error(
      `[run-with-deadline] failed to start "${command}": ${error.message}`,
    );
    process.exit(127);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    clearTimeout(windowsSettleTimer);
    clearTimeout(windowsForceExitTimer);
    if (windowsWatchdogExpired) process.exit(1);
    closeResult = { code, signal };
    if (timedOut && !isWindows && !processGroupExists()) {
      timeoutDone = true;
    }
    finish();
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2));
}
