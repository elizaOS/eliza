/**
 * Resolve app-shipped public assets (e.g. vrms/, animations/) to runtime-safe URLs.
 *
 * In packaged desktop builds, the renderer can run on file:// and later navigate to
 * absolute paths (e.g. /chat). Root-relative assets like /vrms/1.vrm then
 * resolve to file:///vrms/1.vrm and fail. We lock the asset base URL once from
 * initial startup and resolve assets against that stable base.
 */

type AssetUrlResolveOptions = {
  currentUrl?: string;
  baseUrl?: string;
};

let cachedRuntimeBaseHref: string | null = null;

function stripLeadingPathMarkers(assetPath: string): string {
  return assetPath
    .trim()
    .replace(/^\.?\//, "")
    .replace(/^\/+/, "");
}

function isAlreadyAbsolute(assetPath: string): boolean {
  if (assetPath.startsWith("//")) return true;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(assetPath);
}

function inferBaseForUrl(url: URL): string {
  if (url.protocol !== "file:") return "/";

  const pathname = url.pathname || "/";
  if (pathname.endsWith("/")) return pathname;

  const lastSlash = pathname.lastIndexOf("/");
  if (lastSlash < 0) return "/";

  const tail = pathname.slice(lastSlash + 1);
  // If the path ends in a file name, use that file's directory.
  if (tail.includes(".")) return pathname.slice(0, lastSlash + 1) || "/";

  return "/";
}

function computeBaseHref(currentUrl: string, baseUrl?: string): string {
  const current = new URL(currentUrl);
  const base = baseUrl?.trim() || inferBaseForUrl(current);
  return new URL(base, current).href;
}

function runtimeBaseHref(): string | null {
  if (cachedRuntimeBaseHref) return cachedRuntimeBaseHref;
  if (typeof window === "undefined") return null;

  const href = (window.location as { href?: unknown } | undefined)?.href;
  if (typeof href !== "string" || !href) return null;

  try {
    const viteBaseUrl = (import.meta as { env?: { BASE_URL?: string } }).env
      ?.BASE_URL;
    cachedRuntimeBaseHref = computeBaseHref(href, viteBaseUrl);
    return cachedRuntimeBaseHref;
  } catch {
    return null;
  }
}

/**
 * Resolve an app public asset path into a URL safe across http(s), custom
 * schemes, and packaged file:// runtimes.
 */
export function resolveAppAssetUrl(
  assetPath: string,
  options?: AssetUrlResolveOptions,
): string {
  if (!assetPath) return assetPath;
  if (isAlreadyAbsolute(assetPath)) return assetPath;

  const normalized = stripLeadingPathMarkers(assetPath);
  if (!normalized) return normalized;

  if (options?.currentUrl) {
    try {
      const baseHref = computeBaseHref(options.currentUrl, options.baseUrl);
      return new URL(normalized, baseHref).toString();
    } catch {
      return `/${normalized}`;
    }
  }

  const baseHref = runtimeBaseHref();
  if (!baseHref) return `/${normalized}`;

  return new URL(normalized, baseHref).toString();
}

/**
 * Resolve an API path (e.g. "/api/avatar/vrm") to a full URL reachable from
 * the renderer. In desktop shells the page origin is electrobun:// or
 * file://, so bare /api/... paths resolve to the SPA instead of the backend.
 * This helper prefixes with window.__MILADY_API_BASE__ when available.
 */
export function resolveApiUrl(apiPath: string): string {
  if (typeof window !== "undefined") {
    const base = (window as unknown as Record<string, unknown>)
      .__MILADY_API_BASE__ as string | undefined;
    if (base) return `${base}${apiPath}`;
  }
  return apiPath;
}
