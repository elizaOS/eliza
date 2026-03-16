import type {
  IAgentRuntime,
  ModelTypeName,
  ObjectGenerationParams,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText } from "ai";
import { getLargeModel, getSmallModel } from "../environment";
import { createCopilotProxyProvider } from "../providers";
import type { ExtractedJSON, JsonSchema, ModelName, ModelSize } from "../types";
import { emitModelUsageEvent } from "../utils/events";
import { extractAndParseJSON } from "../utils/json";

function buildSystemPrompt(characterSystem: string | undefined): string {
  let systemPrompt = characterSystem
    ? `${characterSystem}\nYou must respond with valid JSON only.`
    : "You must respond with valid JSON only.";

  systemPrompt += " No markdown, no code blocks, no explanation text.";

  return systemPrompt;
}

function buildJsonPrompt(prompt: string): string {
  if (
    prompt.includes("```json") ||
    prompt.includes("respond with valid JSON")
  ) {
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
  _modelSize: ModelSize,
): Promise<Record<string, unknown>> {
  const copilotProxy = createCopilotProxyProvider(runtime);

  logger.log(`[CopilotProxy] Using ${modelType} model: ${modelName}`);

  const jsonPrompt = buildJsonPrompt(params.prompt);
  const systemPrompt = buildSystemPrompt(runtime.character.system);
  const temperature = params.temperature ?? 0.2;

  const { text, usage } = await generateText({
    model: copilotProxy(modelName),
    prompt: jsonPrompt,
    system: systemPrompt,
    temperature,
  });

  if (usage) {
    emitModelUsageEvent(runtime, modelType, params.prompt, usage);
  }

  logger.debug("Attempting to parse response from Copilot Proxy model");
  const jsonObject: ExtractedJSON = extractAndParseJSON(text);

  if (
    typeof jsonObject === "object" &&
    jsonObject !== null &&
    "type" in jsonObject &&
    jsonObject.type === "unstructured_response"
  ) {
    logger.error(`Failed to parse JSON from Copilot Proxy response`);
    logger.error(`Raw response: ${text}`);
    throw new Error(
      "Invalid JSON returned from Copilot Proxy model: could not extract valid JSON",
    );
  }

  return jsonObject as Record<string, unknown>;
}

export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  const modelName = getSmallModel(runtime);
  return generateObjectByModelType(
    runtime,
    params,
    ModelType.OBJECT_SMALL,
    modelName,
    "small",
  );
}

export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  const modelName = getLargeModel(runtime);
  return generateObjectByModelType(
    runtime,
    params,
    ModelType.OBJECT_LARGE,
    modelName,
    "large",
  );
}
