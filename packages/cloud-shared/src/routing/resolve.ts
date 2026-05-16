import {
  DEFAULT_FEATURE_POLICY,
  FEATURE_IDS,
  type Feature,
  type FeaturePolicy,
  type FeaturePolicyMap,
  getFeature,
  isFeaturePolicy,
} from "./features.ts";
import type { CloudRoute, FeatureCloudRoute, RouteSpec } from "./types.ts";

const CLOUD_BASE_FALLBACK = "https://www.elizacloud.ai/api/v1";

export interface RuntimeSettings {
  getSetting(key: string): string | boolean | number | null | undefined;
}

/**
 * Narrow elizaOS `IAgentRuntime#getSetting` (or any wider return type) to
 * {@link RuntimeSettings} without depending on `@elizaos/core`.
 */
export function toRuntimeSettings(runtime: { getSetting(key: string): unknown }): RuntimeSettings {
  return {
    getSetting(key: string): string | boolean | number | null | undefined {
      const v = runtime.getSetting(key);
      if (v === null || v === undefined) return v;
      if (typeof v === "string" || typeof v === "boolean" || typeof v === "number") {
        return v;
      }
      if (typeof v === "bigint") return v.toString();
      return String(v);
    },
  };
}

export function cloudServiceApisBaseUrl(
  runtime: RuntimeSettings,
  service: string,
): { baseUrl: string; headers: Record<string, string> } | null {
  return buildCloudProxyRoute(runtime, service);
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function getSettingAsString(runtime: RuntimeSettings, key: string): string | null {
  const raw = runtime.getSetting(key);
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  return str.length > 0 ? str : null;
}

function buildCloudProxyRoute(
  runtime: RuntimeSettings,
  service: string,
): { baseUrl: string; headers: Record<string, string> } | null {
  const cloudApiKey = getSettingAsString(runtime, "ELIZAOS_CLOUD_API_KEY");
  if (cloudApiKey === null || !isCloudRoutingEnabled(runtime)) return null;
  const cloudBaseRaw = getSettingAsString(runtime, "ELIZAOS_CLOUD_BASE_URL") ?? CLOUD_BASE_FALLBACK;
  const cloudBase = stripTrailingSlashes(cloudBaseRaw);
  const svc = service.replace(/^\/+|\/+$/g, "");
  return {
    baseUrl: `${cloudBase}/apis/${svc}`,
    headers: { Authorization: `Bearer ${cloudApiKey}` },
  };
}

export function isCloudConnected(runtime: RuntimeSettings): boolean {
  return (
    getSettingAsString(runtime, "ELIZAOS_CLOUD_API_KEY") !== null && isCloudRoutingEnabled(runtime)
  );
}

function isCloudRoutingEnabled(runtime: RuntimeSettings): boolean {
  const enabled = runtime.getSetting("ELIZAOS_CLOUD_ENABLED");
  if (enabled === true) return true;
  if (typeof enabled === "string") {
    const lower = enabled.trim().toLowerCase();
    return lower === "true" || lower === "1";
  }
  return false;
}

export function resolveCloudRoute(runtime: RuntimeSettings, spec: RouteSpec): CloudRoute {
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

function buildLocalKeyHeaders(spec: RouteSpec, key: string): Record<string, string> {
  switch (spec.localKeyAuth.kind) {
    case "header":
      return { [spec.localKeyAuth.headerName]: key };
    case "bearer":
      return { Authorization: `Bearer ${key}` };
    case "query":
      return {};
  }
}

export function getFeaturePolicy(runtime: RuntimeSettings, feature: string): FeaturePolicy {
  const def = getFeature(feature);
  if (def === null) return DEFAULT_FEATURE_POLICY;
  const raw = runtime.getSetting(def.settingKey);
  if (typeof raw === "string") {
    const trimmed = raw.trim().toLowerCase();
    if (isFeaturePolicy(trimmed)) return trimmed;
  }
  return DEFAULT_FEATURE_POLICY;
}

export function getFeaturePolicyMap(runtime: RuntimeSettings): FeaturePolicyMap {
  const entries: Array<[Feature, FeaturePolicy]> = FEATURE_IDS.map((id) => [
    id,
    getFeaturePolicy(runtime, id),
  ]);
  return Object.fromEntries(entries) as FeaturePolicyMap;
}

export function resolveFeatureCloudRoute(
  runtime: RuntimeSettings,
  feature: string,
  spec: RouteSpec,
  policyOverride?: FeaturePolicy,
): FeatureCloudRoute {
  const policy = policyOverride ?? getFeaturePolicy(runtime, feature);

  switch (policy) {
    case "local": {
      const localKey = getSettingAsString(runtime, spec.localKeySetting);
      if (localKey === null) {
        return {
          source: "disabled",
          reason: `feature "${feature}" pinned to local but ${spec.localKeySetting} is unset`,
          feature,
          policy,
        };
      }
      return {
        source: "local-key",
        baseUrl: stripTrailingSlashes(spec.upstreamBaseUrl),
        headers: buildLocalKeyHeaders(spec, localKey),
        reason: `feature "${feature}" pinned to local: ${spec.localKeySetting}`,
        feature,
        policy,
      };
    }

    case "cloud": {
      const cloudRoute = buildCloudProxyRoute(runtime, spec.service);
      if (cloudRoute === null) {
        return {
          source: "disabled",
          reason: `feature "${feature}" pinned to cloud but cloud is not connected`,
          feature,
          policy,
        };
      }
      return {
        source: "cloud-proxy",
        ...cloudRoute,
        reason: `feature "${feature}" pinned to cloud: ELIZAOS_CLOUD_API_KEY`,
        feature,
        policy,
      };
    }

    case "auto": {
      const auto = resolveCloudRoute(runtime, spec);
      return {
        ...auto,
        reason: `feature "${feature}" auto: ${auto.reason}`,
        feature,
        policy,
      };
    }
  }
}
