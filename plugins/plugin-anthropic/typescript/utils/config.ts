/**
 * Configuration utilities for the Anthropic plugin.
 *
 * All config functions either return a definite value or throw an error.
 * No optional returns for required values - fail fast.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { ModelName, ModelSize, ValidatedApiKey } from "../types";
import { assertValidApiKey, createModelName } from "../types";

/** Default models */
const DEFAULT_SMALL_MODEL = "claude-3-5-haiku-20241022";
const DEFAULT_LARGE_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

/**
 * Environment detection for browser vs Node
 */
export function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: unknown }).document !== "undefined"
  );
}

/**
 * Get a setting from runtime or environment.
 * Returns the value or undefined - no defaults here.
 */
function getRawSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const runtimeValue = runtime.getSetting(key);
  if (typeof runtimeValue === "string" && runtimeValue.length > 0) {
    return runtimeValue;
  }
  const envValue = process.env[key];
  if (typeof envValue === "string" && envValue.length > 0) {
    return envValue;
  }
  return undefined;
}

/**
 * Get and validate the Anthropic API key.
 * @throws Error if API key is not configured
 */
export function getApiKey(runtime: IAgentRuntime): ValidatedApiKey {
  const apiKey = getRawSetting(runtime, "ANTHROPIC_API_KEY");
  assertValidApiKey(apiKey);
  return apiKey;
}

/**
 * Get the API key if available, without throwing.
 * For use in contexts where missing API key is acceptable (e.g., browser).
 */
export function getApiKeyOptional(runtime: IAgentRuntime): ValidatedApiKey | null {
  const apiKey = getRawSetting(runtime, "ANTHROPIC_API_KEY");
  if (!apiKey || apiKey.trim().length === 0) {
    return null;
  }
  return apiKey as ValidatedApiKey;
}

/**
 * Get the Anthropic API base URL.
 * Uses browser URL if in browser and configured, otherwise uses server URL.
 */
export function getBaseURL(runtime: IAgentRuntime): string {
  if (isBrowser()) {
    const browserURL = getRawSetting(runtime, "ANTHROPIC_BROWSER_BASE_URL");
    if (browserURL) {
      return browserURL;
    }
  }
  return getRawSetting(runtime, "ANTHROPIC_BASE_URL") ?? DEFAULT_BASE_URL;
}

/**
 * Get the small model name.
 */
export function getSmallModel(runtime: IAgentRuntime): ModelName {
  const model = getRawSetting(runtime, "ANTHROPIC_SMALL_MODEL") ?? DEFAULT_SMALL_MODEL;
  return createModelName(model);
}

/**
 * Get the large model name.
 */
export function getLargeModel(runtime: IAgentRuntime): ModelName {
  const model = getRawSetting(runtime, "ANTHROPIC_LARGE_MODEL") ?? DEFAULT_LARGE_MODEL;
  return createModelName(model);
}

/**
 * Get experimental telemetry setting.
 */
export function getExperimentalTelemetry(runtime: IAgentRuntime): boolean {
  const setting = getRawSetting(runtime, "ANTHROPIC_EXPERIMENTAL_TELEMETRY");
  if (!setting) {
    return false;
  }
  return setting.toLowerCase() === "true";
}

/**
 * Get the Chain-of-Thought budget for a specific model size.
 * Returns 0 if not configured or invalid (CoT disabled).
 *
 * Hierarchy: model-specific setting → shared setting → 0
 */
export function getCoTBudget(runtime: IAgentRuntime, modelSize: ModelSize): number {
  const specificKey =
    modelSize === "small" ? "ANTHROPIC_COT_BUDGET_SMALL" : "ANTHROPIC_COT_BUDGET_LARGE";

  // Try model-specific setting first
  const specificValue = getRawSetting(runtime, specificKey);
  if (specificValue !== undefined) {
    const parsed = parseInt(specificValue, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
    // If specified but invalid/zero, return 0 (explicitly disabled)
    return 0;
  }

  // Fall back to shared setting
  const sharedValue = getRawSetting(runtime, "ANTHROPIC_COT_BUDGET");
  if (sharedValue !== undefined) {
    const parsed = parseInt(sharedValue, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // Default: CoT disabled
  return 0;
}

/**
 * Validate that all required configuration is present.
 * @throws Error with details about what's missing
 */
export function validateConfiguration(runtime: IAgentRuntime): void {
  // In browser mode, API key validation is optional (use proxy)
  if (!isBrowser()) {
    getApiKey(runtime); // Throws if missing
  }
}
