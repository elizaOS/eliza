import { logger, type IAgentRuntime } from "@elizaos/core";
import { getApiKey, getBaseURL, isBrowser } from "./utils/config";

export function initializeNvidiaCloud(
  _config: unknown,
  runtime: IAgentRuntime,
) {
  void new Promise<void>((resolve) => {
    resolve();
    try {
      const apiKey = getApiKey(runtime);
      if (!apiKey && !isBrowser()) {
        logger.warn(
          "NVIDIA_API_KEY is not set — NVIDIA NIM cloud models will not work until configured.",
        );
        return;
      }
      if (apiKey) {
        logger.log(
          `NVIDIA NIM cloud configured (base: ${getBaseURL(runtime)})`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`NVIDIA cloud plugin init: ${message}`);
    }
  });
}
