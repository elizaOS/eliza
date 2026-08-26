/** Reloads the existing desktop renderer after native loopback session authority is installed. */
import { logger } from "../logger";

interface ReloadableDesktopWindow {
  webview: {
    loadURL(url: string): void;
  };
}

interface DesktopSessionRendererReadyOptions {
  sessionPrimed: boolean;
  window: ReloadableDesktopWindow | null;
  resolveRendererUrl: () => Promise<string>;
}

/**
 * Give the already-created renderer one authoritative boot after the native
 * session cookies and embedded-agent ready state exist. The initial webview is
 * intentionally allowed to paint while the agent starts, but its pre-prime
 * 401/login stores must not remain authoritative for the process lifetime.
 */
export async function reloadRendererAfterDesktopSessionPrime({
  sessionPrimed,
  window,
  resolveRendererUrl,
}: DesktopSessionRendererReadyOptions): Promise<boolean> {
  if (!sessionPrimed || !window) return false;

  try {
    const rendererUrl = await resolveRendererUrl();
    window.webview.loadURL(rendererUrl);
    logger.info(
      "[Main] Reloaded desktop renderer after loopback session prime",
    );
    return true;
  } catch (error) {
    // error-policy:J4 The authenticated backend remains usable while the
    // renderer visibly retains its standard unavailable/login state.
    logger.warn(
      `[Main] Desktop renderer reload after session prime failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
