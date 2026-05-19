/**
 * Resolve app-shipped public assets (e.g. vrms/, animations/) to runtime-safe URLs.
 *
 * In packaged desktop builds, the renderer can run on file:// and later navigate to
 * absolute paths (e.g. /chat). Root-relative assets like /vrms/1.vrm then
 * resolve to file:///vrms/1.vrm and fail. We lock the asset base URL once from
 * initial startup and resolve assets against that stable base.
 */
import { getBootConfig } from "../config/boot-config";
import { getElizaApiBase } from "./eliza-globals";

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

function normalizeBaseHref(baseHref: string): string {
  return baseHref.endsWith("/") ? baseHref : `${baseHref}/`;
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

/**
 * For http/https origins (web + Electrobun dev static server) the static asset
 * root is always the origin root. We must NOT honor Vite's `base: "./"` here
 * because relative resolution against the current SPA route URL produces
 * `/apps/app-heroes/...` etc., which the SPA's catch-all returns HTML for —
 * silently breaking <img> tags via decode errors.
 */
function shouldIgnoreViteBase(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function computeBaseHref(currentUrl: string, baseUrl?: string): string {
  const current = new URL(currentUrl);
  const explicit = baseUrl?.trim();
  const base =
    explicit && !shouldIgnoreViteBase(current)
      ? explicit
      : inferBaseForUrl(current);
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

  const configuredBaseUrl = getBootConfig().assetBaseUrl?.trim();
  if (configuredBaseUrl) {
    try {
      return new URL(
        normalized,
        normalizeBaseHref(configuredBaseUrl),
      ).toString();
    } catch {
      // Fall through to local runtime resolution when the configured CDN base is invalid.
    }
  }

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

/** Keep in sync with `ElizaClient` SESSION_STORAGE_API_BASE_KEY. */
const ELIZA_API_BASE_SESSION_KEY = "elizaos_api_base";

function readSessionStorageApiBase(): string | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    const raw = window.sessionStorage.getItem(ELIZA_API_BASE_SESSION_KEY);
    const trimmed = raw?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an API path (e.g. "/api/avatar/vrm") to a full URL reachable from
 * the renderer. In desktop shells the page origin is electrobun:// or
 * file://, so bare /api/... paths resolve to the SPA instead of the backend.
 *
 * Resolution order: boot `apiBase` → shell-injected `__ELIZAOS_API_BASE__` →
 * `sessionStorage` fallback. The boot config is the current client-owned
 * source of truth because `client.setBaseUrl()` updates it whenever the user
 * switches servers. Injection still beats stale session state from prior
 * sessions, but it must not override the active runtime target once the client
 * has changed it.
 */
export function resolveApiUrl(apiPath: string): string {
  const bootRaw = getBootConfig().apiBase?.trim();
  const boot = bootRaw && bootRaw.length > 0 ? bootRaw : undefined;
  const injectedRaw = getElizaApiBase()?.trim();
  const injected =
    injectedRaw && injectedRaw.length > 0 ? injectedRaw : undefined;
  const stored = readSessionStorageApiBase();
  const base = boot ?? injected ?? stored;
  if (!base) return apiPath;
  const normalized = base.replace(/\/+$/, "");
  const suffix = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  return `${normalized}${suffix}`;
}
