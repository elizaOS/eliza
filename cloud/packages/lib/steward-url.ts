const STEWARD_PREFIX = "/steward";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isUsableUrl(value: string | undefined): value is string {
  return Boolean(value && value.trim() && !value.includes("your_steward_"));
}

function getBrowserOrigin(): string | undefined {
  const location = (globalThis as typeof globalThis & { location?: { origin?: unknown } }).location;
  return typeof location?.origin === "string" ? location.origin : undefined;
}

function getBrowserHostname(): string | undefined {
  const location = (globalThis as typeof globalThis & { location?: { hostname?: unknown } })
    .location;
  return typeof location?.hostname === "string" ? location.hostname.toLowerCase() : undefined;
}

/**
 * Hostnames where the browser SPA is co-hosted with a Cloudflare Pages
 * deployment that proxies `/steward/*` to the Workers API. We bypass the
 * proxy and call `api.elizacloud.ai` directly so login keeps working
 * even when the Pages Functions bundle is missing or broken (the SPA
 * lives behind a CDN we do not always control).
 */
const ELIZA_CLOUD_PROXIED_HOSTS = new Set([
  "elizacloud.ai",
  "www.elizacloud.ai",
  "dev.elizacloud.ai",
]);
const ELIZA_CLOUD_DIRECT_API = "https://api.elizacloud.ai";

export type StewardUrlEnv = Record<string, unknown>;

function envString(env: StewardUrlEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

export function resolveBrowserStewardApiUrl(origin?: string): string {
  if (isUsableUrl(process.env.NEXT_PUBLIC_STEWARD_API_URL)) {
    return trimTrailingSlash(process.env.NEXT_PUBLIC_STEWARD_API_URL);
  }

  // When the SPA is loaded from a known elizacloud.ai host, skip the
  // same-origin Pages Functions proxy and hit the Workers API directly.
  // The Workers API allowlists these origins for CORS + credentials.
  const browserHost = getBrowserHostname();
  if (browserHost && ELIZA_CLOUD_PROXIED_HOSTS.has(browserHost)) {
    return `${ELIZA_CLOUD_DIRECT_API}${STEWARD_PREFIX}`;
  }

  const resolvedOrigin = origin || getBrowserOrigin();
  if (resolvedOrigin) {
    return `${trimTrailingSlash(resolvedOrigin)}${STEWARD_PREFIX}`;
  }

  if (isUsableUrl(process.env.NEXT_PUBLIC_API_URL)) {
    return `${trimTrailingSlash(process.env.NEXT_PUBLIC_API_URL)}${STEWARD_PREFIX}`;
  }

  return STEWARD_PREFIX;
}

export function resolveServerStewardApiUrlFromEnv(
  env: StewardUrlEnv = process.env,
  origin?: string,
): string {
  const stewardApiUrl = envString(env, "STEWARD_API_URL");
  const publicStewardApiUrl = envString(env, "NEXT_PUBLIC_STEWARD_API_URL");
  const publicApiUrl = envString(env, "NEXT_PUBLIC_API_URL");

  if (isUsableUrl(stewardApiUrl)) {
    return trimTrailingSlash(stewardApiUrl);
  }
  if (isUsableUrl(publicStewardApiUrl)) {
    return trimTrailingSlash(publicStewardApiUrl);
  }
  if (isUsableUrl(publicApiUrl)) {
    return `${trimTrailingSlash(publicApiUrl)}${STEWARD_PREFIX}`;
  }
  if (isUsableUrl(origin)) {
    return `${trimTrailingSlash(origin)}${STEWARD_PREFIX}`;
  }
  throw new Error(
    "Steward API URL is not configured. Set STEWARD_API_URL, NEXT_PUBLIC_STEWARD_API_URL, NEXT_PUBLIC_API_URL, or pass a request origin.",
  );
}

export function resolveServerStewardApiUrl(): string {
  return resolveServerStewardApiUrlFromEnv(process.env);
}
