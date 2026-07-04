/**
 * Central settings layer for the plugin. Every accessor reads
 * `runtime.getSetting(key)` first, then `process.env[key]`, with the `ANTHROPIC_`
 * prefix taking priority over bare-name cross-provider fallbacks. Provides the
 * per-slot model selectors (`getSmallModel`, `getLargeModel`, `getNanoModel`, …)
 * with their small/large fallback chains, auth-mode / API-key / base-URL
 * resolution, the `isBrowser` guard, and the CoT-budget, temperature-lock, and
 * max-output-token override parsers documented in this package's CLAUDE.md.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { ModelName, ModelSize, ValidatedApiKey } from "../types";
import { createModelName } from "../types";

const DEFAULT_SMALL_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_LARGE_MODEL = "claude-opus-4-7";
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
  if (typeof runtimeValue === "string" && runtimeValue.trim().length > 0) {
    return runtimeValue;
  }

  return getEnvValue(key);
}

export function getApiKeyOptional(runtime: IAgentRuntime): ValidatedApiKey | null {
  const apiKey = getRawSetting(runtime, "ANTHROPIC_API_KEY");
  if (!apiKey || apiKey.trim().length === 0) {
    return null;
  }
  return apiKey as ValidatedApiKey;
}

/**
 * Route to the wire-level mock server when one is running. `ELIZA_MOCK_ANTHROPIC_BASE`
 * is set only by the in-process mock runner (`packages/test/mocks`) and never in
 * production — honoring it directly mirrors how LifeOps consumes its sibling
 * `ELIZA_MOCK_*_BASE` vars (`mockoon-redirect.ts`). It is authoritative when set
 * (a deliberate test action), so it wins over any configured base; in production
 * it is unset and has no effect.
 */
function getMockBaseURL(): string | undefined {
  return getEnvValue("ELIZA_MOCK_ANTHROPIC_BASE");
}

export function getBaseURL(runtime: IAgentRuntime): string {
  const mockBaseURL = getMockBaseURL();
  if (mockBaseURL) {
    return mockBaseURL;
  }
  if (isBrowser()) {
    const browserURL = getRawSetting(runtime, "ANTHROPIC_BROWSER_BASE_URL");
    if (browserURL) {
      return browserURL;
    }
  }
  return getRawSetting(runtime, "ANTHROPIC_BASE_URL") ?? DEFAULT_BASE_URL;
}

export function getSmallModel(runtime: IAgentRuntime): ModelName {
  const model =
    getRawSetting(runtime, "ANTHROPIC_SMALL_MODEL") ??
    getRawSetting(runtime, "SMALL_MODEL") ??
    DEFAULT_SMALL_MODEL;
  return createModelName(model);
}

export function getNanoModel(runtime: IAgentRuntime): ModelName {
  const model =
    getRawSetting(runtime, "ANTHROPIC_NANO_MODEL") ??
    getRawSetting(runtime, "NANO_MODEL") ??
    getSmallModel(runtime);
  return createModelName(model);
}

export function getMediumModel(runtime: IAgentRuntime): ModelName {
  const model =
    getRawSetting(runtime, "ANTHROPIC_MEDIUM_MODEL") ??
    getRawSetting(runtime, "MEDIUM_MODEL") ??
    getSmallModel(runtime);
  return createModelName(model);
}

export function getLargeModel(runtime: IAgentRuntime): ModelName {
  const model =
    getRawSetting(runtime, "ANTHROPIC_LARGE_MODEL") ??
    getRawSetting(runtime, "LARGE_MODEL") ??
    DEFAULT_LARGE_MODEL;
  return createModelName(model);
}

export function getMegaModel(runtime: IAgentRuntime): ModelName {
  const model =
    getRawSetting(runtime, "ANTHROPIC_MEGA_MODEL") ??
    getRawSetting(runtime, "MEGA_MODEL") ??
    getLargeModel(runtime);
  return createModelName(model);
}

export function getResponseHandlerModel(runtime: IAgentRuntime): ModelName {
  const model =
    getRawSetting(runtime, "ANTHROPIC_RESPONSE_HANDLER_MODEL") ??
    getRawSetting(runtime, "ANTHROPIC_SHOULD_RESPOND_MODEL") ??
    getRawSetting(runtime, "RESPONSE_HANDLER_MODEL") ??
    getRawSetting(runtime, "SHOULD_RESPOND_MODEL") ??
    getSmallModel(runtime);
  return createModelName(model);
}

export function getActionPlannerModel(runtime: IAgentRuntime): ModelName {
  const model =
    getRawSetting(runtime, "ANTHROPIC_ACTION_PLANNER_MODEL") ??
    getRawSetting(runtime, "ANTHROPIC_PLANNER_MODEL") ??
    getRawSetting(runtime, "ACTION_PLANNER_MODEL") ??
    getRawSetting(runtime, "PLANNER_MODEL") ??
    getLargeModel(runtime);
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

/**
 * Capability overrides for model ids the name-substring heuristics in
 * models/text.ts don't know about. New Claude releases can ship hard request
 * constraints (temperature locked to 1, tighter output-token ceilings); listing
 * an id here applies the constraint without a code release. Unlisted ids keep
 * the existing heuristics.
 */
export function isTemperatureLockedModel(runtime: IAgentRuntime, modelName: ModelName): boolean {
  const raw = getRawSetting(runtime, "ANTHROPIC_TEMPERATURE_LOCKED_MODELS");
  if (!raw) {
    return false;
  }
  const target = modelName.toLowerCase();
  return raw.split(",").some((entry) => entry.trim().toLowerCase() === target);
}

/**
 * ANTHROPIC_MAX_OUTPUT_TOKENS accepts comma-separated `model-id:tokens` pairs
 * and/or a bare token count that applies to models without a per-model entry
 * (e.g. "claude-unknown-test-9:32000" or "16000"). Returns the output-token cap
 * for `modelName`, or undefined to use the built-in heuristic.
 */
export function getMaxOutputTokensOverride(
  runtime: IAgentRuntime,
  modelName: ModelName
): number | undefined {
  const raw = getRawSetting(runtime, "ANTHROPIC_MAX_OUTPUT_TOKENS");
  if (!raw) {
    return undefined;
  }
  const target = modelName.toLowerCase();
  let fallback: number | undefined;
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.lastIndexOf(":");
    const parsed = Number.parseInt(separator === -1 ? trimmed : trimmed.slice(separator + 1), 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      continue;
    }
    if (separator === -1) {
      fallback = parsed;
    } else if (trimmed.slice(0, separator).trim().toLowerCase() === target) {
      return parsed;
    }
  }
  return fallback;
}

export function getAuthMode(runtime: IAgentRuntime): "cli" | "oauth" | "apikey" {
  const mode = getRawSetting(runtime, "ANTHROPIC_AUTH_MODE");
  if (mode === "claude-cli") return "cli";
  if (mode === "oauth") return "oauth";
  return "apikey";
}

export function getReasoningSmallModel(runtime: IAgentRuntime): ModelName {
  const model =
    getRawSetting(runtime, "ANTHROPIC_REASONING_SMALL_MODEL") ??
    getRawSetting(runtime, "REASONING_SMALL_MODEL") ??
    getSmallModel(runtime);
  return createModelName(model);
}

export function getReasoningLargeModel(runtime: IAgentRuntime): ModelName {
  const model =
    getRawSetting(runtime, "ANTHROPIC_REASONING_LARGE_MODEL") ??
    getRawSetting(runtime, "REASONING_LARGE_MODEL") ??
    getLargeModel(runtime);
  return createModelName(model);
}
