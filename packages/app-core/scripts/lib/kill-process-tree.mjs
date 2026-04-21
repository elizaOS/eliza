/**
 * Signal only the process tree rooted at a known PID (from ChildProcess.pid).
 *
 * Unix: walks descendants via `pgrep -P <ppid>` — only processes whose parent chain
 * leads to that PID. Does **not** match by name; unrelated `bun` processes are never touched.
 *
 * Windows: `taskkill /PID <pid> /T` — same tree semantics for that PID only.
 */
import { execSync } from "node:child_process";

/**
 * @param {number} pid
 * @returns {number[]}
 */
function listChildPids(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return [];
  try {
    const out = execSync(`pgrep -P ${pid} 2>/dev/null || true`, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return out
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * @param {number} pid
 * @param {"SIGTERM" | "SIGKILL"} signal
 */
function signalProcessTreeUnix(pid, signal) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  const sig = signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
  for (const cpid of listChildPids(pid)) {
    signalProcessTreeUnix(cpid, signal);
  }
  try {
    process.kill(pid, sig);
  } catch {
    /* ESRCH */
  }
}

/**
 * @param {number} pid
 * @param {"SIGTERM" | "SIGKILL"} signal
 */
function signalProcessTreeWin32(pid, signal) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  const force = signal === "SIGKILL" ? "/F" : "";
  try {
    execSync(`taskkill /PID ${pid} /T ${force}`.trim(), {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    /* already exited or access denied */
  }
}

/**
 * @param {number} pid
 * @param {"SIGTERM" | "SIGKILL"} signal
 */
export function signalProcessTree(pid, signal) {
  if (process.platform === "win32") {
    signalProcessTreeWin32(pid, signal);
  } else {
    signalProcessTreeUnix(pid, signal);
  }
}

/**
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 * @param {"SIGTERM" | "SIGKILL"} signal
 */
export function signalSpawnedProcessTree(child, signal) {
  const pid = child?.pid;
  if (pid === undefined || pid === null) return;
  signalProcessTree(pid, signal);
}
