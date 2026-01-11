import { type IAgentRuntime, logger } from "@elizaos/core";
import { GoogleGenAI } from "@google/genai";
import { getApiKey } from "./utils/config";

/**
 * Plugin configuration object structure
 */
export interface PluginConfig {
  readonly GOOGLE_GENERATIVE_AI_API_KEY?: string;
  readonly GOOGLE_SMALL_MODEL?: string;
  readonly GOOGLE_LARGE_MODEL?: string;
  readonly GOOGLE_IMAGE_MODEL?: string;
  readonly GOOGLE_EMBEDDING_MODEL?: string;
  readonly SMALL_MODEL?: string;
  readonly LARGE_MODEL?: string;
  readonly IMAGE_MODEL?: string;
}

/**
 * Initialize and validate Google Generative AI configuration
 */
export function initializeGoogleGenAI(_config: PluginConfig, runtime: IAgentRuntime): void {
  // Run validation in the background without blocking initialization
  void (async () => {
    try {
      const apiKey = getApiKey(runtime);
      if (!apiKey) {
        logger.warn(
          "GOOGLE_GENERATIVE_AI_API_KEY is not set in environment - Google AI functionality will be limited"
        );
        return;
      }

      // Test the API key by listing models
      try {
        const genAI = new GoogleGenAI({ apiKey });
        const modelList = await genAI.models.list();
        const models = [];
        for await (const model of modelList) {
          models.push(model);
        }
        logger.log(`Google AI API key validated successfully. Available models: ${models.length}`);
      } catch (fetchError: unknown) {
        const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
        logger.warn(`Error validating Google AI API key: ${message}`);
        logger.warn("Google AI functionality will be limited until a valid API key is provided");
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Google AI plugin configuration issue: ${message} - You need to configure the GOOGLE_GENERATIVE_AI_API_KEY in your environment variables`
      );
    }
  })();
}
