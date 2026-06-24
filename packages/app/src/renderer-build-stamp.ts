/**
 * Surfaces the renderer build stamp (issue #9309) at runtime so the running
 * build's identity is observable in-app and assertable by on-device smokes.
 *
 * The vite `renderer-build-manifest` plugin ships `eliza-renderer-build.json`
 * at the web root; on boot we fetch it once, log it, and expose it on
 * `window.__ELIZA_RENDERER_BUILD__`. An on-device/simulator smoke can then read
 * that global (or fetch the file) and assert the running build's `buildId`
 * equals the freshly built one — proving the device is not running stale UI.
 *
 * Best-effort by design: dev servers do not emit a manifest, so a miss is
 * silent and never blocks boot. This is observability at a real runtime
 * boundary, not error-swallowing business logic.
 */
export interface RendererBuildStamp {
  schema: string;
  buildId: string;
  indexHtmlSha256: string;
  builtAt: string;
  commit: string | null;
  variant: string | null;
  capacitorTarget: string | null;
}

declare global {
  interface Window {
    __ELIZA_RENDERER_BUILD__?: RendererBuildStamp | null;
  }
}

const MANIFEST_FILENAME = "eliza-renderer-build.json";

export async function loadRendererBuildStamp(): Promise<RendererBuildStamp | null> {
  try {
    // Resolve against the document base so it works on web, Capacitor
    // (capacitor://localhost/), and Electrobun static hosting alike.
    const url = new URL(MANIFEST_FILENAME, document.baseURI).toString();
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      window.__ELIZA_RENDERER_BUILD__ = null;
      return null;
    }
    const stamp = (await response.json()) as RendererBuildStamp;
    window.__ELIZA_RENDERER_BUILD__ = stamp;
    console.info(
      `[renderer-build] ${stamp.buildId.slice(0, 12)} built ${stamp.builtAt}` +
        ` (variant=${stamp.variant ?? "?"}, target=${stamp.capacitorTarget ?? "web/desktop"})`,
    );
    return stamp;
  } catch {
    // No manifest (dev) or a transient fetch failure — never block boot.
    window.__ELIZA_RENDERER_BUILD__ = null;
    return null;
  }
}

// Kick off without blocking boot.
void loadRendererBuildStamp();
