import type { IAgentRuntime } from "@elizaos/core";
import type { ModelName, ValidatedBaseUrl } from "./types";
import { createModelName, createValidatedBaseUrl } from "./types";

/**
 * Default base URL for the Copilot Proxy server.
 */
export const DEFAULT_BASE_URL = "http://localhost:3000/v1";

/**
 * Default small model for fast completions.
 */
export const DEFAULT_SMALL_MODEL = "gpt-5-mini";

/**
 * Default large model for capable completions.
 */
export const DEFAULT_LARGE_MODEL = "gpt-5.1";

/**
 * Default timeout in seconds.
 */
export const DEFAULT_TIMEOUT_SECONDS = 120;

/**
 * Default maximum tokens for completions.
 */
export const DEFAULT_MAX_TOKENS = 8192;

/**
 * Default context window size.
 */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/**
 * Available model IDs for Copilot Proxy.
 */
export const AVAILABLE_MODELS = [
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5-mini",
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "gemini-3-pro",
  "gemini-3-flash",
  "grok-code-fast-1",
] as const;

/**
 * Check if running in a browser environment.
 */
export function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: Document }).document !== "undefined"
  );
}

/**
 * Safely get environment variable value.
 */
function getEnvValue(key: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  const envValue = process.env[key];
  if (typeof envValue === "string" && envValue.length > 0) {
    return envValue;
  }
  return undefined;
}

/**
 * Get a raw setting from runtime or environment.
 */
function getRawSetting(
  runtime: IAgentRuntime,
  key: string,
): string | undefined {
  const runtimeValue = runtime.getSetting(key);
  if (typeof runtimeValue === "string" && runtimeValue.length > 0) {
    return runtimeValue;
  }
  return getEnvValue(key);
}

/**
 * Normalize a base URL to ensure it has the correct format.
 */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_BASE_URL;
  }
  let normalized = trimmed;
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (!normalized.endsWith("/v1")) {
    normalized = `${normalized}/v1`;
  }
  return normalized;
}

/**
 * Get the base URL for the Copilot Proxy server.
 */
export function getBaseUrl(runtime: IAgentRuntime): ValidatedBaseUrl {
  const rawUrl = getRawSetting(runtime, "COPILOT_PROXY_BASE_URL");
  const url = rawUrl ? normalizeBaseUrl(rawUrl) : DEFAULT_BASE_URL;
  return createValidatedBaseUrl(url);
}

/**
 * Get the base URL as an optional value.
 */
export function getBaseUrlOptional(
  runtime: IAgentRuntime,
): ValidatedBaseUrl | null {
  const rawUrl = getRawSetting(runtime, "COPILOT_PROXY_BASE_URL");
  if (!rawUrl || rawUrl.trim().length === 0) {
    return null;
  }
  try {
    const url = normalizeBaseUrl(rawUrl);
    return createValidatedBaseUrl(url);
  } catch {
    return null;
  }
}

/**
 * Check if the plugin is enabled.
 */
export function isPluginEnabled(runtime: IAgentRuntime): boolean {
  const setting = getRawSetting(runtime, "COPILOT_PROXY_ENABLED");
  if (!setting) {
    return true; // Enabled by default
  }
  return setting.toLowerCase() !== "false";
}

/**
 * Get the default model ID.
 */
export function getDefaultModel(runtime: IAgentRuntime): ModelName {
  const model =
    getRawSetting(runtime, "COPILOT_PROXY_MODEL") ?? DEFAULT_LARGE_MODEL;
  return createModelName(model);
}

/**
 * Get the small model ID.
 */
export function getSmallModel(runtime: IAgentRuntime): ModelName {
  const model =
    getRawSetting(runtime, "COPILOT_PROXY_SMALL_MODEL") ?? DEFAULT_SMALL_MODEL;
  return createModelName(model);
}

/**
 * Get the large model ID.
 */
export function getLargeModel(runtime: IAgentRuntime): ModelName {
  const model =
    getRawSetting(runtime, "COPILOT_PROXY_LARGE_MODEL") ?? DEFAULT_LARGE_MODEL;
  return createModelName(model);
}

/**
 * Get the timeout in seconds.
 */
export function getTimeoutSeconds(runtime: IAgentRuntime): number {
  const setting = getRawSetting(runtime, "COPILOT_PROXY_TIMEOUT_SECONDS");
  if (!setting) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  const parsed = parseInt(setting, 10);
  return Number.isNaN(parsed) ? DEFAULT_TIMEOUT_SECONDS : parsed;
}

/**
 * Get the maximum tokens setting.
 */
export function getMaxTokens(runtime: IAgentRuntime): number {
  const setting = getRawSetting(runtime, "COPILOT_PROXY_MAX_TOKENS");
  if (!setting) {
    return DEFAULT_MAX_TOKENS;
  }
  const parsed = parseInt(setting, 10);
  return Number.isNaN(parsed) ? DEFAULT_MAX_TOKENS : parsed;
}

/**
 * Get the context window size.
 */
export function getContextWindow(runtime: IAgentRuntime): number {
  const setting = getRawSetting(runtime, "COPILOT_PROXY_CONTEXT_WINDOW");
  if (!setting) {
    return DEFAULT_CONTEXT_WINDOW;
  }
  const parsed = parseInt(setting, 10);
  return Number.isNaN(parsed) ? DEFAULT_CONTEXT_WINDOW : parsed;
}

/**
 * Validate the plugin configuration.
 */
export function validateConfiguration(runtime: IAgentRuntime): void {
  if (!isBrowser()) {
    // Base URL validation is optional since we have a default
    const baseUrl = getBaseUrlOptional(runtime);
    if (baseUrl) {
      try {
        new URL(baseUrl);
      } catch {
        throw new Error(`Invalid COPILOT_PROXY_BASE_URL: ${baseUrl}`);
      }
    }
  }
}
