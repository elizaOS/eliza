import { CloudApiClient, ElizaCloudClient } from "@elizaos/cloud-sdk";
import type { IAgentRuntime } from "@elizaos/core";
import {
  getApiKey,
  getAppId,
  getBaseURL,
  getEmbeddingApiKey,
  getEmbeddingBaseURL,
  isBrowser,
} from "./config";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function apiBaseToSiteBaseUrl(apiBaseUrl: string): string {
  const trimmed = trimTrailingSlash(apiBaseUrl);
  return trimmed.endsWith("/api/v1") ? trimmed.slice(0, -"/api/v1".length) : trimmed;
}

function apiKeyForRuntime(runtime: IAgentRuntime, embedding = false): string | undefined {
  if (isBrowser()) return undefined;
  return embedding ? getEmbeddingApiKey(runtime) : getApiKey(runtime);
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
  const baseUrl = embedding ? getEmbeddingBaseURL(runtime) : getBaseURL(runtime);
  return new ElizaCloudClient({
    apiBaseUrl: trimTrailingSlash(baseUrl),
    baseUrl: apiBaseToSiteBaseUrl(baseUrl),
    apiKey: apiKeyForRuntime(runtime, embedding),
    defaultHeaders: appAttributionHeaders(runtime),
  }).v1;
}

export function createElizaCloudClient(runtime: IAgentRuntime): ElizaCloudClient {
  const apiBaseUrl = trimTrailingSlash(getBaseURL(runtime));
  return new ElizaCloudClient({
    apiBaseUrl,
    baseUrl: apiBaseToSiteBaseUrl(apiBaseUrl),
    apiKey: apiKeyForRuntime(runtime),
    defaultHeaders: appAttributionHeaders(runtime),
  });
}
