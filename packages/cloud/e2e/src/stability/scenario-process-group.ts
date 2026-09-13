/**
 * Signals and verifies the dedicated scenario process group with bounded tools.
 * Privileged absence has an explicit protocol result; failed sudo, permission
 * denial or a timed-out control command never becomes an absent group.
 */
import { spawnSync } from "node:child_process";
import { ElizaError } from "@elizaos/core/errors";

const control = `import os,signal,sys
try:
 os.kill(-int(sys.argv[1]), 0 if sys.argv[2]=='probe' else getattr(signal,sys.argv[2]))
except ProcessLookupError:
 sys.exit(3)
except PermissionError:
 sys.exit(4)
`;

/** A process-control transport must return within its own deadline. */
export function runBoundedProcessControl(
  command: string,
  args: string[],
  timeoutMs = 1_000,
): number {
  const result = spawnSync(command, args, {
    stdio: "ignore",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.signal || result.status === null) {
    throw new ElizaError("Scenario process-control command did not complete", {
      code: "STABILITY_PROCESS_CONTROL_FAILED",
      cause: result.error,
      context: { signal: result.signal, timeoutMs },
    });
  }
  return result.status;
}

/** Shares one monotonic phase budget across actual control subprocesses. */
export function runProcessControlBeforeDeadline(
  command: string,
  args: string[],
  deadline: number,
): number {
  const remaining = Math.ceil(deadline - performance.now());
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new ElizaError("Scenario process-control deadline expired", {
      code: "STABILITY_PROCESS_CONTROL_DEADLINE",
    });
  }
  return runBoundedProcessControl(command, args, remaining);
}

export function createScenarioProcessGroup(privileged: boolean): {
  exists: (pid: number) => boolean;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  terminate: (pid: number) => Promise<void>;
} {
  const invoke = (
    pid: number,
    signal: NodeJS.Signals | "probe",
    deadline = performance.now() + 5_000,
  ): boolean => {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new ElizaError("Scenario group identity is invalid", {
        code: "STABILITY_PROCESS_GROUP_INVALID",
      });
    }
    if (privileged) {
      const status = runProcessControlBeforeDeadline(
        "/usr/bin/sudo",
        [
          "-n",
          "/usr/bin/python3",
          "-I",
          "-S",
          "-c",
          control,
          String(pid),
          signal,
        ],
        deadline,
      );
      if (status === 0) return true;
      if (status === 3) return false;
      throw new ElizaError("Privileged scenario process control was denied", {
        code: "STABILITY_PROCESS_CONTROL_FAILED",
        context: { pid, signal, status },
      });
    }
    try {
      process.kill(-pid, signal === "probe" ? 0 : signal);
      return true;
    } catch (error) {
      // error-policy:J1 Only ESRCH is the explicit absent process-group state.
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return false;
      throw new ElizaError("Scenario process control failed", {
        code: "STABILITY_PROCESS_CONTROL_FAILED",
        cause: error,
        context: { pid, signal },
      });
    }
  };
  const exists = (pid: number) => invoke(pid, "probe");
  const signal = (pid: number, value: NodeJS.Signals) => {
    invoke(pid, value);
  };
  const terminate = (pid: number) => terminateScenarioProcessGroup(pid, invoke);
  return { exists, signal, terminate };
}

/** Owns TERM/KILL phase progression; the production boundary is fixed sudo. */
export async function terminateScenarioProcessGroup(
  pid: number,
  invoke: (
    pid: number,
    signal: NodeJS.Signals | "probe",
    deadline: number,
  ) => boolean,
): Promise<void> {
  const started = performance.now();
  const termDeadline = started + 5_000;
  const deadline = started + 10_000;
  try {
    if (!invoke(pid, "SIGTERM", termDeadline)) return;
    while (performance.now() < termDeadline) {
      if (!invoke(pid, "probe", termDeadline)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } catch (error) {
    // error-policy:J1 Spent TERM delivery/probe budgets advance to reserved
    // KILL; permission and protocol failures remain errors, never absence.
    const exhausted =
      error instanceof ElizaError &&
      (error.code === "STABILITY_PROCESS_CONTROL_DEADLINE" ||
        (error.cause instanceof Error &&
          "code" in error.cause &&
          error.cause.code === "ETIMEDOUT"));
    if (!exhausted || performance.now() < termDeadline) throw error;
  }
  if (!invoke(pid, "SIGKILL", deadline)) return;
  while (performance.now() < deadline) {
    if (!invoke(pid, "probe", deadline)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new ElizaError("Scenario process group survived SIGKILL", {
    code: "STABILITY_PROCESS_GROUP_SURVIVED",
    context: { pid },
  });
}
