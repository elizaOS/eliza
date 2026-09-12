/** Resolves the login service for browser proxies and server-side authentication clients. */
import { ElizaError } from "@elizaos/core/errors";

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
 * proxy and call the matching API worker directly so login keeps working
 * even when the Pages Functions bundle is missing or broken (the SPA
 * lives behind a CDN we do not always control).
 */
const ELIZA_CLOUD_DIRECT_API_BY_HOST: Record<string, string> = {
  "eliza.app": "https://api.eliza.app",
  "cloud.eliza.app": "https://api.eliza.app",
  "staging.eliza.app": "https://api-staging.eliza.app",
  "cloud-staging.eliza.app": "https://api-staging.eliza.app",
};

export type StewardUrlEnv = Record<string, unknown>;

function envString(env: StewardUrlEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

export function resolveBrowserStewardApiUrl(origin?: string): string {
  if (isUsableUrl(process.env.NEXT_PUBLIC_STEWARD_API_URL)) {
    return trimTrailingSlash(process.env.NEXT_PUBLIC_STEWARD_API_URL);
  }

  // When the SPA is loaded from a known managed eliza.app host, skip the
  // same-origin Pages Functions proxy and hit the Workers API directly.
  // The Workers API allowlists these origins for CORS + credentials.
  const browserHost = getBrowserHostname();
  const directApi = browserHost ? ELIZA_CLOUD_DIRECT_API_BY_HOST[browserHost] : undefined;
  if (directApi) {
    return `${directApi}${STEWARD_PREFIX}`;
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
  if (env.LOGIN_API_URL !== undefined) {
    const configured = envString(env, "LOGIN_API_URL");
    let url: URL;
    try {
      url = new URL(configured ?? "");
    } catch (cause) {
      // error-policy:J2 reject invalid authoritative routing without switching services.
      throw new ElizaError("LOGIN_API_URL must be an absolute HTTP(S) service URL", {
        code: "LOGIN_UPSTREAM_URL_INVALID",
        cause,
      });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ElizaError("LOGIN_API_URL must use HTTP or HTTPS", {
        code: "LOGIN_UPSTREAM_URL_INVALID",
      });
    }
    return trimTrailingSlash(url.toString());
  }
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
    "Login API URL is not configured. Set LOGIN_API_URL or supply a cloud proxy origin.",
  );
}

export function resolveServerStewardApiUrl(): string {
  return resolveServerStewardApiUrlFromEnv(process.env);
}
