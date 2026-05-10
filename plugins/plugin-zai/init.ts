import { type IAgentRuntime, logger } from "@elizaos/core";
import { getApiKeyOptional, isBrowser } from "./utils/config";

export interface PluginConfig {
  readonly ZAI_API_KEY?: string;
  readonly Z_AI_API_KEY?: string;
  readonly ZAI_SMALL_MODEL?: string;
  readonly ZAI_LARGE_MODEL?: string;
  readonly ZAI_EXPERIMENTAL_TELEMETRY?: string;
  readonly ZAI_BASE_URL?: string;
  readonly ZAI_BROWSER_BASE_URL?: string;
  readonly ZAI_COT_BUDGET?: string;
  readonly ZAI_COT_BUDGET_SMALL?: string;
  readonly ZAI_COT_BUDGET_LARGE?: string;
}

function disableAiSdkWarningsForZai(): void {
  const mutableGlobalThis = globalThis as typeof globalThis & {
    AI_SDK_LOG_WARNINGS?: boolean;
  };
  if (mutableGlobalThis.AI_SDK_LOG_WARNINGS === undefined) {
    mutableGlobalThis.AI_SDK_LOG_WARNINGS = false;
  }
}

export function initializeZai(_config: PluginConfig, runtime: IAgentRuntime): void {
  void (async () => {
    disableAiSdkWarningsForZai();
    const apiKey = getApiKeyOptional(runtime);

    if (!apiKey && !isBrowser()) {
      logger.warn(
        "ZAI_API_KEY is not set in environment - z.ai functionality will be limited. " +
          "Set ZAI_API_KEY in your environment variables or runtime settings. Legacy Z_AI_API_KEY is also accepted."
      );
      return;
    }

    if (apiKey) {
      logger.log("z.ai API key configured successfully");
    }
  })();
}
