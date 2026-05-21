import type { IAgentRuntime } from "@elizaos/core";
import type { ModelName, ValidatedApiKey } from "../types";
import { assertValidApiKey, createModelName } from "../types";

const DEFAULT_SMALL_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";
const DEFAULT_LARGE_MODEL = "zai-org/GLM-5.1-FP8";

const DEFAULT_BASE_URL = "https://cloud-api.near.ai/v1";

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
  return getRawSetting(runtime, "NEARAI_API_KEY");
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
    const browserURL = getRawSetting(runtime, "NEARAI_BROWSER_BASE_URL");
    if (browserURL) {
      return normalizeBaseURL(browserURL);
    }
  }

  const raw = getRawSetting(runtime, "NEARAI_BASE_URL") ?? DEFAULT_BASE_URL;
  return normalizeDirectApiBaseURL(raw);
}

export function getSmallModel(runtime: IAgentRuntime): ModelName {
  const model = getRawSetting(runtime, "NEARAI_SMALL_MODEL") ?? DEFAULT_SMALL_MODEL;
  return createModelName(model);
}

export function getLargeModel(runtime: IAgentRuntime): ModelName {
  const model = getRawSetting(runtime, "NEARAI_LARGE_MODEL") ?? DEFAULT_LARGE_MODEL;
  return createModelName(model);
}

export function getExperimentalTelemetry(runtime: IAgentRuntime): boolean {
  const setting = getRawSetting(runtime, "NEARAI_EXPERIMENTAL_TELEMETRY");
  if (!setting) {
    return false;
  }
  return setting.toLowerCase() === "true";
}

function normalizeBaseURL(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function normalizeDirectApiBaseURL(raw: string): string {
  const normalized = normalizeBaseURL(raw);
  return normalized;
}

export function validateConfiguration(runtime: IAgentRuntime): void {
  if (!isBrowser()) {
    getApiKey(runtime);
  }
}
