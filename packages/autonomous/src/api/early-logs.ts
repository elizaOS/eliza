/**
 * Early log capture — split out from server.ts to avoid pulling in the entire
 * API server dependency graph when only the log-buffer bootstrap is needed
 * (e.g. during headless `startEliza()`).
 *
 * @module api/early-logs
 */

import { logger } from "@elizaos/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EarlyLogEntry {
  timestamp: number;
  level: string;
  message: string;
  source: string;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Module-level state (shared via the exported accessors)
// ---------------------------------------------------------------------------

let earlyLogBuffer: EarlyLogEntry[] | null = null;
let earlyPatchCleanup: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start capturing logs from the global @elizaos/core logger before the API
 * server is up.  Call this once, early in the startup flow (e.g. before
 * `startEliza`).  When `startApiServer` runs it will flush and take over.
 */
export function captureEarlyLogs(): void {
  if (earlyLogBuffer) return; // already capturing
  // If the global logger is already fully patched (e.g. dev-server started
  // the API server before calling startEliza), skip early capture entirely.
  if ((logger as unknown as Record<string, unknown>).__miladyLogPatched) return;
  earlyLogBuffer = [];
  const EARLY_PATCHED = "__miladyEarlyPatched";
  if ((logger as unknown as Record<string, unknown>)[EARLY_PATCHED]) return;

  const LEVELS = ["debug", "info", "warn", "error"] as const;
  const originals = new Map<string, (...args: unknown[]) => void>();

  for (const lvl of LEVELS) {
    const original = logger[lvl].bind(logger);
    originals.set(lvl, original as (...args: unknown[]) => void);
    const earlyPatched: (typeof logger)[typeof lvl] = (
      ...args: Parameters<typeof original>
    ) => {
      let msg = "";
      let source = "agent";
      const tags = ["agent"];
      if (typeof args[0] === "string") {
        msg = args[0];
      } else if (args[0] && typeof args[0] === "object") {
        const obj = args[0] as Record<string, unknown>;
        if (typeof obj.src === "string") source = obj.src;
        msg = typeof args[1] === "string" ? args[1] : JSON.stringify(obj);
      }
      const bracketMatch = /^\[([^\]]+)\]\s*/.exec(msg);
      if (bracketMatch && source === "agent") source = bracketMatch[1];
      if (source !== "agent" && !tags.includes(source)) tags.push(source);
      earlyLogBuffer?.push({
        timestamp: Date.now(),
        level: lvl,
        message: msg,
        source,
        tags,
      });
      return original(...args);
    };
    logger[lvl] = earlyPatched;
  }

  (logger as unknown as Record<string, unknown>)[EARLY_PATCHED] = true;

  earlyPatchCleanup = () => {
    // Restore originals so `patchLogger` inside `startApiServer` can re-patch
    for (const lvl of LEVELS) {
      const orig = originals.get(lvl);
      if (orig) logger[lvl] = orig as (typeof logger)[typeof lvl];
    }
    delete (logger as unknown as Record<string, unknown>)[EARLY_PATCHED];
    // Don't set the main PATCHED_MARKER — `patchLogger` will do that
    delete (logger as unknown as Record<string, unknown>).__miladyLogPatched;
  };
}

/**
 * Drain the early log buffer and clean up the early logger patch.
 * Called by `startApiServer` to flush buffered entries into the main log
 * buffer, then hand control to the server's own logger patch.
 *
 * Returns the buffered entries (empty array if none).
 */
export function flushEarlyLogs(): EarlyLogEntry[] {
  const entries = earlyLogBuffer ? [...earlyLogBuffer] : [];
  if (earlyPatchCleanup) {
    earlyPatchCleanup();
    earlyPatchCleanup = null;
  }
  earlyLogBuffer = null;
  return entries;
}
