import { CloudApiClient, ElizaCloudClient } from "@elizaos/cloud-sdk";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import {
  type CloudSdkAuthorityTuple,
  getAppId,
  resolveCloudSdkAuthorityTuple,
} from "./config";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function apiBaseToSiteBaseUrl(apiBaseUrl: string): string {
  const trimmed = trimTrailingSlash(apiBaseUrl);
  return trimmed.endsWith("/api/v1") ? trimmed.slice(0, -"/api/v1".length) : trimmed;
}

function assertOutboundAllowed(tuple: CloudSdkAuthorityTuple): void {
  if (tuple.outboundAllowed) return;
  throw new ElizaError(
    "Eliza Cloud SDK requests are disabled by the local development Cloud target",
    {
      code: "ELIZA_CLOUD_DEV_AUTHORITY_OUTBOUND_BLOCKED",
      context: { authority: tuple.authority },
      severity: "fatal",
    },
  );
}

/**
 * Per-app attribution header (#10423). When the agent runs as a deployed Eliza
 * Cloud app (`ELIZA_APP_ID` injected by the deploy path), every request carries
 * `X-App-Id` so inference bills the app's credits + creator earnings. Absent it,
 * no header is sent and billing stays with the caller's own org.
 */
function appAttributionHeaders(
  runtime: IAgentRuntime,
): Record<string, string> | undefined {
  const appId = getAppId(runtime);
  return appId ? { "X-App-Id": appId } : undefined;
}

export function createCloudApiClient(runtime: IAgentRuntime, embedding = false): CloudApiClient {
  const tuple = resolveCloudSdkAuthorityTuple(runtime, embedding);
  assertOutboundAllowed(tuple);
  return new ElizaCloudClient({
    apiBaseUrl: trimTrailingSlash(tuple.apiBaseUrl),
    baseUrl: apiBaseToSiteBaseUrl(tuple.apiBaseUrl),
    apiKey: tuple.apiKey,
    defaultHeaders: appAttributionHeaders(runtime),
  }).v1;
}

export function createElizaCloudClient(runtime: IAgentRuntime): ElizaCloudClient {
  const tuple = resolveCloudSdkAuthorityTuple(runtime);
  assertOutboundAllowed(tuple);
  const apiBaseUrl = trimTrailingSlash(tuple.apiBaseUrl);
  return new ElizaCloudClient({
    apiBaseUrl,
    baseUrl: apiBaseToSiteBaseUrl(apiBaseUrl),
    apiKey: tuple.apiKey,
    defaultHeaders: appAttributionHeaders(runtime),
  });
}
