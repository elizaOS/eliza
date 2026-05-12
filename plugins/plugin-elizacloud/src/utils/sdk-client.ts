import { CloudApiClient, ElizaCloudClient } from "@elizaos/cloud-sdk";
import type { IAgentRuntime } from "@elizaos/core";
import {
  getApiKey,
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

export function createCloudApiClient(runtime: IAgentRuntime, embedding = false): CloudApiClient {
  const baseUrl = embedding ? getEmbeddingBaseURL(runtime) : getBaseURL(runtime);
  return new CloudApiClient(trimTrailingSlash(baseUrl), apiKeyForRuntime(runtime, embedding));
}

export function createElizaCloudClient(runtime: IAgentRuntime): ElizaCloudClient {
  const apiBaseUrl = trimTrailingSlash(getBaseURL(runtime));
  return new ElizaCloudClient({
    apiBaseUrl,
    baseUrl: apiBaseToSiteBaseUrl(apiBaseUrl),
    apiKey: apiKeyForRuntime(runtime),
  });
}
