/**
 * Settings resolution for the Gemini provider. `getSetting` reads
 * `runtime.getSetting` first, then `process.env` (guarding `typeof process` so
 * the browser build stays Node-free), trimming blanks to `undefined`. The
 * `get*Model` helpers layer the model-name fallback chain: each tier prefers its
 * `GOOGLE_*` key, then the generic alias, then a coarser tier's default.
 * `createGoogleGenAI` builds an authenticated client (null when no key), and
 * `getSafetySettings` returns the hardcoded block-medium-and-above thresholds.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from "@google/genai";

function getEnvValue(key: string): string | undefined {
  // In browsers, `process` is not defined. `typeof process` is safe.
  if (typeof process === "undefined") {
    return undefined;
  }
  const value = process.env[key];
  return normalizeSettingValue(value);
}

function normalizeSettingValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue?: string,
): string | undefined {
  const runtimeValue = normalizeSettingValue(runtime.getSetting(key));
  if (runtimeValue !== undefined) {
    return runtimeValue;
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
    getSetting(runtime, "LARGE_MODEL", "gemini-2.5-pro") ??
    "gemini-2.5-pro"
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
    getSetting(runtime, "IMAGE_MODEL", "gemini-2.5-pro") ??
    "gemini-2.5-pro"
  );
}

/**
 * Default Google embedding model. `text-embedding-004` (the historical default)
 * 404s on the current `v1beta` `embedContent` route used by `@google/genai`
 * — see Gate-1 evidence: bare `text-embedding-004` → 404 NOT_FOUND (v1beta),
 * breaking every memory embedding write and bundled-document seed. Google's
 * supported replacement on that route is `gemini-embedding-001`, so that is the
 * default now. An explicit `GOOGLE_EMBEDDING_MODEL` override still wins.
 */
export const DEFAULT_GOOGLE_EMBEDDING_MODEL = "gemini-embedding-001";

/**
 * Per-model input token limit for the embedding endpoint. Google documents a
 * 2,048-token input limit for `gemini-embedding-001`, while the larger-window
 * `gemini-embedding-2` accepts 8,192 tokens. `handleTextEmbedding` derives its
 * provider-tokenized truncation boundary from this map so the request never
 * exceeds the model's real limit; an unmapped/override id falls back to 2,048
 * limit (`DEFAULT_EMBEDDING_INPUT_TOKEN_LIMIT`) rather than assuming the larger
 * window. This is a hard model constraint — it must not be confused with the
 * telemetry-only `length / 4` estimate in `utils/tokenization.ts`.
 */
export const EMBEDDING_INPUT_TOKEN_LIMITS: Readonly<Record<string, number>> = {
  "gemini-embedding-001": 2_048,
  "gemini-embedding-2": 8_192,
};

/**
 * Safe default input token limit used when a `GOOGLE_EMBEDDING_MODEL` override
 * names a model that is not in `EMBEDDING_INPUT_TOKEN_LIMITS`. Matches the
 * current default model (`gemini-embedding-001`) so an unknown id can never be
 * truncated to a window larger than it supports.
 */
export const DEFAULT_EMBEDDING_INPUT_TOKEN_LIMIT = 2_048;

/**
 * Resolve the documented input token limit for an embedding model id, falling
 * back to the safe default for unmapped overrides. Google accepts either a
 * bare model id or its `models/` resource name, so the optional resource prefix
 * is ignored only for this local constraint lookup; callers still pass the
 * configured model string unchanged to the SDK.
 */
export function getEmbeddingInputTokenLimit(model: string): number {
  const lookupModel = model.startsWith("models/")
    ? model.slice("models/".length)
    : model;
  return (
    EMBEDDING_INPUT_TOKEN_LIMITS[lookupModel] ??
    DEFAULT_EMBEDDING_INPUT_TOKEN_LIMIT
  );
}

export function getEmbeddingModel(runtime: IAgentRuntime): string {
  return (
    getSetting(
      runtime,
      "GOOGLE_EMBEDDING_MODEL",
      DEFAULT_GOOGLE_EMBEDDING_MODEL,
    ) ?? DEFAULT_GOOGLE_EMBEDDING_MODEL
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
