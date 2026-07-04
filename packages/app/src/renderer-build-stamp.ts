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
/** Mirrors the canonical manifest written by buildRendererManifest() in
 * `@elizaos/app-core/scripts/lib/renderer-build-manifest.mjs`. */
export interface RendererBuildStamp {
  schema: string;
  buildId: string;
  indexHtmlSha256: string;
  assetCount: number;
  builtAt: string;
  commit: string | null;
  variant: string | null;
  capacitorTarget: string | null;
  runtimeMode: string | null;
}

declare global {
  interface Window {
    __ELIZA_RENDERER_BUILD__?: RendererBuildStamp | null;
  }
}

const MANIFEST_FILENAME = "eliza-renderer-build.json";

export async function loadRendererBuildStamp(): Promise<RendererBuildStamp | null> {
  // The manifest is only emitted by production `vite build`, never the dev
  // server. Skip the fetch in dev so we don't log a spurious 404 (which would
  // also trip e2e smokes that assert zero console errors).
  if (import.meta.env?.DEV) {
    window.__ELIZA_RENDERER_BUILD__ = null;
    return null;
  }
  try {
    // The manifest is emitted at the web root. On the absolute-base web build
    // (ELIZA_WEB_ABSOLUTE_BASE=1 → Vite base "/"), `document.baseURI` points at
    // the current deep SPA route (e.g. /auth/cli-login), so resolving against it
    // would fetch /auth/eliza-renderer-build.json (404). Resolve from the origin
    // root there. Native / relative-base builds (Capacitor https://localhost,
    // Electrobun static hosting) keep resolving against the document base, where
    // the document already lives at the root — so their behavior is unchanged.
    const base = import.meta.env?.BASE_URL ?? "./";
    const url =
      base === "/"
        ? new URL(MANIFEST_FILENAME, window.location.origin).toString()
        : new URL(MANIFEST_FILENAME, document.baseURI).toString();
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
    // error-policy:J4 no manifest (dev) or a transient fetch failure — the
    // stamp is diagnostics only and must never block boot.
    window.__ELIZA_RENDERER_BUILD__ = null;
    return null;
  }
}

// Kick off without blocking boot.
void loadRendererBuildStamp();
