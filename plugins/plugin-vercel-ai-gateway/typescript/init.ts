import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getApiKeyOptional } from "./utils/config";

export interface GatewayPluginConfig {
  AI_GATEWAY_API_KEY?: string;
  AIGATEWAY_API_KEY?: string;
  VERCEL_OIDC_TOKEN?: string;
  AI_GATEWAY_BASE_URL?: string;
  AI_GATEWAY_SMALL_MODEL?: string;
  AI_GATEWAY_LARGE_MODEL?: string;
  AI_GATEWAY_EMBEDDING_MODEL?: string;
  AI_GATEWAY_EMBEDDING_DIMENSIONS?: string;
  AI_GATEWAY_IMAGE_MODEL?: string;
  AI_GATEWAY_TIMEOUT_MS?: string;
}

export function initializeGateway(
  _config: GatewayPluginConfig | undefined,
  runtime: IAgentRuntime
): void {
  const apiKey = getApiKeyOptional(runtime);

  if (apiKey) {
    logger.info("[Gateway] Vercel AI Gateway plugin initialized");
  } else {
    logger.warn(
      "[Gateway] No API key found. Set AI_GATEWAY_API_KEY, AIGATEWAY_API_KEY, or VERCEL_OIDC_TOKEN."
    );
  }
}
