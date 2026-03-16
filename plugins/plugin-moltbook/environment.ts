import type { IAgentRuntime } from "@elizaos/core";
import { AUTONOMY_DEFAULTS, URLS } from "./constants";
import type { MoltbookSettings } from "./types";

/**
 * Get Moltbook settings from runtime with proper priority:
 * Environment variables > Character settings > Defaults
 */
export function getMoltbookSettings(runtime: IAgentRuntime): MoltbookSettings {
  const getSetting = (
    key: string,
    defaultValue?: string,
  ): string | undefined => {
    const envValue = runtime.getSetting(key) as string | undefined;
    if (envValue && typeof envValue === "string" && envValue.trim()) {
      return envValue.trim();
    }

    // Check character settings
    const characterSettings = runtime.character?.settings?.moltbook as
      | Record<string, string>
      | undefined;
    if (characterSettings?.[key]) {
      return characterSettings[key];
    }

    return defaultValue;
  };

  const getBoolSetting = (key: string, defaultValue: boolean): boolean => {
    const value = getSetting(key);
    if (value === undefined) return defaultValue;
    return value === "true" || value === "1";
  };

  const getNumberSetting = (key: string, defaultValue: number): number => {
    const value = getSetting(key);
    if (value === undefined) return defaultValue;
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
  };

  // Agent name: prefer MOLTBOOK_AGENT_NAME, then character name
  const agentName =
    getSetting("MOLTBOOK_AGENT_NAME") ?? runtime.character?.name ?? "Agent";

  return {
    agentName,

    // Moltbook integration
    moltbookToken: getSetting("MOLTBOOK_TOKEN"),

    // LLM settings
    llmApiKey: getSetting("LLM_API_KEY") ?? getSetting("OPENROUTER_API_KEY"),
    llmBaseUrl: getSetting("LLM_BASE_URL", URLS.openrouter),
    model: getSetting("MOLTBOOK_MODEL", AUTONOMY_DEFAULTS.defaultModel),

    // Agent personality
    personality:
      getSetting("MOLTBOOK_PERSONALITY") ??
      (Array.isArray(runtime.character?.bio)
        ? runtime.character.bio.join("\n")
        : (runtime.character?.bio ?? "")),

    // Autonomy settings
    autonomyIntervalMs: getNumberSetting(
      "MOLTBOOK_AUTONOMY_INTERVAL_MS",
      AUTONOMY_DEFAULTS.minIntervalMs,
    ),
    autonomyMaxSteps: getNumberSetting("MOLTBOOK_AUTONOMY_MAX_STEPS", 0), // 0 = unlimited
    autonomousMode: getBoolSetting("MOLTBOOK_AUTONOMOUS_MODE", false),
  };
}

/**
 * Minimum and maximum bounds for autonomy interval
 */
const AUTONOMY_INTERVAL_BOUNDS = {
  min: 5000, // 5 seconds minimum to prevent API abuse
  max: 3600000, // 1 hour maximum
} as const;

/**
 * Check if a string is a valid URL
 */
function isValidUrl(urlString: string | undefined): boolean {
  if (!urlString) return false;
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate that required settings are present and valid
 */
export function validateMoltbookSettings(settings: MoltbookSettings): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Moltbook token is required for most functionality
  if (!settings.moltbookToken) {
    warnings.push(
      "MOLTBOOK_TOKEN not set - posting and commenting will be disabled",
    );
  }

  // For autonomous mode, LLM API key is required
  if (settings.autonomousMode && !settings.llmApiKey) {
    errors.push("LLM_API_KEY is required for autonomous mode");
  }

  // Validate autonomy interval bounds
  if (settings.autonomyIntervalMs !== undefined) {
    if (settings.autonomyIntervalMs < AUTONOMY_INTERVAL_BOUNDS.min) {
      errors.push(
        `MOLTBOOK_AUTONOMY_INTERVAL_MS (${settings.autonomyIntervalMs}ms) is below minimum (${AUTONOMY_INTERVAL_BOUNDS.min}ms)`,
      );
    }
    if (settings.autonomyIntervalMs > AUTONOMY_INTERVAL_BOUNDS.max) {
      errors.push(
        `MOLTBOOK_AUTONOMY_INTERVAL_MS (${settings.autonomyIntervalMs}ms) exceeds maximum (${AUTONOMY_INTERVAL_BOUNDS.max}ms)`,
      );
    }
  }

  // Validate LLM base URL format
  if (settings.llmBaseUrl && !isValidUrl(settings.llmBaseUrl)) {
    errors.push(
      `LLM_BASE_URL "${settings.llmBaseUrl}" is not a valid HTTP/HTTPS URL`,
    );
  }

  // Validate model string is not empty
  if (settings.autonomousMode && !settings.model?.trim()) {
    errors.push("MODEL is required for autonomous mode");
  }

  // Validate autonomyMaxSteps is non-negative
  if (
    settings.autonomyMaxSteps !== undefined &&
    settings.autonomyMaxSteps < 0
  ) {
    errors.push(
      `MOLTBOOK_AUTONOMY_MAX_STEPS (${settings.autonomyMaxSteps}) cannot be negative`,
    );
  }

  // Validate agent name is not empty
  if (!settings.agentName?.trim()) {
    errors.push("Agent name cannot be empty");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
