import { type IAgentRuntime, logger } from "@elizaos/core";
import {
  getApiKey,
  getAuthHeader,
  getBaseURL,
  isBrowser,
} from "./utils/config";

/**
 * Initialize and validate ElizaOS Cloud configuration
 */
export function initializeOpenAI(
  _config: Record<string, unknown>,
  runtime: IAgentRuntime,
): void {
  // Do check in the background
  void (async () => {
    try {
      if (!getApiKey(runtime) && !isBrowser()) {
        logger.warn(
          "ELIZAOS_CLOUD_API_KEY is not set in environment - ElizaOS Cloud functionality will be limited",
        );
        logger.info(
          "Get your API key from https://www.elizacloud.ai/dashboard/api-keys",
        );
        return;
      }
      try {
        const baseURL = getBaseURL(runtime);
        const response = await fetch(`${baseURL}/models`, {
          headers: { ...getAuthHeader(runtime) },
        });
        if (!response.ok) {
          logger.warn(
            `ElizaOS Cloud API key validation failed: ${response.statusText}`,
          );
          logger.warn(
            "ElizaOS Cloud functionality will be limited until a valid API key is provided",
          );
          logger.info(
            "Get your API key from https://www.elizacloud.ai/dashboard/api-keys",
          );
        } else {
          logger.log("ElizaOS Cloud API key validated successfully");
        }
      } catch (fetchError: unknown) {
        const message =
          fetchError instanceof Error ? fetchError.message : String(fetchError);
        logger.warn(`Error validating ElizaOS Cloud API key: ${message}`);
        logger.warn(
          "ElizaOS Cloud functionality will be limited until a valid API key is provided",
        );
      }
    } catch (error: unknown) {
      const message =
        (error as { errors?: Array<{ message: string }> })?.errors
          ?.map((e) => e.message)
          .join(", ") ||
        (error instanceof Error ? error.message : String(error));
      logger.warn(
        `ElizaOS Cloud plugin configuration issue: ${message} - You need to configure the ELIZAOS_CLOUD_API_KEY in your environment variables`,
      );
      logger.info(
        "Get your API key from https://www.elizacloud.ai/dashboard/api-keys",
      );
    }
  })();
}
