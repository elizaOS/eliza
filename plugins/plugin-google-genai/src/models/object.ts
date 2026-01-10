import type { IAgentRuntime, ObjectGenerationParams, ModelTypeName } from '@elizaos/core';
import { logger } from '@elizaos/core';
import {
  createGoogleGenAI,
  getSafetySettings,
  getSmallModel,
  getLargeModel,
} from '../utils/config';
import { emitModelUsageEvent } from '../utils/events';
import { countTokens } from '../utils/tokenization';

/**
 * Helper function to generate objects using specified model type
 */
async function generateObjectByModelType(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
  modelType: string,
  getModelFn: (runtime: IAgentRuntime) => string
): Promise<any> {
  const genAI = createGoogleGenAI(runtime);
  if (!genAI) {
    throw new Error('Google Generative AI client not initialized');
  }

  const modelName = getModelFn(runtime);
  const temperature = params.temperature ?? 0.1;

  logger.info(`Using ${modelType} model: ${modelName}`);

  try {
    // Add schema instructions to prompt if provided
    let enhancedPrompt = params.prompt;
    if (params.schema) {
      enhancedPrompt += `\n\nPlease respond with a JSON object that follows this schema:\n${JSON.stringify(params.schema, null, 2)}`;
    }

    const response = await genAI.models.generateContent({
      model: modelName,
      contents: enhancedPrompt,
      config: {
        temperature,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        safetySettings: getSafetySettings(),
      },
    });

    const text = response.text || '';

    // Count tokens for usage tracking
    const promptTokens = await countTokens(enhancedPrompt);
    const completionTokens = await countTokens(text);

    emitModelUsageEvent(runtime, modelType as ModelTypeName, params.prompt, {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    });

    try {
      const parsedResult = JSON.parse(text);
      return parsedResult;
    } catch (parseError) {
      logger.error(
        `Failed to parse JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}`
      );
      // Try to extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const extractedResult = JSON.parse(jsonMatch[0]);
          return extractedResult;
        } catch (secondParseError) {
          throw new Error('Failed to parse JSON from response');
        }
      }
      throw parseError;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[generateObject] Error: ${message}`);
    throw error;
  }
}

export async function handleObjectSmall(runtime: IAgentRuntime, params: ObjectGenerationParams) {
  return generateObjectByModelType(runtime, params, 'OBJECT_SMALL', getSmallModel);
}

export async function handleObjectLarge(runtime: IAgentRuntime, params: ObjectGenerationParams) {
  return generateObjectByModelType(runtime, params, 'OBJECT_LARGE', getLargeModel);
}
