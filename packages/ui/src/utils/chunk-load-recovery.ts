/**
 * Detection + one-shot page-reload recovery for lazy-chunk fetch failures
 * caused by a mid-session deploy: the running shell references hashed assets
 * from ITS build, the server has moved to a newer deployment, and any
 * not-yet-visited lazy view 404s ("Failed to fetch dynamically imported
 * module"). A reload fetches the current shell, whose chunk graph is
 * self-consistent, so the failure heals without user action.
 *
 * The attempt marker is timestamped (not a latched boolean) because
 * sessionStorage survives reloads — a permanent flag would let the FIRST
 * deploy of a session auto-heal but leave every later one showing the crash
 * card. The cooldown still prevents a reload loop when assets are genuinely
 * gone (attempt once, then fall through to the error UI until the cooldown
 * lapses).
 */

import { logger } from "@elizaos/logger";

const CHUNK_RELOAD_AT_KEY = "eliza:chunk-reload-attempted-at";
const RELOAD_COOLDOWN_MS = 5 * 60 * 1000;

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message ?? "";
  return (
    error.name === "ChunkLoadError" ||
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("Importing a module script failed") ||
    message.includes("error loading dynamically imported module") ||
    /Expected a JavaScript-or-Wasm module script/.test(message)
  );
}

/**
 * Reload the page once per cooldown window to pick up the current deployment.
 * Returns true when a reload was initiated (callers should render a quiet
 * fallback — the page is about to go away), false when the attempt budget is
 * spent and the caller should show its real error state.
 */
export function tryChunkReloadRecovery(): boolean {
  if (typeof window === "undefined") return false;
  let lastAttempt = 0;
  try {
    lastAttempt = Number(
      window.sessionStorage.getItem(CHUNK_RELOAD_AT_KEY) ?? "0",
    );
  } catch {
    // error-policy:J3 storage denied (private mode) → an unreadable marker is
    // explicitly "never attempted"; worst case is one extra reload.
    lastAttempt = 0;
  }
  if (Date.now() - lastAttempt < RELOAD_COOLDOWN_MS) return false;
  try {
    window.sessionStorage.setItem(CHUNK_RELOAD_AT_KEY, String(Date.now()));
  } catch (err) {
    // error-policy:J6 marker write is best-effort; without it we may reload
    // once more than intended, never loop (the navigation itself rate-limits).
    logger.debug(
      `[ChunkLoadRecovery] could not persist reload marker: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  window.location.reload();
  return true;
}
