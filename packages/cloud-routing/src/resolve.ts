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

/**
 * Read the per-feature routing policy from runtime settings.
 *
 * Resolution rules (no string-switch on `feature` — the registry owns
 * the lookup):
 *
 * 1. If `feature` is unknown, return `DEFAULT_FEATURE_POLICY` ("auto").
 * 2. If the persisted value isn't a valid `FeaturePolicy`, return
 *    `DEFAULT_FEATURE_POLICY`.
 * 3. Otherwise return the persisted policy.
 *
 * The setting key for each feature is owned by the registry
 * (`features.ts`).
 */
export function getFeaturePolicy(
  runtime: RuntimeSettings,
  feature: string,
): FeaturePolicy {
  const def = getFeature(feature);
  if (def === null) return DEFAULT_FEATURE_POLICY;
  const raw = runtime.getSetting(def.settingKey);
  if (typeof raw === "string") {
    const trimmed = raw.trim().toLowerCase();
    if (isFeaturePolicy(trimmed)) return trimmed;
  }
  return DEFAULT_FEATURE_POLICY;
}

/**
 * Read every registered feature's policy from runtime settings in one
 * call. Always returns a complete `FeaturePolicyMap` with every
 * feature populated (defaults applied where unset).
 */
export function getFeaturePolicyMap(
  runtime: RuntimeSettings,
): FeaturePolicyMap {
  const entries: Array<[Feature, FeaturePolicy]> = FEATURE_IDS.map((id) => [
    id,
    getFeaturePolicy(runtime, id),
  ]);
  return Object.fromEntries(entries) as FeaturePolicyMap;
}

/**
 * Resolve a cloud route for a specific feature, honoring its
 * per-feature policy.
 *
 * Policy semantics:
 *
 *   - `local`  — only `local-key` is acceptable. If no local key is set
 *                the route is `disabled` (the cloud is **not** consulted
 *                even if connected). This is the "stay off cloud for
 *                this feature" mode users explicitly opt into.
 *   - `cloud`  — only `cloud-proxy` is acceptable. Local keys are
 *                ignored; if the cloud isn't connected the route is
 *                `disabled`. This pins the feature to the cloud even
 *                when a local key exists.
 *   - `auto`   — defer to the canonical `resolveCloudRoute` precedence
 *                (local-key wins, cloud-proxy fills in, disabled
 *                otherwise).
 *
 * Unknown feature ids fall back to `auto` (same as
 * `resolveCloudRoute`), so plugins migrating to per-feature routing
 * don't break when a feature id isn't yet in the registry.
 *
 * `policyOverride` skips the runtime setting lookup and is intended
 * for tests + admin tooling that knows the policy without reading the
 * settings store.
 */
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
