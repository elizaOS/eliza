import type { IAgentRuntime } from "@elizaos/core";
import type { ModelName, ModelSize, ValidatedApiKey } from "../types";
import { assertValidApiKey, createModelName } from "../types";

// z.ai exposes an Anthropic-compatible API. These Claude-style model
// aliases are intentionally identical because z.ai currently maps both
// elizaOS text tiers to the same default GLM-backed model server-side.
const DEFAULT_SMALL_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_LARGE_MODEL = "claude-sonnet-4-20250514";

// IMPORTANT: Anthropic SDK expects a base URL that ends with /v1
// (e.g. https://api.anthropic.com/v1). z.ai's compatible endpoint is:
// https://api.z.ai/api/anthropic/v1
const DEFAULT_BASE_URL = "https://api.z.ai/api/anthropic/v1";

export function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: Document }).document !== "undefined"
  );
}

function getEnvValue(key: string): string | undefined {
  // In real browsers, `process` is not defined. `typeof process` is safe.
  if (typeof process === "undefined") {
    return undefined;
  }

  const envValue = process.env[key];
  if (typeof envValue === "string" && envValue.length > 0) {
    return envValue;
  }

  return undefined;
}

export function getRawSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const runtimeValue = runtime.getSetting(key);
  if (typeof runtimeValue === "string" && runtimeValue.length > 0) {
    return runtimeValue;
  }

  return getEnvValue(key);
}

function getCanonicalApiKeySetting(runtime: IAgentRuntime): string | undefined {
  return getRawSetting(runtime, "ZAI_API_KEY") ?? getRawSetting(runtime, "Z_AI_API_KEY");
}

export function getApiKey(runtime: IAgentRuntime): ValidatedApiKey {
  const apiKey = getCanonicalApiKeySetting(runtime);
  assertValidApiKey(apiKey);
  return apiKey;
}

export function getApiKeyOptional(runtime: IAgentRuntime): ValidatedApiKey | null {
  const apiKey = getCanonicalApiKeySetting(runtime);
  if (!apiKey || apiKey.trim().length === 0) {
    return null;
  }
  return apiKey as ValidatedApiKey;
}

export function getBaseURL(runtime: IAgentRuntime): string {
  if (isBrowser()) {
    const browserURL = getRawSetting(runtime, "ZAI_BROWSER_BASE_URL");
    if (browserURL) {
      return browserURL;
    }
  }

  const raw = getRawSetting(runtime, "ZAI_BASE_URL") ?? DEFAULT_BASE_URL;
  // normalize to /v1 (some callers may pass https://api.z.ai/api/anthropic)
  return /\/v1\/?$/.test(raw) ? raw : `${raw.replace(/\/+$/, "")}/v1`;
}

export function getSmallModel(runtime: IAgentRuntime): ModelName {
  const model = getRawSetting(runtime, "ZAI_SMALL_MODEL") ?? DEFAULT_SMALL_MODEL;
  return createModelName(model);
}

export function getLargeModel(runtime: IAgentRuntime): ModelName {
  const model = getRawSetting(runtime, "ZAI_LARGE_MODEL") ?? DEFAULT_LARGE_MODEL;
  return createModelName(model);
}

export function getExperimentalTelemetry(runtime: IAgentRuntime): boolean {
  const setting = getRawSetting(runtime, "ZAI_EXPERIMENTAL_TELEMETRY");
  if (!setting) {
    return false;
  }
  return setting.toLowerCase() === "true";
}

export function getCoTBudget(runtime: IAgentRuntime, modelSize: ModelSize): number {
  const specificKey = modelSize === "small" ? "ZAI_COT_BUDGET_SMALL" : "ZAI_COT_BUDGET_LARGE";

  const specificValue = getRawSetting(runtime, specificKey);
  if (specificValue !== undefined) {
    const parsed = parseInt(specificValue, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
    return 0;
  }

  const sharedValue = getRawSetting(runtime, "ZAI_COT_BUDGET");
  if (sharedValue !== undefined) {
    const parsed = parseInt(sharedValue, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return 0;
}

export function validateConfiguration(runtime: IAgentRuntime): void {
  if (!isBrowser()) {
    getApiKey(runtime);
  }
}
