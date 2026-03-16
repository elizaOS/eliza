import { type IAgentRuntime, logger } from "@elizaos/core";
import { GoogleGenAI } from "@google/genai";
import { getApiKey } from "./utils/config";

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

export function initializeGoogleGenAI(_config: PluginConfig, runtime: IAgentRuntime): void {
  (async () => {
    try {
      const apiKey = getApiKey(runtime);
      if (!apiKey) {
        logger.warn("GOOGLE_GENERATIVE_AI_API_KEY is not set");
        return;
      }

      const genAI = new GoogleGenAI({ apiKey });
      const modelList = await genAI.models.list();
      const models = [];
      for await (const model of modelList) {
        models.push(model);
      }
      logger.log(`Google AI API key validated. Available models: ${models.length}`);
    } catch (error) {
      logger.warn(
        `Google AI configuration error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  })();
}
