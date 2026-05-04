/**
 * Debug PTY Capture — optional session recording for offline analysis.
 *
 * Activated by setting `PARALLAX_DEBUG_CAPTURE=1`. When enabled, all PTY
 * output and stdin are recorded per-session using `pty-state-capture`.
 * Capture files persist in `.parallax/pty-captures/<sessionId>/` after
 * the agent session is killed, enabling post-mortem analysis of state
 * transitions, stall classifications, and coordinator timing.
 *
 * The `pty-state-capture` package is dynamically imported — if not
 * installed, capture is silently disabled. This means it can stay out
 * of production dependencies entirely.
 *
 * @module services/debug-capture
 */

import { logger } from "@elizaos/core";

/** Re-export the types we use so callers don't need to import pty-state-capture directly. */
interface CaptureManagerLike {
  openSession(
    sessionId: string,
    overrides?: { source?: string },
  ): Promise<unknown>;
  feed(
    sessionId: string,
    chunk: string,
    direction?: "stdout" | "stderr" | "stdin",
  ): Promise<unknown>;
  lifecycle(sessionId: string, event: string, detail?: string): Promise<void>;
  snapshot(sessionId: string): unknown | null;
}

let captureManager: CaptureManagerLike | null = null;
let initAttempted = false;

/**
 * Returns true if debug capture is enabled via environment variable.
 */
export function isDebugCaptureEnabled(): boolean {
  return process.env.PARALLAX_DEBUG_CAPTURE === "1";
}

/**
 * Lazily initialize the capture manager. Returns null if:
 * - PARALLAX_DEBUG_CAPTURE is not set to "1"
 * - pty-state-capture is not installed
 * - Initialization fails for any reason
 */
async function ensureCaptureManager(): Promise<CaptureManagerLike | null> {
  if (captureManager) return captureManager;
  if (initAttempted) return null;
  initAttempted = true;

  if (!isDebugCaptureEnabled()) return null;

  try {
    const mod = await import("pty-state-capture");
    const { PTYStateCaptureManager } = mod;
    captureManager = new PTYStateCaptureManager({
      outputRootDir: ".parallax/pty-captures",
      defaultRows: 80,
      defaultCols: 220,
    });
    logger.info(
      "[debug-capture] PTY state capture enabled — writing to .parallax/pty-captures/",
    );
    return captureManager;
  } catch {
    logger.debug(
      "[debug-capture] pty-state-capture not available — capture disabled",
    );
    return null;
  }
}

/**
 * Open a capture session for a PTY session. Call this when spawning.
 */
export async function captureSessionOpen(
  sessionId: string,
  agentType: string,
): Promise<void> {
  const mgr = await ensureCaptureManager();
  if (!mgr) return;
  try {
    await mgr.openSession(sessionId, { source: agentType });
  } catch (err) {
    logger.debug(`[debug-capture] Failed to open session ${sessionId}: ${err}`);
  }
}

/**
 * Feed PTY output data to the capture. Call this on every data chunk.
 */
export async function captureFeed(
  sessionId: string,
  chunk: string,
  direction: "stdout" | "stderr" | "stdin" = "stdout",
): Promise<void> {
  if (!captureManager) return;
  try {
    await captureManager.feed(sessionId, chunk, direction);
  } catch (err) {
    logger.debug(`[debug-capture] Feed error for ${sessionId}: ${err}`);
  }
}

/**
 * Record a lifecycle event (session_ready, session_stopped, etc.).
 */
export async function captureLifecycle(
  sessionId: string,
  event:
    | "session_started"
    | "session_ready"
    | "session_stopped"
    | "session_error",
  detail?: string,
): Promise<void> {
  if (!captureManager) return;
  try {
    await captureManager.lifecycle(sessionId, event, detail);
  } catch (err) {
    logger.debug(`[debug-capture] Lifecycle error for ${sessionId}: ${err}`);
  }
}

/**
 * Get a snapshot of a capture session's current state.
 */
export function captureSnapshot(sessionId: string): unknown | null {
  if (!captureManager) return null;
  try {
    return captureManager.snapshot(sessionId);
  } catch (err) {
    logger.debug(`[debug-capture] Snapshot error for ${sessionId}: ${err}`);
    return null;
  }
}

/** @internal Reset module state for testing only. */
export function _resetForTesting(): void {
  captureManager = null;
  initAttempted = false;
}
