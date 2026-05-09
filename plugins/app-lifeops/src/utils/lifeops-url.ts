import { client } from "@elizaos/ui";

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
