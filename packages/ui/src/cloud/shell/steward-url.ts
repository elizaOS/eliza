/**
 * Browser-side Steward API URL resolution for the app-hosted cloud surfaces.
 *
 * Ported from `@elizaos/cloud-shared/lib/steward-url` (which is not a dependency
 * of `@elizaos/ui`) so the app shell can resolve the Steward mount without
 * pulling the cloud-shared server bundle. The default is the same-origin
 * `/steward` mount; known elizacloud.ai hosts bypass the Pages proxy and call
 * the matching API worker directly (the Worker allowlists those origins for
 * CORS + credentials).
 */

const STEWARD_PREFIX = "/steward";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isUsableUrl(value: string | undefined): value is string {
  return Boolean(value?.trim() && !value.includes("your_steward_"));
}

function getBrowserOrigin(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const origin = window.location?.origin;
  return typeof origin === "string" ? origin : undefined;
}

function getBrowserHostname(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const hostname = window.location?.hostname;
  return typeof hostname === "string" ? hostname.toLowerCase() : undefined;
}

/**
 * Hostnames where the SPA is co-hosted with a Cloudflare Pages deployment that
 * proxies `/steward/*` to the Workers API. We bypass the proxy and call the
 * matching API worker directly so login keeps working even when the Pages
 * Functions bundle is missing or broken.
 */
const ELIZA_CLOUD_DIRECT_API_BY_HOST: Record<string, string> = {
  "elizacloud.ai": "https://api.elizacloud.ai",
  "www.elizacloud.ai": "https://api.elizacloud.ai",
  "dev.elizacloud.ai": "https://api.elizacloud.ai",
  "staging.elizacloud.ai": "https://api-staging.elizacloud.ai",
};

export function resolveBrowserStewardApiUrl(origin?: string): string {
  // Vite inlines this only via the literal property name.
  const override =
    import.meta.env?.NEXT_PUBLIC_STEWARD_API_URL ??
    (typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_STEWARD_API_URL
      : undefined);
  if (isUsableUrl(override)) {
    return trimTrailingSlash(override);
  }

  const browserHost = getBrowserHostname();
  const directApi = browserHost
    ? ELIZA_CLOUD_DIRECT_API_BY_HOST[browserHost]
    : undefined;
  if (directApi) {
    return `${directApi}${STEWARD_PREFIX}`;
  }

  const resolvedOrigin = origin ?? getBrowserOrigin();
  if (resolvedOrigin) {
    return `${trimTrailingSlash(resolvedOrigin)}${STEWARD_PREFIX}`;
  }

  return STEWARD_PREFIX;
}
