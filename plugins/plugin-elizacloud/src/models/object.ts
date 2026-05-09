import type { IAgentRuntime, JsonValue, ObjectGenerationParams } from "@elizaos/core";
import { buildCanonicalSystemPrompt, logger, ModelType } from "@elizaos/core";
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

/**
 * Iterate every `{` / `[` in `text`, walk each candidate to its matching
 * close bracket (respecting JSON string escapes), and return the first slice
 * that successfully parses as JSON. Falls back to returning the input
 * unchanged when no candidate parses — caller routes to `jsonRepair` from
 * there.
 *
 * Locking onto the *first* opener (an earlier draft) misroutes payloads where
 * prose contains markdown checkboxes, citations, or other bracketed text
 * before the actual JSON block — `[note] {"x":1}` would return `[note]`
 * even though valid JSON appears later. Try-parsing each candidate avoids
 * that.
 *
 * Exported for unit-testability; called unconditionally by the `responses`
 * object-generation path so duplicated/prose-prefixed bodies parse cleanly.
 */
export function extractFirstBalancedJsonValue(text: string): string {
  if (text.length === 0) return text;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const firstObj = text.indexOf("{", searchFrom);
    const firstArr = text.indexOf("[", searchFrom);
    const start =
      firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
    if (start < 0) break;
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end > start) {
      const candidate = text.slice(start, end + 1).trim();
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // not parseable — advance past this opener and try the next one
      }
    }
    searchFrom = start + 1;
  }
  return text;
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
  const systemPrompt = buildCanonicalSystemPrompt({ character: runtime.character });
  if (systemPrompt) {
    input.push({
      role: "system",
      content: [{ type: "input_text", text: systemPrompt }],
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
  // Some upstreams emit a single backtick or an unusual fence count, so the
  // pattern accepts 1+ backticks rather than exactly 3.
  jsonText = jsonText
    .replace(/^[\s]*`{1,}(?:json)?\s*\n?/i, "")
    .replace(/\n?`{1,}\s*$/i, "")
    .trim();

  // Isolate exactly one balanced top-level JSON value. Handles two failure
  // modes seen in production: (a) the response carries extra prose before
  // the JSON, and (b) the response contains duplicated copies of the JSON
  // glued together with stray fences between them (which happens when
  // extractResponsesOutputText concatenates output_text and output[]
  // segments containing the same body). Runs unconditionally — for already
  // clean single-value input start=0 and the slice returns the same string.
  jsonText = extractFirstBalancedJsonValue(jsonText);

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
