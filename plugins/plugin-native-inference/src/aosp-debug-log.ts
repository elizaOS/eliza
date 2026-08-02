/**
 * Append-only, line-delimited debug trace for the AOSP fused-inference loader.
 *
 * Gated by `ELIZA_AOSP_LLAMA_DEBUG_LOG`: `"1"`/`"true"` targets
 * `$ELIZA_STATE_DIR/aosp-llama-debug.log`, any other non-falsy value is an
 * explicit path, and unset/`"0"`/`"false"` disables writes entirely. Each
 * record is an ISO timestamp, an event name, and an optional bigint-safe JSON
 * detail blob. Writes are best-effort and swallow all errors so diagnostics
 * can never perturb the inference path.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function resolveDebugLogPath(): string | null {
  const raw = process.env.ELIZA_AOSP_LLAMA_DEBUG_LOG?.trim();
  if (!raw || raw === "0" || raw.toLowerCase() === "false") return null;
  if (raw === "1" || raw.toLowerCase() === "true") {
    const stateDir = process.env.ELIZA_STATE_DIR?.trim();
    return stateDir ? path.join(stateDir, "aosp-llama-debug.log") : null;
  }
  return raw;
}

function safeJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

export function writeAospLlamaDebugLog(
  event: string,
  details?: Record<string, unknown>,
): void {
  const logPath = resolveDebugLogPath();
  if (!logPath) return;
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `${new Date().toISOString()} ${event}${
        details ? ` ${safeJson(details)}` : ""
      }\n`,
      "utf8",
    );
  } catch {
    // Diagnostics must never affect inference.
  }
}
