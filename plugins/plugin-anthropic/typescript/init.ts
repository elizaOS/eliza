import { type IAgentRuntime, logger } from "@elizaos/core";
import { getApiKeyOptional, isBrowser } from "./utils/config";

export interface PluginConfig {
  readonly ANTHROPIC_API_KEY?: string;
  readonly ANTHROPIC_SMALL_MODEL?: string;
  readonly ANTHROPIC_LARGE_MODEL?: string;
  readonly ANTHROPIC_EXPERIMENTAL_TELEMETRY?: string;
  readonly ANTHROPIC_BASE_URL?: string;
  readonly ANTHROPIC_BROWSER_BASE_URL?: string;
  readonly ANTHROPIC_COT_BUDGET?: string;
  readonly ANTHROPIC_COT_BUDGET_SMALL?: string;
  readonly ANTHROPIC_COT_BUDGET_LARGE?: string;
}

const _globalThis = globalThis as typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: boolean;
};
if (_globalThis.AI_SDK_LOG_WARNINGS === undefined) {
  _globalThis.AI_SDK_LOG_WARNINGS = false;
}

export function initializeAnthropic(_config: PluginConfig, runtime: IAgentRuntime): void {
  void (async () => {
    const apiKey = getApiKeyOptional(runtime);

    if (!apiKey && !isBrowser()) {
      logger.warn(
        "ANTHROPIC_API_KEY is not set in environment - Anthropic functionality will be limited. " +
          "Set ANTHROPIC_API_KEY in your environment variables or runtime settings."
      );
      return;
    }

    if (apiKey) {
      logger.log("Anthropic API key configured successfully");
    }
  })();
}
