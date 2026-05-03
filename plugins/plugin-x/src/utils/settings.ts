import type { IAgentRuntime } from "@elizaos/core";

/**
 * Safely gets a setting from runtime or environment variables
 * @param runtime The agent runtime instance
 * @param key The setting key to retrieve
 * @param defaultValue Optional default value if setting is not found
 * @returns The setting value or default
 */
export function getSetting(
  runtime: IAgentRuntime | null | undefined,
  key: string,
  defaultValue?: string,
): string | undefined {
  // Try runtime.getSetting if it exists
  if (runtime && typeof runtime.getSetting === "function") {
    const value = runtime.getSetting(key);
    if (value !== undefined && value !== null) {
      return String(value);
    }
  }

  // Fall back to process.env
  return process.env[key] ?? defaultValue;
}
