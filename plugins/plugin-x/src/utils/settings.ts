import { type IAgentRuntime, resolveSetting } from "@elizaos/core";

/**
 * Safely gets a setting from runtime or environment variables.
 *
 * Thin wrapper over core `resolveSetting` (runtime per-agent setting first, then
 * `process.env`). Kept as a local export so call sites read `getSetting(...)`,
 * but the precedence lives in one canonical place in core.
 *
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
  return defaultValue === undefined
    ? resolveSetting(runtime, key)
    : resolveSetting(runtime, key, { defaultValue });
}
