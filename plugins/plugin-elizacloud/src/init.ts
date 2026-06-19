import { type IAgentRuntime, logger } from "@elizaos/core";
import { getApiKey, isBrowser } from "./utils/config";
import { createCloudApiClient } from "./utils/sdk-client";

export function initializeOpenAI(
  _config: Record<string, string | null>,
  runtime: IAgentRuntime
): void {
  void (async () => {
    try {
      if (!getApiKey(runtime) && !isBrowser()) {
        logger.warn(
          "ELIZAOS_CLOUD_API_KEY is not set in environment - ElizaOS Cloud functionality will be limited"
        );
        logger.info("Get your API key from https://www.elizacloud.ai/dashboard/api-keys");
        return;
      }
      try {
        await createCloudApiClient(runtime).get("/models");
        logger.log("ElizaOS Cloud API key validated successfully");
      } catch (fetchError) {
        const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
        logger.warn(`ElizaOS Cloud API key validation failed: ${message}`);
        logger.warn(
          "ElizaOS Cloud functionality will be limited until a valid API key is provided"
        );
      }
    } catch (error) {
      const message =
        (error as { errors?: Array<{ message: string }> })?.errors
          ?.map((e) => e.message)
          .join(", ") || (error instanceof Error ? error.message : String(error));
      logger.warn(
        `ElizaOS Cloud plugin configuration issue: ${message} - You need to configure the ELIZAOS_CLOUD_API_KEY in your environment variables`
      );
      logger.info("Get your API key from https://www.elizacloud.ai/dashboard/api-keys");
    }
  })();
}
