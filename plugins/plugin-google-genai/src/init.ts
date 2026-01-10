import { GoogleGenAI } from '@google/genai';
import { logger, type IAgentRuntime } from '@elizaos/core';
import { getApiKey } from './utils/config';

/**
 * Initialize and validate Google Generative AI configuration
 */
export function initializeGoogleGenAI(_config: any, runtime: IAgentRuntime) {
  // Run validation in the background without blocking initialization
  void (async () => {
    try {
      const apiKey = getApiKey(runtime);
      if (!apiKey) {
        logger.warn(
          'GOOGLE_GENERATIVE_AI_API_KEY is not set in environment - Google AI functionality will be limited'
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
        logger.warn('Google AI functionality will be limited until a valid API key is provided');
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Google AI plugin configuration issue: ${message} - You need to configure the GOOGLE_GENERATIVE_AI_API_KEY in your environment variables`
      );
    }
  })();
}
