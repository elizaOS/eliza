/**
 * Plugin `init` hook: warns (on Node) when no NEAR AI API key is resolvable, so
 * text generation degrades to a limited state rather than failing silently.
 * Browser builds skip the warning since the key is expected to live behind a
 * proxy. Also defines `PluginConfig`, the typed shape of the `NEARAI_*` env
 * passthrough declared in `index.ts`.
 */
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

export function initializeNearAI(_config: PluginConfig, runtime: IAgentRuntime): void {
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
