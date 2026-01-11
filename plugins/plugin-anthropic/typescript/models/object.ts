/**
 * Object/JSON generation model handlers.
 *
 * These handlers implement structured JSON output using Anthropic's Claude models.
 * The approach prompts for JSON output and then parses/repairs the response.
 */

import type { IAgentRuntime, ModelTypeName, ObjectGenerationParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText } from "ai";
import { createAnthropicClient } from "../providers";
import type { ExtractedJSON, JsonSchema, ModelName, ModelSize } from "../types";
import { isReflectionSchema } from "../types";
import { getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { ensureReflectionProperties, extractAndParseJSON } from "../utils/json";

/**
 * Build a system prompt for JSON generation.
 */
function buildSystemPrompt(characterSystem: string | undefined, isReflection: boolean): string {
  let systemPrompt = characterSystem
    ? `${characterSystem}\nYou must respond with valid JSON only.`
    : "You must respond with valid JSON only.";

  if (isReflection) {
    systemPrompt +=
      " Ensure your response includes 'thought', 'facts', and 'relationships' properties exactly as specified in the prompt.";
  } else {
    systemPrompt += " No markdown, no code blocks, no explanation text.";
  }

  return systemPrompt;
}

/**
 * Build a JSON-focused prompt from the original prompt.
 */
function buildJsonPrompt(prompt: string): string {
  // Don't modify if already contains explicit JSON formatting
  if (prompt.includes("```json") || prompt.includes("respond with valid JSON")) {
    return prompt;
  }

  return (
    prompt +
    "\nPlease respond with valid JSON only, without any explanations, markdown formatting, or additional text."
  );
}

/**
 * Generate a JSON object using the specified model.
 *
 * @throws Error if JSON parsing fails after all extraction attempts
 */
async function generateObjectByModelType(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
  modelType: ModelTypeName,
  modelName: ModelName,
  _modelSize: ModelSize
): Promise<Record<string, unknown>> {
  const anthropic = createAnthropicClient(runtime);

  logger.log(`[Anthropic] Using ${modelType} model: ${modelName}`);

  const schema = params.schema as JsonSchema | undefined;
  const isReflection = isReflectionSchema(schema);
  const jsonPrompt = buildJsonPrompt(params.prompt);
  const systemPrompt = buildSystemPrompt(runtime.character.system, isReflection);
  const temperature = params.temperature ?? 0.2; // Lower for structured output

  const { text, usage } = await generateText({
    model: anthropic(modelName),
    prompt: jsonPrompt,
    system: systemPrompt,
    temperature,
  });

  if (usage) {
    emitModelUsageEvent(runtime, modelType, params.prompt, usage);
  }

  // Parse the response
  logger.debug("Attempting to parse response from Anthropic model");
  const jsonObject: ExtractedJSON = extractAndParseJSON(text);

  // Check for unstructured response (parsing failed)
  if (
    typeof jsonObject === "object" &&
    jsonObject !== null &&
    "type" in jsonObject &&
    jsonObject.type === "unstructured_response"
  ) {
    logger.error(`Failed to parse JSON from Anthropic response`);
    logger.error(`Raw response: ${text}`);
    throw new Error("Invalid JSON returned from Anthropic model: could not extract valid JSON");
  }

  // Ensure reflection properties if needed
  const processedObject = ensureReflectionProperties(jsonObject, isReflection);

  // Return as Record<string, unknown> for compatibility
  return processedObject as Record<string, unknown>;
}

/**
 * OBJECT_SMALL model handler.
 *
 * Generates structured JSON using the configured small model.
 *
 * @throws Error if JSON cannot be extracted from the model response
 */
export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  const modelName = getSmallModel(runtime);
  return generateObjectByModelType(runtime, params, ModelType.OBJECT_SMALL, modelName, "small");
}

/**
 * OBJECT_LARGE model handler.
 *
 * Generates structured JSON using the configured large model.
 *
 * @throws Error if JSON cannot be extracted from the model response
 */
export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  const modelName = getLargeModel(runtime);
  return generateObjectByModelType(runtime, params, ModelType.OBJECT_LARGE, modelName, "large");
}
