import type { IAgentRuntime } from "@elizaos/core";
import type { ModelName, ModelSize, ValidatedApiKey } from "../types";
import { assertValidApiKey, createModelName } from "../types";

const DEFAULT_SMALL_MODEL = "claude-3-5-haiku-20241022";
const DEFAULT_LARGE_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

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

function getRawSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const runtimeValue = runtime.getSetting(key);
  if (typeof runtimeValue === "string" && runtimeValue.length > 0) {
    return runtimeValue;
  }

  return getEnvValue(key);
}

export function getApiKey(runtime: IAgentRuntime): ValidatedApiKey {
  const apiKey = getRawSetting(runtime, "ANTHROPIC_API_KEY");
  assertValidApiKey(apiKey);
  return apiKey;
}

export function getApiKeyOptional(runtime: IAgentRuntime): ValidatedApiKey | null {
  const apiKey = getRawSetting(runtime, "ANTHROPIC_API_KEY");
  if (!apiKey || apiKey.trim().length === 0) {
    return null;
  }
  return apiKey as ValidatedApiKey;
}

export function getBaseURL(runtime: IAgentRuntime): string {
  if (isBrowser()) {
    const browserURL = getRawSetting(runtime, "ANTHROPIC_BROWSER_BASE_URL");
    if (browserURL) {
      return browserURL;
    }
  }
  return getRawSetting(runtime, "ANTHROPIC_BASE_URL") ?? DEFAULT_BASE_URL;
}

export function getSmallModel(runtime: IAgentRuntime): ModelName {
  const model = getRawSetting(runtime, "ANTHROPIC_SMALL_MODEL") ?? DEFAULT_SMALL_MODEL;
  return createModelName(model);
}

export function getLargeModel(runtime: IAgentRuntime): ModelName {
  const model = getRawSetting(runtime, "ANTHROPIC_LARGE_MODEL") ?? DEFAULT_LARGE_MODEL;
  return createModelName(model);
}

export function getExperimentalTelemetry(runtime: IAgentRuntime): boolean {
  const setting = getRawSetting(runtime, "ANTHROPIC_EXPERIMENTAL_TELEMETRY");
  if (!setting) {
    return false;
  }
  return setting.toLowerCase() === "true";
}

export function getCoTBudget(runtime: IAgentRuntime, modelSize: ModelSize): number {
  const specificKey =
    modelSize === "small" ? "ANTHROPIC_COT_BUDGET_SMALL" : "ANTHROPIC_COT_BUDGET_LARGE";

  const specificValue = getRawSetting(runtime, specificKey);
  if (specificValue !== undefined) {
    const parsed = parseInt(specificValue, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
    return 0;
  }

  const sharedValue = getRawSetting(runtime, "ANTHROPIC_COT_BUDGET");
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
