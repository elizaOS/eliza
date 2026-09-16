import type {
  CloudConfigLike,
  CloudStatusRouteContext,
} from "./cloud-status-routes-autonomous.js";
import type { ElizaConfig } from "../lib/config-like";
import { isElizaCloudServiceSelectedInConfig } from "@elizaos/core";
import {
  fetchCloudCredits,
  resolveCloudConnectionSnapshot,
} from "../lib/cloud-connection";
import { resolveCloudBillingUrl } from "../cloud/base-url.js";

export type { CloudConfigLike, CloudStatusRouteContext };

export async function handleCloudStatusRoutes(
  ctx: CloudStatusRouteContext,
): Promise<boolean> {
  const { res, method, pathname, config, runtime, json } = ctx;
  const typedConfig = config as ElizaConfig;
  const topUpUrl = resolveCloudBillingUrl(typedConfig.cloud?.baseUrl);

  if (method === "GET" && pathname === "/api/cloud/status") {
    const snapshot = resolveCloudConnectionSnapshot(typedConfig, runtime);
    const cloudVoiceProxyAvailable = isElizaCloudServiceSelectedInConfig(
      typedConfig as Record<string, unknown>,
      "tts",
    );

    if (snapshot.connected) {
      json(res, {
        connected: true,
        enabled: snapshot.enabled,
        cloudVoiceProxyAvailable,
        hasApiKey: snapshot.hasApiKey,
        userId: snapshot.userId,
        organizationId: snapshot.organizationId,
        topUpUrl,
        reason: snapshot.authConnected
          ? undefined
          : runtime
            ? "api_key_present_not_authenticated"
            : "api_key_present_runtime_not_started",
      });
      return true;
    }

    if (!runtime) {
      json(res, {
        connected: false,
        enabled: snapshot.enabled,
        cloudVoiceProxyAvailable,
        hasApiKey: snapshot.hasApiKey,
        reason: "runtime_not_started",
      });
      return true;
    }

    json(res, {
      connected: false,
      enabled: snapshot.enabled,
      cloudVoiceProxyAvailable,
      hasApiKey: snapshot.hasApiKey,
      reason: "not_authenticated",
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/cloud/credits") {
    json(res, await fetchCloudCredits(typedConfig, runtime));
    return true;
  }

  return false;
}
