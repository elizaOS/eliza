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
  defaultValue?: string
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

export function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "GOOGLE_LARGE_MODEL") ??
    getSetting(runtime, "LARGE_MODEL", "gemini-2.5-pro-preview-03-25") ??
    "gemini-2.5-pro-preview-03-25"
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
    getSetting(runtime, "GOOGLE_EMBEDDING_MODEL", "text-embedding-004") ?? "text-embedding-004"
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
