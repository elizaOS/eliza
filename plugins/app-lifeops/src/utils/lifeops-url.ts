import { client } from "@elizaos/app-core";

function resolveLocationOrigin(): string | null {
  if (
    typeof globalThis.location?.origin === "string" &&
    globalThis.location.origin.trim().length > 0
  ) {
    return globalThis.location.origin.trim();
  }

  if (
    typeof window !== "undefined" &&
    typeof window.location?.origin === "string" &&
    window.location.origin.trim().length > 0
  ) {
    return window.location.origin.trim();
  }

  return null;
}

function resolveLifeOpsBaseUrl(fallback: string): URL {
  const baseUrl = client.getBaseUrl().trim();
  if (baseUrl) {
    return new URL(baseUrl);
  }

  return new URL(resolveLocationOrigin() ?? fallback);
}

export function resolveBrowserBridgeApiBaseUrl(): string {
  return resolveLifeOpsBaseUrl("http://127.0.0.1:31337")
    .toString()
    .replace(/\/+$/, "");
}

export function resolveLifeOpsSettingsApiBaseUrl(): URL {
  return resolveLifeOpsBaseUrl("http://127.0.0.1:3000");
}

export function resolveLifeOpsLocalGoogleRedirectUri(apiBaseUrl: URL): string {
  const port =
    apiBaseUrl.port || (apiBaseUrl.protocol === "https:" ? "443" : "80");
  return `http://127.0.0.1:${port}/api/lifeops/connectors/google/callback`;
}

export function resolveLifeOpsRemoteGoogleRedirectUri(apiBaseUrl: URL): string {
  return `${apiBaseUrl.origin}/api/lifeops/connectors/google/callback`;
}
