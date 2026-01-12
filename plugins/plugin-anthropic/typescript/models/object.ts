import type { IAgentRuntime, ModelTypeName, ObjectGenerationParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText } from "ai";
import { createAnthropicClient } from "../providers";
import type { ExtractedJSON, JsonSchema, ModelName, ModelSize } from "../types";
import { isReflectionSchema } from "../types";
import { getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { ensureReflectionProperties, extractAndParseJSON } from "../utils/json";

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

function buildJsonPrompt(prompt: string): string {
  if (prompt.includes("```json") || prompt.includes("respond with valid JSON")) {
    return prompt;
  }

  return (
    prompt +
    "\nPlease respond with valid JSON only, without any explanations, markdown formatting, or additional text."
  );
}

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
  const temperature = params.temperature ?? 0.2;

  const { text, usage } = await generateText({
    model: anthropic(modelName),
    prompt: jsonPrompt,
    system: systemPrompt,
    temperature,
  });

  if (usage) {
    emitModelUsageEvent(runtime, modelType, params.prompt, usage);
  }

  logger.debug("Attempting to parse response from Anthropic model");
  const jsonObject: ExtractedJSON = extractAndParseJSON(text);

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

  const processedObject = ensureReflectionProperties(jsonObject, isReflection);

  return processedObject as Record<string, unknown>;
}

export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  const modelName = getSmallModel(runtime);
  return generateObjectByModelType(runtime, params, ModelType.OBJECT_SMALL, modelName, "small");
}

export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  const modelName = getLargeModel(runtime);
  return generateObjectByModelType(runtime, params, ModelType.OBJECT_LARGE, modelName, "large");
}
