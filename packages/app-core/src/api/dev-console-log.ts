/**
 * Tail read for `GET /api/dev/console-log`.
 *
 * **Why basename allow-list:** `ELIZA_DESKTOP_DEV_LOG_PATH` is process env; a malicious or mistaken
 * value could otherwise point at arbitrary files. Only `desktop-dev-console.log` is accepted.
 *
 * **Why byte window + line cap:** agents should not load multi-hour logs into context; reading the
 * tail from the end of the file keeps memory bounded.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Limits which file the API may tail (env is untrusted even on loopback).
 * Requires both the correct basename AND a `.eliza` parent directory to
 * prevent reading arbitrary files named `desktop-dev-console.log`.
 */
export function isAllowedDevConsoleLogPath(absPath: string): boolean {
  if (path.basename(absPath) !== "desktop-dev-console.log") return false;
  // Require the file to live under a `.eliza` directory
  const normalized = path.resolve(absPath);
  const parts = normalized.split(path.sep);
  return parts.some((part) => part === ".eliza");
}

export type ReadDevConsoleLogResult =
  | { ok: true; body: string }
  | { ok: false; error: string };

const DEFAULT_MAX_LINES = 400;
const DEFAULT_MAX_BYTES = 256_000;
const ABS_CAP_LINES = 5000;
const ABS_CAP_BYTES = 2_000_000;

/**
 * Read the last portion of a log file (by bytes first, then keep last N lines).
 */
export function readDevConsoleLogTail(
  absPath: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): ReadDevConsoleLogResult {
  const maxLines = Math.min(
    Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES),
    ABS_CAP_LINES,
  );
  const maxBytes = Math.min(
    Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES),
    ABS_CAP_BYTES,
  );

  try {
    if (!fs.existsSync(absPath)) {
      return { ok: false, error: "log file not found" };
    }
    const st = fs.statSync(absPath);
    if (!st.isFile()) {
      return { ok: false, error: "not a file" };
    }
    const readSize = Math.min(st.size, maxBytes);
    const start = st.size - readSize;
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, start);
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      while (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      const tail = lines.slice(-maxLines).join("\n");
      return { ok: true, body: tail.endsWith("\n") ? tail : `${tail}\n` };
    } finally {
      fs.closeSync(fd);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
