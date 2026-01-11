/**
 * Object generation model handlers for Ollama.
 */

import type { IAgentRuntime, ObjectGenerationParams } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { generateObject } from "ai";
import { createOllama } from "ollama-ai-provider";

import { getBaseURL, getLargeModel, getSmallModel } from "../utils/config";
import { ensureModelAvailable } from "./availability";

/**
 * Generate an object using the specified Ollama model.
 *
 * @param ollama - The Ollama provider instance
 * @param model - Model name to use
 * @param params - Generation parameters
 * @returns The generated object
 */
async function generateOllamaObject(
  ollama: ReturnType<typeof createOllama>,
  model: string,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  try {
    const generateParams = {
      model: ollama(model),
      output: "no-schema" as const,
      prompt: params.prompt,
      temperature: params.temperature,
    };

    const { object } = await generateObject(generateParams);
    return object as Record<string, unknown>;
  } catch (error: unknown) {
    logger.error({ error }, "Error generating object");
    return {};
  }
}

/**
 * Handle OBJECT_SMALL model generation.
 *
 * @param runtime - The agent runtime
 * @param params - Generation parameters
 * @returns The generated object
 */
export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  try {
    const baseURL = getBaseURL(runtime);
    const customFetch = runtime.fetch ?? undefined;
    const ollama = createOllama({
      fetch: customFetch,
      baseURL,
    });
    const model = getSmallModel(runtime);

    logger.log(`[Ollama] Using OBJECT_SMALL model: ${model}`);
    await ensureModelAvailable(model, baseURL, customFetch);

    if (params.schema) {
      logger.info("Using OBJECT_SMALL without schema validation");
    }

    return await generateOllamaObject(ollama, model, params);
  } catch (error) {
    logger.error({ error }, "Error in OBJECT_SMALL model");
    return {};
  }
}

/**
 * Handle OBJECT_LARGE model generation.
 *
 * @param runtime - The agent runtime
 * @param params - Generation parameters
 * @returns The generated object
 */
export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  try {
    const baseURL = getBaseURL(runtime);
    const customFetch = runtime.fetch ?? undefined;
    const ollama = createOllama({
      fetch: customFetch,
      baseURL,
    });
    const model = getLargeModel(runtime);

    logger.log(`[Ollama] Using OBJECT_LARGE model: ${model}`);
    await ensureModelAvailable(model, baseURL, customFetch);

    if (params.schema) {
      logger.info("Using OBJECT_LARGE without schema validation");
    }

    return await generateOllamaObject(ollama, model, params);
  } catch (error) {
    logger.error({ error }, "Error in OBJECT_LARGE model");
    return {};
  }
}
