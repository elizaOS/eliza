/**
 * Open a target (file / URL / folder) and launch applications (#9170 M12).
 *
 * trycua/cua exposes `open(target)` and `launch(app, args) -> pid`. Eliza had
 * neither as a COMPUTER_USE verb. These are real desktop automation (the agent
 * opening a document or starting an app), so they live in the COMPUTER_USE
 * action and pass through the approval manager like every other non-read verb.
 *
 * Implementation notes:
 *   - `open` invokes the OS default handler (`open`, `xdg-open`, or Windows
 *     ShellExecute) so URLs, files, and folders match OS double-click behavior.
 *     Windows must not go through `cmd /c start`: `start` is a cmd builtin and
 *     treats `&`, `|`, and `>` in the target as extra commands.
 *   - `launch` spawns the executable DETACHED and returns its pid so the caller
 *     can track / focus it. The child is unref'd so it outlives the agent turn.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { ElizaError } from "@elizaos/core";
import { currentPlatform } from "./helpers.js";
import { psSpawnTimeoutMs } from "./windows-timeouts.js";

/** Result of a launch — the spawned process id (and the resolved command). */
export interface LaunchResult {
  pid: number;
  command: string;
  args: string[];
}

const OPEN_TIMEOUT_MS = 10_000;
const WINDOWS_OPEN_TIMEOUT_MS = 20_000;
const WINDOWS_OPEN_TARGET_ENV = "ELIZA_COMPUTERUSE_OPEN_TARGET";
const WINDOWS_SHELL_EXECUTE_SCRIPT = [
  "$target = [Environment]::GetEnvironmentVariable('ELIZA_COMPUTERUSE_OPEN_TARGET', 'Process')",
  "[Environment]::SetEnvironmentVariable('ELIZA_COMPUTERUSE_OPEN_TARGET', $null, 'Process')",
  "$info = [System.Diagnostics.ProcessStartInfo]::new()",
  "$info.FileName = $target",
  "$info.UseShellExecute = $true",
  "[System.Diagnostics.Process]::Start($info) | Out-Null",
].join("; ");

interface OpenInvocation {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs: number;
}

/** Resolve the no-shell invocation used by {@link openTarget}. */
function resolveOpenInvocation(
  target: string,
  os: NodeJS.Platform,
): OpenInvocation {
  const value = target.trim();
  if (!value) {
    throw new ElizaError("open requires a non-empty target", {
      code: "COMPUTER_USE_OPEN_INVALID_TARGET",
    });
  }
  if (value.includes("\0")) {
    throw new ElizaError("open target cannot contain a null byte", {
      code: "COMPUTER_USE_OPEN_INVALID_TARGET",
    });
  }
  if (os === "darwin") {
    return { command: "open", args: [value], timeoutMs: OPEN_TIMEOUT_MS };
  }
  if (os === "linux") {
    return { command: "xdg-open", args: [value], timeoutMs: OPEN_TIMEOUT_MS };
  }
  if (os === "win32") {
    // The script is constant and the untrusted target travels only through the
    // child environment. This preserves ShellExecute's default-handler contract
    // for URLs, files, and folders without exposing the target to cmd or the
    // PowerShell parser. A one-shot PowerShell is slower than explorer.exe, so
    // retain the package's Defender-aware timeout floor.
    return {
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_SHELL_EXECUTE_SCRIPT,
      ],
      env: { [WINDOWS_OPEN_TARGET_ENV]: value },
      timeoutMs: psSpawnTimeoutMs(WINDOWS_OPEN_TIMEOUT_MS),
    };
  }
  throw new ElizaError(`open unsupported on platform "${os}"`, {
    code: "COMPUTER_USE_OPEN_UNSUPPORTED_PLATFORM",
    context: { platform: os },
  });
}

/**
 * Open a file / URL / folder with the OS default handler. Resolves once the
 * launcher returns (the launcher exits immediately; the opened app keeps
 * running). Rejects on a non-zero launcher exit.
 */
export function openTarget(target: string): Promise<void> {
  let invocation: OpenInvocation;
  try {
    invocation = resolveOpenInvocation(target ?? "", currentPlatform());
  } catch (err) {
    return Promise.reject(
      err instanceof ElizaError
        ? err
        : new ElizaError("Failed to resolve the OS open invocation", {
            code: "COMPUTER_USE_OPEN_RESOLUTION_FAILED",
            cause: err,
          }),
    );
  }
  const { command, args, env, timeoutMs } = invocation;
  return new Promise<void>((resolve, reject) => {
    try {
      execFile(
        command,
        args,
        {
          timeout: timeoutMs,
          ...(env ? { env: { ...process.env, ...env } } : {}),
        },
        (err) => {
          if (err) {
            // error-policy:J1 process boundary translates launcher failure.
            reject(
              new ElizaError(`Failed to open target with ${command}`, {
                code: "COMPUTER_USE_OPEN_FAILED",
                cause: err,
                context: { command },
              }),
            );
          } else resolve();
        },
      );
    } catch (err) {
      // error-policy:J1 process boundary translates synchronous spawn failure.
      reject(
        new ElizaError(`Failed to start target opener ${command}`, {
          code: "COMPUTER_USE_OPEN_FAILED",
          cause: err,
          context: { command },
        }),
      );
    }
  });
}

/**
 * Launch an application detached and return its pid. `app` is an executable
 * name/path (or, on macOS, an app-bundle name launched via `open -a`). The
 * child is unref'd so it survives the agent turn.
 */
export function launchApp(
  app: string,
  args: string[] = [],
): Promise<LaunchResult> {
  const value = app?.trim();
  if (!value) {
    return Promise.reject(new Error("launch requires a non-empty app"));
  }
  const os = currentPlatform();
  // macOS app-bundle names (e.g. "Safari", "Visual Studio Code") launch via
  // `open -a NAME --args ...`; absolute executable paths spawn directly.
  const useMacOpen = os === "darwin" && !value.includes("/");
  const command = useMacOpen ? "open" : value;
  const spawnArgs = useMacOpen
    ? ["-a", value, ...(args.length ? ["--args", ...args] : [])]
    : args;

  return new Promise<LaunchResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, spawnArgs, {
        detached: true,
        stdio: "ignore",
      });
    } catch (err) {
      // error-policy:J1 promise boundary — a sync spawn throw is translated
      // into the rejection callers observe; nothing is swallowed.
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let settled = false;
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    // `spawn` assigns the pid synchronously on success; resolve on next tick so
    // an immediate spawn `error` (e.g. ENOENT) rejects first.
    setImmediate(() => {
      if (settled) return;
      if (typeof child.pid !== "number") {
        settled = true;
        reject(new Error(`launch failed to start "${value}"`));
        return;
      }
      settled = true;
      child.unref();
      resolve({ pid: child.pid, command, args: spawnArgs });
    });
  });
}

/** Result of a kill — the resolved target and how it was addressed. */
export interface KillResult {
  target: string;
  /** Numeric pid when the target was a pid; omitted for a process-name kill. */
  pid?: number;
  killed: true;
}

/**
 * Terminate a running application by pid (all-digits) or process name
 * (#9170 — trycua/cua `kill_app`). Pairs with `launchApp`. Destructive, so it
 * routes through the approval manager like every other non-read verb. Uses
 * `execFile` (no shell) so the target can't inject a command.
 *
 *   - Windows: `taskkill /F /PID <n>` or `/F /IM <name>.exe`.
 *   - macOS / Linux: `kill -9 <pid>` or `pkill -f <name>`.
 *
 * Rejects when the target does not exist (non-zero exit) so the caller gets
 * clear feedback rather than a silent no-op.
 */
export function killApp(target: string): Promise<KillResult> {
  const value = String(target ?? "").trim();
  if (!value) {
    return Promise.reject(
      new Error("kill_app requires a non-empty target (pid or app name)"),
    );
  }
  const isPid = /^\d+$/.test(value);
  const os = currentPlatform();
  let command: string;
  let args: string[];
  if (os === "win32") {
    command = "taskkill";
    args = isPid
      ? ["/F", "/PID", value]
      : [
          "/F",
          "/IM",
          value.toLowerCase().endsWith(".exe") ? value : `${value}.exe`,
        ];
  } else if (os === "darwin" || os === "linux") {
    if (isPid) {
      command = "kill";
      args = ["-9", value];
    } else {
      command = "pkill";
      args = ["-f", value];
    }
  } else {
    return Promise.reject(
      new Error(`kill_app unsupported on platform "${os}"`),
    );
  }
  return new Promise<KillResult>((resolve, reject) => {
    execFile(command, args, { timeout: OPEN_TIMEOUT_MS }, (err) => {
      if (err) {
        reject(
          new Error(
            `kill_app failed for "${value}": ${err.message} (target may not be running)`,
          ),
        );
      } else {
        resolve({
          target: value,
          ...(isPid ? { pid: Number(value) } : {}),
          killed: true,
        });
      }
    });
  });
}
