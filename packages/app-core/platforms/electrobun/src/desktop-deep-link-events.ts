/** Implements Electrobun desktop desktop deep link events ts behavior for app-core shell integration. */
export function readOpenUrlEventUrl(event: unknown): string | null {
  if (typeof event === "string") {
    const url = event.trim();
    return url.length > 0 ? url : null;
  }
  if (!event || typeof event !== "object") return null;

  const record = event as {
    url?: unknown;
    data?: { url?: unknown };
  };
  const rawUrl = typeof record.url === "string" ? record.url : record.data?.url;
  if (typeof rawUrl !== "string") return null;

  const url = rawUrl.trim();
  return url.length > 0 ? url : null;
}

/**
 * Where a `<scheme>://…` deep link should be routed. `app` opens a desktop app
 * window/details for `slug`; `forward` hands the raw URL to the renderer.
 */
export type DeepLinkRoute =
  | { readonly kind: "app"; readonly slug: string }
  | { readonly kind: "forward" };

/**
 * Classify a deep-link URL into an app-window open vs a renderer forward. Pure so
 * the routing decision is unit-testable without an Electrobun window.
 *
 * Custom URL schemes parse with an OPAQUE host, which — unlike special schemes
 * like http — is NOT lowercased by the URL parser (`new URL("elizaos://Apps/x")`
 * → host `"Apps"`). Matching `parsed.host === "apps"` therefore mis-routed a
 * mixed/upper-case authored link (`ELIZAOS://Apps/plugin-viewer`) to the generic
 * forward instead of the app window; normalize the host before comparing. (#10720)
 */
export function classifyDeepLinkRoute(url: string): DeepLinkRoute {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "forward" };
  }
  // `<scheme>://apps/<slug>` → host="apps", pathname="/<slug>".
  if (parsed.host.toLowerCase() === "apps") {
    const slug = parsed.pathname.replace(/^\/+/, "").split("/")[0];
    if (slug) return { kind: "app", slug };
  }
  return { kind: "forward" };
}
