/** Implements Electrobun desktop desktop session prime ts behavior for app-core shell integration. */
import { Session } from "electrobun/bun";
import { logger } from "../logger";
import { resolveMainWindowPartition } from "../main-window-session";
import {
  type DesktopSession,
  installDesktopSessionCookies,
  loadOrCreateDesktopSession,
} from "../native/auth-bridge";

// The agent emits several status changes while one startup settles. Keep the
// proof exchange single-flight: every exchange owns a one-shot Unix socket,
// and overlapping retries can otherwise hammer the auth route before its
// database is ready and starve the embedded API.
let desktopSessionPrimedApiBase: string | null = null;
let desktopSessionPrimeInFlight: Promise<void> | null = null;
let desktopSessionPrimeInFlightApiBase: string | null = null;
let desktopSessionRetryTimer: ReturnType<typeof setTimeout> | null = null;
let desktopSessionFailureCount = 0;

const DESKTOP_SESSION_RETRY_BASE_MS = 500;
const DESKTOP_SESSION_RETRY_MAX_MS = 15_000;

/**
 * Reset the primed flag so the next call to primeDesktopSessionAuth() re-runs
 * the bridge. Used when the embedded agent rebinds to a new loopback port —
 * cookies installed for the old origin don't authenticate the new one.
 */
export function markDesktopSessionStale(): void {
  desktopSessionPrimedApiBase = null;
  desktopSessionFailureCount = 0;
  if (desktopSessionRetryTimer) {
    clearTimeout(desktopSessionRetryTimer);
    desktopSessionRetryTimer = null;
  }
}

/** Reset module state between focused tests. Never called by the app. */
export function _resetDesktopSessionPrimeForTests(): void {
  markDesktopSessionStale();
  desktopSessionPrimeInFlight = null;
  desktopSessionPrimeInFlightApiBase = null;
}

function scheduleDesktopSessionRetry(
  apiBase: string,
  rendererOrigin: string,
): void {
  if (desktopSessionRetryTimer) return;
  const exponent = Math.max(0, desktopSessionFailureCount - 1);
  const delay = Math.min(
    DESKTOP_SESSION_RETRY_MAX_MS,
    DESKTOP_SESSION_RETRY_BASE_MS * 2 ** exponent,
  );
  desktopSessionRetryTimer = setTimeout(() => {
    desktopSessionRetryTimer = null;
    void primeDesktopSessionAuth(apiBase, rendererOrigin);
  }, delay);
}

/**
 * Best-effort: mint (or reuse) a loopback-only desktop session and install the
 * cookies into the main window's session jar so the renderer's first /api
 * request is already authenticated. Failure is silent — the renderer falls
 * back to the standard login flow.
 *
 * Loopback-only enforcement is implemented server-side: the auth-context
 * resolver MUST refuse a session marked loopback-only on a non-loopback
 * request. The bridge does not — and cannot — be that boundary.
 */
export async function primeDesktopSessionAuth(
  apiBase: string,
  rendererOrigin: string,
): Promise<void> {
  if (desktopSessionPrimedApiBase === apiBase) return;
  if (desktopSessionRetryTimer) return;

  if (desktopSessionPrimeInFlight) {
    await desktopSessionPrimeInFlight;
    if (desktopSessionPrimedApiBase === apiBase) return;
    // A port rollover can arrive while the old origin is still finishing.
    // Let the new origin take its own turn once the prior proof is closed.
    if (desktopSessionPrimeInFlightApiBase !== apiBase) {
      return primeDesktopSessionAuth(apiBase, rendererOrigin);
    }
    return;
  }

  const run = async (): Promise<void> => {
    let session: DesktopSession | null;
    try {
      session = await loadOrCreateDesktopSession({ apiBase });
    } catch (err) {
      desktopSessionFailureCount += 1;
      logger.warn(
        `[Main] Desktop auth bridge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      scheduleDesktopSessionRetry(apiBase, rendererOrigin);
      return;
    }
    if (!session) {
      desktopSessionFailureCount += 1;
      logger.info(
        "[Main] Desktop auth bridge is not ready; retrying with bounded backoff.",
      );
      scheduleDesktopSessionRetry(apiBase, rendererOrigin);
      return;
    }

    try {
      const partition = resolveMainWindowPartition(process.env);
      const electrobunSession =
        partition !== null
          ? Session.fromPartition(partition)
          : Session.defaultSession;
      const installer = electrobunSession.cookies as {
        set: Parameters<typeof installDesktopSessionCookies>[0]["set"];
      };
      const touched = installDesktopSessionCookies(installer, session, {
        apiOrigin: apiBase,
        rendererOrigin,
      });
      desktopSessionPrimedApiBase = apiBase;
      desktopSessionFailureCount = 0;
      if (desktopSessionRetryTimer) {
        clearTimeout(desktopSessionRetryTimer);
        desktopSessionRetryTimer = null;
      }
      logger.info(
        `[Main] Desktop loopback session primed on ${touched.join(", ") || "<no targets>"}`,
      );
    } catch (err) {
      desktopSessionFailureCount += 1;
      logger.warn(
        `[Main] Desktop auth cookie install failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      scheduleDesktopSessionRetry(apiBase, rendererOrigin);
    }
  };

  desktopSessionPrimeInFlightApiBase = apiBase;
  desktopSessionPrimeInFlight = run().finally(() => {
    desktopSessionPrimeInFlight = null;
    desktopSessionPrimeInFlightApiBase = null;
  });
  await desktopSessionPrimeInFlight;
}
