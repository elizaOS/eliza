import type http from "node:http";
import { sendJson, sendJsonError } from "@elizaos/shared";
import { normalizeCloudSiteUrl } from "@elizaos/plugin-elizacloud/cloud/base-url";
import { resolveCloudApiKey } from "@elizaos/plugin-elizacloud/cloud/cloud-api-key";
import { validateCloudBaseUrl } from "@elizaos/plugin-elizacloud/cloud/validate-url";
import type { CloudProxyConfigLike } from "@elizaos/agent/types/config-like";
import {
  type AgentRuntime,
  type IAgentRuntime,
  logger,
  type Service,
} from "@elizaos/core";
import { createFeatureFlagService } from "../lifeops/feature-flags.js";
import {
  ALL_FEATURE_KEYS,
  CLOUD_LINKED_DEFAULT_ON,
  type FeatureFlagState,
  isCloudLinkedDefaultOnFeatureKey,
  isLifeOpsFeatureKey,
  type LifeOpsFeatureFlagRowDto,
  type LifeOpsFeatureFlagsResponse,
  type LifeOpsFeatureFlagsSyncResponse,
  type LifeOpsFeatureKey,
} from "../lifeops/feature-flags.types.js";

export interface CloudFeaturesRouteState {
  config: CloudProxyConfigLike;
  runtime?: AgentRuntime | null;
}

const PROXY_TIMEOUT_MS = 15_000;

interface CloudAuthApiKeyService {
  isAuthenticated: () => boolean;
  getApiKey?: () => string | undefined;
}

interface CloudFeatureRow {
  readonly featureKey: LifeOpsFeatureKey;
  readonly enabled: boolean;
  readonly packageId: string | null;
}

interface CloudFeaturesUpstream {
  readonly features?: ReadonlyArray<{
    readonly featureKey?: unknown;
    readonly enabled?: unknown;
    readonly packageId?: unknown;
  }>;
}

function normalizeCloudApiKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "[REDACTED]") return null;
  return trimmed;
}

function resolveProxyApiKey(state: CloudFeaturesRouteState): string | null {
  const cloudAuth = state.runtime
    ? state.runtime.getService<Service & CloudAuthApiKeyService>("CLOUD_AUTH")
    : null;
  const runtimeApiKey =
    cloudAuth?.isAuthenticated() === true
      ? normalizeCloudApiKey(cloudAuth.getApiKey?.())
      : null;
  return runtimeApiKey ?? resolveCloudApiKey(state.config, state.runtime);
}

function buildAuthHeaders(
  config: CloudProxyConfigLike,
  apiKey: string,
): Record<string, string> {
  const serviceKey = config.cloud?.serviceKey?.trim();
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (serviceKey) headers["X-Service-Key"] = serviceKey;
  return headers;
}

function parseCloudFeatures(payload: unknown): CloudFeatureRow[] {
  if (!payload || typeof payload !== "object") return [];
  const features = (payload as CloudFeaturesUpstream).features;
  if (!Array.isArray(features)) return [];
  const rows: CloudFeatureRow[] = [];
  for (const entry of features) {
    if (!entry || typeof entry !== "object") continue;
    const featureKeyRaw = entry.featureKey;
    if (!isLifeOpsFeatureKey(featureKeyRaw)) continue;
    const enabled = entry.enabled === true;
    const packageId =
      typeof entry.packageId === "string" && entry.packageId.trim().length > 0
        ? entry.packageId.trim()
        : null;
    rows.push({ featureKey: featureKeyRaw, enabled, packageId });
  }
  return rows;
}

interface FetchCloudFeaturesResult {
  readonly status: number;
  readonly rows: ReadonlyArray<CloudFeatureRow>;
  readonly error: string | null;
}

async function fetchCloudFeatures(
  state: CloudFeaturesRouteState,
): Promise<FetchCloudFeaturesResult> {
  const apiKey = resolveProxyApiKey(state);
  if (!apiKey) {
    return {
      status: 401,
      rows: [],
      error: "Not connected to Eliza Cloud. Sign in to sync features.",
    };
  }
  const baseUrl = normalizeCloudSiteUrl(state.config.cloud?.baseUrl);
  const urlError = await validateCloudBaseUrl(baseUrl);
  if (urlError) {
    return { status: 502, rows: [], error: urlError };
  }
  const upstream = await fetch(`${baseUrl}/api/v1/features`, {
    method: "GET",
    headers: buildAuthHeaders(state.config, apiKey),
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  });
  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    return {
      status: upstream.status,
      rows: [],
      error: body || `Cloud features request failed (${upstream.status})`,
    };
  }
  const payload = await upstream.json().catch(() => null);
  return { status: 200, rows: parseCloudFeatures(payload), error: null };
}

function toRowDto(state: FeatureFlagState): LifeOpsFeatureFlagRowDto {
  const packageId = state.metadata.packageId;
  return {
    featureKey: state.featureKey,
    enabled: state.enabled,
    source: state.source,
    label: state.label,
    description: state.description,
    costsMoney: state.costsMoney,
    enabledAt: state.enabledAt ? state.enabledAt.toISOString() : null,
    enabledBy: state.enabledBy,
    packageId: typeof packageId === "string" ? packageId : null,
    cloudDefaultOn: isCloudLinkedDefaultOnFeatureKey(state.featureKey),
  };
}

async function handleGet(
  res: http.ServerResponse,
  state: CloudFeaturesRouteState,
): Promise<void> {
  if (!state.runtime) {
    sendJsonError(res, "Runtime not available", 503);
    return;
  }
  const service = createFeatureFlagService(state.runtime as IAgentRuntime);
  const list = await service.list();
  const response: LifeOpsFeatureFlagsResponse = {
    features: list.map(toRowDto),
  };
  sendJson(res, response, 200);
}

async function handleSync(
  res: http.ServerResponse,
  state: CloudFeaturesRouteState,
): Promise<void> {
  if (!state.runtime) {
    sendJsonError(res, "Runtime not available", 503);
    return;
  }
  const remote = await fetchCloudFeatures(state);
  if (remote.error) {
    sendJsonError(res, remote.error, remote.status);
    return;
  }
  const service = createFeatureFlagService(state.runtime as IAgentRuntime);
  const remoteByKey = new Map<LifeOpsFeatureKey, CloudFeatureRow>();
  for (const row of remote.rows) {
    remoteByKey.set(row.featureKey, row);
  }
  const promotedKeys = new Set<LifeOpsFeatureKey>();
  for (const featureKey of CLOUD_LINKED_DEFAULT_ON) {
    if (remoteByKey.has(featureKey)) continue;
    promotedKeys.add(featureKey);
    await service.enable(featureKey, "cloud", null, {
      autoProvisioned: true,
      cloudDefault: true,
    });
  }
  for (const featureKey of ALL_FEATURE_KEYS) {
    const cloudRow = remoteByKey.get(featureKey);
    if (!cloudRow) continue;
    const metadata = cloudRow.packageId
      ? { packageId: cloudRow.packageId, autoProvisioned: true }
      : { autoProvisioned: true };
    if (cloudRow.enabled) {
      await service.enable(featureKey, "cloud", null, metadata);
    } else {
      await service.disable(featureKey, "cloud", null);
    }
  }
  logger.info(
    `[cloud-features] synced ${remote.rows.length} feature(s) from Eliza Cloud (${promotedKeys.size} promoted by Cloud-default policy)`,
  );
  const list = await service.list();
  const response: LifeOpsFeatureFlagsSyncResponse = {
    synced: remote.rows.length,
    features: list.map(toRowDto),
  };
  sendJson(res, response, 200);
}

export async function handleCloudFeaturesRoute(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: CloudFeaturesRouteState,
): Promise<boolean> {
  if (pathname === "/api/cloud/features" && method === "GET") {
    await handleGet(res, state);
    return true;
  }
  if (pathname === "/api/cloud/features/sync" && method === "POST") {
    await handleSync(res, state);
    return true;
  }
  return false;
}
