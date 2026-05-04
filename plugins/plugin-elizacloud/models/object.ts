import type { IAgentRuntime, JsonValue, ObjectGenerationParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { getJsonRepairFunction } from "../utils/helpers";
import { extractResponsesOutputText } from "../utils/responses-output";
import { createCloudApiClient } from "../utils/sdk-client";

/**
 * Models that are reasoning-class and don't support temperature.
 */
const REASONING_MODEL_PATTERNS = [
  "o1",
  "o3",
  "o4",
  "deepseek-r1",
  "deepseek-reasoner",
  "claude-opus-4.7",
  "claude-opus-4-7",
  "gpt-5",
] as const;

type ResponsesApiResponse = Record<string, unknown> & {
  error?: {
    message?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

function isReasoningModel(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return REASONING_MODEL_PATTERNS.some((pattern) => lower.includes(pattern));
}

async function generateObjectByModelType(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
  modelType: string,
  getModelFn: (runtime: IAgentRuntime) => string
): Promise<Record<string, JsonValue>> {
  const modelName = getModelFn(runtime);
  logger.log(`[ELIZAOS_CLOUD] Using ${modelType} model: ${modelName}`);

  const reasoning = isReasoningModel(modelName);
  const input: Array<{
    role: "system" | "user";
    content: Array<{ type: "input_text"; text: string }>;
  }> = [];
  if (runtime.character.system) {
    input.push({
      role: "system",
      content: [{ type: "input_text", text: runtime.character.system }],
    });
  }
  input.push({
    role: "user",
    content: [{ type: "input_text", text: params.prompt }],
  });

  const requestBody: Record<string, unknown> = {
    model: modelName,
    input,
    max_output_tokens: params.maxTokens ?? 8192,
    // Enforce JSON output at the API layer. Without this, the model
    // can ignore the caller's `schema` parameter and return prose
    // ("I'll help you...") or markdown-fenced JSON, both of which
    // choke the JSON.parse below.
    text: { format: { type: "json_object" } },
  };
  if (!reasoning && typeof params.temperature === "number") {
    requestBody.temperature = params.temperature;
  }

  const response = await createCloudApiClient(runtime).requestRaw("POST", "/responses", {
    json: requestBody,
  });
  const responseText = await response.text();
  let data: ResponsesApiResponse = {};
  if (responseText) {
    try {
      data = JSON.parse(responseText) as ResponsesApiResponse;
    } catch (parseErr) {
      logger.error(
        `[generateObject] Failed to parse Eliza Cloud JSON: ${
          parseErr instanceof Error ? parseErr.message : String(parseErr)
        }`
      );
    }
  }

  if (!response.ok) {
    const errorBody = typeof data === "object" && data ? data.error : undefined;
    const errorMessage =
      typeof errorBody?.message === "string" && errorBody.message.trim()
        ? errorBody.message.trim()
        : `elizaOS Cloud error ${response.status}`;
    const requestError = new Error(errorMessage) as Error & {
      status?: number;
      error?: unknown;
    };
    requestError.status = response.status;
    if (errorBody) {
      requestError.error = errorBody;
    }
    throw requestError;
  }

  if (data.usage) {
    emitModelUsageEvent(runtime, modelType as never, params.prompt, {
      inputTokens: data.usage.input_tokens ?? 0,
      outputTokens: data.usage.output_tokens ?? 0,
      totalTokens: data.usage.total_tokens ?? 0,
    });
  }

  let jsonText = extractResponsesOutputText(data);
  if (!jsonText.trim()) {
    throw new Error("Object generation returned empty response");
  }

  // Strip leading/trailing markdown code fences before JSON.parse. Models
  // routinely wrap structured output in ```json ... ``` even when JSON is
  // requested, and the repair function does not handle the leading backtick.
  jsonText = jsonText
    .replace(/^[\s]*```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(jsonText) as Record<string, JsonValue>;
  } catch (error) {
    const repairFunction = getJsonRepairFunction();
    const repairedJsonString = await repairFunction({
      text: jsonText,
      error,
    });

    if (repairedJsonString) {
      try {
        const repairedObject = JSON.parse(repairedJsonString);
        logger.info("[generateObject] Successfully repaired JSON.");
        return repairedObject as Record<string, JsonValue>;
      } catch (repairParseError) {
        const message =
          repairParseError instanceof Error ? repairParseError.message : String(repairParseError);
        logger.error(`[generateObject] Failed to parse repaired JSON: ${message}`);
        throw repairParseError;
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[generateObject] Failed to parse JSON: ${message}`);
    throw error;
  }
}

export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, JsonValue>> {
  return generateObjectByModelType(runtime, params, ModelType.OBJECT_SMALL, getSmallModel);
}

export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, JsonValue>> {
  return generateObjectByModelType(runtime, params, ModelType.OBJECT_LARGE, getLargeModel);
}
