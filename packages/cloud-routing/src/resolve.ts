import type { IAgentRuntime } from "@elizaos/core";
import type { CloudRoute, RouteSpec } from "./types.ts";

const CLOUD_BASE_FALLBACK = "https://www.elizacloud.ai/api/v1";

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function getSettingAsString(
  runtime: IAgentRuntime,
  key: string,
): string | null {
  const raw = runtime.getSetting(key);
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  return str.length > 0 ? str : null;
}

/**
 * Returns true iff ELIZAOS_CLOUD_API_KEY is non-empty AND
 * ELIZAOS_CLOUD_ENABLED is truthy ("true", "1", or boolean true).
 */
export function isCloudConnected(runtime: IAgentRuntime): boolean {
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
  runtime: IAgentRuntime,
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

  if (isCloudConnected(runtime)) {
    const cloudApiKey = getSettingAsString(
      runtime,
      "ELIZAOS_CLOUD_API_KEY",
    ) as string;
    const cloudBaseRaw =
      getSettingAsString(runtime, "ELIZAOS_CLOUD_BASE_URL") ??
      CLOUD_BASE_FALLBACK;
    const cloudBase = stripTrailingSlashes(cloudBaseRaw);
    return {
      source: "cloud-proxy",
      baseUrl: `${cloudBase}/apis/${spec.service}`,
      headers: { Authorization: `Bearer ${cloudApiKey}` },
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
