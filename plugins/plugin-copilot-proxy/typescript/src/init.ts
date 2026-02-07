import { type IAgentRuntime, logger } from "@elizaos/core";
import { getBaseUrlOptional, isBrowser, isPluginEnabled } from "./environment";

export interface PluginConfig {
  readonly COPILOT_PROXY_BASE_URL?: string;
  readonly COPILOT_PROXY_MODEL?: string;
  readonly COPILOT_PROXY_ENABLED?: string;
  readonly COPILOT_PROXY_SMALL_MODEL?: string;
  readonly COPILOT_PROXY_LARGE_MODEL?: string;
  readonly COPILOT_PROXY_TIMEOUT_SECONDS?: string;
  readonly COPILOT_PROXY_MAX_TOKENS?: string;
  readonly COPILOT_PROXY_CONTEXT_WINDOW?: string;
}

const _globalThis = globalThis as typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: boolean;
};
if (_globalThis.AI_SDK_LOG_WARNINGS === undefined) {
  _globalThis.AI_SDK_LOG_WARNINGS = false;
}

export function initializeCopilotProxy(
  _config: PluginConfig,
  runtime: IAgentRuntime,
): void {
  void (async () => {
    if (!isPluginEnabled(runtime)) {
      logger.info(
        "[CopilotProxy] Plugin is disabled via COPILOT_PROXY_ENABLED=false",
      );
      return;
    }

    const baseUrl = getBaseUrlOptional(runtime);

    if (!baseUrl && !isBrowser()) {
      logger.info(
        "[CopilotProxy] Using default base URL: http://localhost:3000/v1. " +
          "Set COPILOT_PROXY_BASE_URL to customize.",
      );
    }

    if (baseUrl) {
      logger.log(`[CopilotProxy] Configured with base URL: ${baseUrl}`);
    }

    logger.info(
      "[CopilotProxy] Plugin initialized. Make sure the Copilot Proxy VS Code extension is running.",
    );
  })();
}
