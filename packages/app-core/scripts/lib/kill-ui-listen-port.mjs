/**
 * Best-effort: free a TCP listen port before starting Vite (avoids EADDRINUSE).
 *
 * **Why:** A crashed or orphaned Vite/dev-server often leaves the UI port bound; the next
 * dev session would fail with “port in use” without this sweep.
 *
 * **Why two implementations:** macOS/Linux typically have `lsof`; Windows does not ship it
 * by default, so we parse `netstat -ano` LISTENING rows and `taskkill` only those PIDs.
 */
import { execSync } from "node:child_process";

/**
 * Parse English `netstat -ano` lines for TCP listeners on `port`.
 * Exported for unit tests only.
 *
 * @param {string} output
 * @param {number} port
 * @returns {number[]}
 */
export function parseNetstatListeningPids(output, port) {
  const pids = new Set();
  const portStr = String(port);
  for (const line of output.split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[1];
    if (!local) continue;
    const colonIdx = local.lastIndexOf(":");
    if (colonIdx < 0) continue;
    if (local.slice(colonIdx + 1) !== portStr) continue;
    const pid = Number.parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/**
 * @param {number} port
 */
export function killUiListenPort(port) {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return;

  if (process.platform === "win32") {
    try {
      const out = execSync("netstat -ano", {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
      for (const pid of parseNetstatListeningPids(out, port)) {
        try {
          execSync(`taskkill /PID ${pid} /F /T`, {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          /* already exited or access denied */
        }
      }
    } catch {
      /* netstat missing or failed */
    }
    return;
  }

  try {
    execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, {
      stdio: "ignore",
    });
  } catch {
    /* ignore */
  }
}
