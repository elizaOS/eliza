import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from "@google/genai";

function getEnvValue(key: string): string | undefined {
  // In browsers, `process` is not defined. `typeof process` is safe.
  if (typeof process === "undefined") {
    return undefined;
  }
  const value = process.env[key];
  return value === undefined ? undefined : String(value);
}

export function getSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue?: string,
): string | undefined {
  const runtimeValue = runtime.getSetting(key);
  if (runtimeValue !== undefined) {
    return String(runtimeValue);
  }
  return getEnvValue(key) ?? defaultValue;
}

export function getApiKey(runtime: IAgentRuntime): string | undefined {
  return getSetting(runtime, "GOOGLE_GENERATIVE_AI_API_KEY");
}

export function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "GOOGLE_SMALL_MODEL") ??
    getSetting(runtime, "SMALL_MODEL", "gemini-2.0-flash-001") ??
    "gemini-2.0-flash-001"
  );
}

export function getNanoModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "GOOGLE_NANO_MODEL") ??
    getSetting(runtime, "NANO_MODEL") ??
    getSmallModel(runtime)
  );
}

export function getMediumModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "GOOGLE_MEDIUM_MODEL") ??
    getSetting(runtime, "MEDIUM_MODEL") ??
    getSmallModel(runtime)
  );
}

export function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "GOOGLE_LARGE_MODEL") ??
    getSetting(runtime, "LARGE_MODEL", "gemini-2.5-pro-preview-03-25") ??
    "gemini-2.5-pro-preview-03-25"
  );
}

export function getMegaModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "GOOGLE_MEGA_MODEL") ??
    getSetting(runtime, "MEGA_MODEL") ??
    getLargeModel(runtime)
  );
}

export function getResponseHandlerModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "GOOGLE_RESPONSE_HANDLER_MODEL") ??
    getSetting(runtime, "GOOGLE_SHOULD_RESPOND_MODEL") ??
    getSetting(runtime, "RESPONSE_HANDLER_MODEL") ??
    getSetting(runtime, "SHOULD_RESPOND_MODEL") ??
    getNanoModel(runtime)
  );
}

export function getActionPlannerModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "GOOGLE_ACTION_PLANNER_MODEL") ??
    getSetting(runtime, "GOOGLE_PLANNER_MODEL") ??
    getSetting(runtime, "ACTION_PLANNER_MODEL") ??
    getSetting(runtime, "PLANNER_MODEL") ??
    getMediumModel(runtime)
  );
}

export function getImageModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "GOOGLE_IMAGE_MODEL") ??
    getSetting(runtime, "IMAGE_MODEL", "gemini-2.5-pro-preview-03-25") ??
    "gemini-2.5-pro-preview-03-25"
  );
}

export function getEmbeddingModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "GOOGLE_EMBEDDING_MODEL", "text-embedding-004") ??
    "text-embedding-004"
  );
}

export function createGoogleGenAI(runtime: IAgentRuntime): GoogleGenAI | null {
  const apiKey = getApiKey(runtime);
  if (!apiKey) {
    logger.error("Google Generative AI API Key is missing");
    return null;
  }

  return new GoogleGenAI({ apiKey });
}

export function getSafetySettings() {
  return [
    {
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
  ];
}
