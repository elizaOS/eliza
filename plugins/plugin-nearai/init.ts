import { type IAgentRuntime, logger } from "@elizaos/core";
import { getApiKeyOptional, isBrowser } from "./utils/config";

export interface PluginConfig {
  readonly NEARAI_API_KEY?: string;
  readonly NEARAI_SMALL_MODEL?: string;
  readonly NEARAI_LARGE_MODEL?: string;
  readonly NEARAI_EXPERIMENTAL_TELEMETRY?: string;
  readonly NEARAI_BASE_URL?: string;
  readonly NEARAI_BROWSER_BASE_URL?: string;
}

function disableAiSdkWarningsForNearAI(): void {
  const mutableGlobalThis = globalThis as typeof globalThis & {
    AI_SDK_LOG_WARNINGS?: boolean;
  };
  if (mutableGlobalThis.AI_SDK_LOG_WARNINGS === undefined) {
    mutableGlobalThis.AI_SDK_LOG_WARNINGS = false;
  }
}

export function initializeNearAI(_config: PluginConfig, runtime: IAgentRuntime): void {
  disableAiSdkWarningsForNearAI();
  const apiKey = getApiKeyOptional(runtime);

  if (!apiKey && !isBrowser()) {
    logger.warn(
      "NEARAI_API_KEY is not set in environment - NEAR AI functionality will be limited. " +
        "Set NEARAI_API_KEY in your environment variables or runtime settings."
    );
    return;
  }

  if (apiKey) {
    logger.log("NEAR AI API key configured successfully");
  }
}
