import type { IAgentRuntime } from "@elizaos/core";
import type { ModelName, ModelSize, ValidatedApiKey } from "../types";
import { assertValidApiKey, createModelName } from "../types";

const DEFAULT_SMALL_MODEL = "glm-4.5-air";
const DEFAULT_LARGE_MODEL = "glm-5.1";

const DEFAULT_BASE_URL = "https://api.z.ai/api/paas/v4";

export interface ZaiThinkingConfig {
  readonly type: "enabled" | "disabled";
  readonly clear_thinking?: boolean;
}

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
      return normalizeBaseURL(browserURL);
    }
  }

  const raw = getRawSetting(runtime, "ZAI_BASE_URL") ?? DEFAULT_BASE_URL;
  return normalizeDirectApiBaseURL(raw);
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

function parsePositiveInt(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }
  const parsed = parseInt(value, 10);
  return !Number.isNaN(parsed) && parsed > 0 ? parsed : 0;
}

export function getCoTBudget(runtime: IAgentRuntime, modelSize: ModelSize): number {
  const specificKey = modelSize === "small" ? "ZAI_COT_BUDGET_SMALL" : "ZAI_COT_BUDGET_LARGE";

  const specific = parsePositiveInt(getRawSetting(runtime, specificKey));
  if (specific > 0) {
    return specific;
  }
  if (getRawSetting(runtime, specificKey) !== undefined) {
    return 0;
  }

  return parsePositiveInt(getRawSetting(runtime, "ZAI_COT_BUDGET"));
}

export function getThinkingConfig(
  runtime: IAgentRuntime,
  modelSize: ModelSize
): ZaiThinkingConfig | null {
  const explicit = getRawSetting(runtime, "ZAI_THINKING_TYPE")?.trim().toLowerCase();
  if (explicit === "enabled" || explicit === "disabled") {
    return { type: explicit };
  }
  if (getCoTBudget(runtime, modelSize) > 0) {
    return { type: "enabled" };
  }
  return null;
}

function normalizeBaseURL(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function normalizeDirectApiBaseURL(raw: string): string {
  const normalized = normalizeBaseURL(raw);
  const lower = normalized.toLowerCase();
  if (lower.includes("/api/coding/") || lower.includes("/api/anthropic")) {
    throw new Error(
      "ZAI_BASE_URL must target z.ai's general API endpoint (https://api.z.ai/api/paas/v4). " +
        "Coding Plan and Anthropic-compatible endpoints are reserved for supported coding tools."
    );
  }
  return normalized;
}

export function validateConfiguration(runtime: IAgentRuntime): void {
  if (!isBrowser()) {
    getApiKey(runtime);
  }
}
