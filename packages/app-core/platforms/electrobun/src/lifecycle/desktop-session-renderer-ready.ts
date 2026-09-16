/** Reloads the existing desktop renderer after native loopback session authority is installed. */
import { logger } from "../logger";

interface ReloadableDesktopWindow {
  webview: {
    loadURL(url: string): void;
  };
}

interface DesktopSessionRendererReadyOptions {
  sessionPrimed: boolean;
  backendGeneration: string;
  window: ReloadableDesktopWindow | null;
  resolveRendererUrl: () => Promise<string>;
}

const reloadedGenerationByWindow = new WeakMap<
  ReloadableDesktopWindow,
  string
>();

/**
 * Give the already-created renderer one authoritative boot after the native
 * session cookies and embedded-agent ready state exist. The initial webview is
 * intentionally allowed to paint while the agent starts, but its pre-prime
 * 401/login stores must not remain authoritative for the process lifetime.
 */
export async function reloadRendererAfterDesktopSessionPrime({
  sessionPrimed,
  backendGeneration,
  window,
  resolveRendererUrl,
}: DesktopSessionRendererReadyOptions): Promise<boolean> {
  if (!sessionPrimed || !window) return false;
  if (reloadedGenerationByWindow.get(window) === backendGeneration) {
    return false;
  }

  // Reserve before the asynchronous URL lookup. Embedded startup has both a
  // direct start caller and a status listener; they may converge on the same
  // ready generation before either reload completes.
  reloadedGenerationByWindow.set(window, backendGeneration);

  try {
    const rendererUrl = await resolveRendererUrl();
    // A newer generation may have reserved this window while the URL lookup
    // above was in flight. Only the generation that still owns the
    // reservation after the await may navigate or log success; a superseded
    // generation must not clobber the newer generation's window state.
    if (reloadedGenerationByWindow.get(window) !== backendGeneration) {
      return false;
    }
    window.webview.loadURL(rendererUrl);
    logger.info(
      "[Main] Reloaded desktop renderer after loopback session prime",
    );
    return true;
  } catch (error) {
    if (reloadedGenerationByWindow.get(window) === backendGeneration) {
      reloadedGenerationByWindow.delete(window);
    }
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
