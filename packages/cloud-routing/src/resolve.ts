import type { CloudRoute, RouteSpec } from "./types.ts";

const CLOUD_BASE_FALLBACK = "https://www.elizacloud.ai/api/v1";

/**
 * Structural subset of `IAgentRuntime` we actually need. Avoids a hard
 * dep on `@elizaos/core` (which would force a single nominal version on
 * every consumer) — any runtime whose `getSetting(key)` returns a
 * primitive scalar is accepted.
 */
export interface RuntimeSettings {
  getSetting(key: string): string | boolean | number | null | undefined;
}

/**
 * Narrow elizaOS `IAgentRuntime#getSetting` (or any wider return type) to
 * {@link RuntimeSettings} without depending on `@elizaos/core`.
 */
export function toRuntimeSettings(runtime: {
  getSetting(
    key: string,
  ): string | boolean | number | bigint | null | undefined;
}): RuntimeSettings {
  return {
    getSetting(key: string): string | boolean | number | null | undefined {
      const v = runtime.getSetting(key);
      if (v === null || v === undefined) return v;
      if (
        typeof v === "string" ||
        typeof v === "boolean" ||
        typeof v === "number"
      ) {
        return v;
      }
      if (typeof v === "bigint") return v.toString();
      return String(v);
    },
  };
}

/**
 * When Eliza Cloud is connected, returns `{ baseUrl, headers }` for
 * `GET ${baseUrl}/{path}` against `/apis/{service}` with Bearer cloud auth.
 */
export function cloudServiceApisBaseUrl(
  runtime: RuntimeSettings,
  service: string,
): { baseUrl: string; headers: Record<string, string> } | null {
  return buildCloudProxyRoute(runtime, service);
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function getSettingAsString(
  runtime: RuntimeSettings,
  key: string,
): string | null {
  const raw = runtime.getSetting(key);
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  return str.length > 0 ? str : null;
}

function buildCloudProxyRoute(
  runtime: RuntimeSettings,
  service: string,
): { baseUrl: string; headers: Record<string, string> } | null {
  if (!isCloudConnected(runtime)) return null;
  const cloudApiKey = getSettingAsString(runtime, "ELIZAOS_CLOUD_API_KEY");
  if (cloudApiKey === null) return null;
  const cloudBaseRaw =
    getSettingAsString(runtime, "ELIZAOS_CLOUD_BASE_URL") ??
    CLOUD_BASE_FALLBACK;
  const cloudBase = stripTrailingSlashes(cloudBaseRaw);
  const svc = service.replace(/^\/+|\/+$/g, "");
  return {
    baseUrl: `${cloudBase}/apis/${svc}`,
    headers: { Authorization: `Bearer ${cloudApiKey}` },
  };
}

/**
 * Returns true iff ELIZAOS_CLOUD_API_KEY is non-empty AND
 * ELIZAOS_CLOUD_ENABLED is truthy ("true", "1", or boolean true).
 */
export function isCloudConnected(runtime: RuntimeSettings): boolean {
  const apiKey = getSettingAsString(runtime, "ELIZAOS_CLOUD_API_KEY");
  if (apiKey === null) return false;

  const enabled = runtime.getSetting("ELIZAOS_CLOUD_ENABLED");
  if (enabled === true) return true;
  if (typeof enabled === "string") {
    const lower = enabled.trim().toLowerCase();
    return lower === "true" || lower === "1";
  }
  return false;
}

/**
 * Resolve the cloud route for a service. Three mutually exclusive branches:
 *
 * 1. **local-key** — the user set a local API key in runtime settings.
 * 2. **cloud-proxy** — no local key, but Eliza Cloud is connected.
 * 3. **disabled** — neither is available.
 *
 * Local key always wins when both are set.
 */
export function resolveCloudRoute(
  runtime: RuntimeSettings,
  spec: RouteSpec,
): CloudRoute {
  const localKey = getSettingAsString(runtime, spec.localKeySetting);

  if (localKey !== null) {
    const baseUrl = stripTrailingSlashes(spec.upstreamBaseUrl);
    const headers = buildLocalKeyHeaders(spec, localKey);
    return {
      source: "local-key",
      baseUrl,
      headers,
      reason: `local key set: ${spec.localKeySetting}`,
    };
  }

  const cloudRoute = buildCloudProxyRoute(runtime, spec.service);
  if (cloudRoute) {
    return {
      source: "cloud-proxy",
      ...cloudRoute,
      reason: "cloud proxy: ELIZAOS_CLOUD_API_KEY",
    };
  }

  return {
    source: "disabled",
    reason: `no local ${spec.localKeySetting} and cloud not connected`,
  };
}

function buildLocalKeyHeaders(
  spec: RouteSpec,
  key: string,
): Record<string, string> {
  switch (spec.localKeyAuth.kind) {
    case "header":
      return { [spec.localKeyAuth.headerName]: key };
    case "bearer":
      return { Authorization: `Bearer ${key}` };
    case "query":
      return {};
  }
}
