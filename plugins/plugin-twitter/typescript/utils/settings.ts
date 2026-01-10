/**
 * Settings utilities for Twitter plugin
 */

import type { IAgentRuntime } from "@elizaos/core";

/**
 * Get a setting value from the runtime
 */
export function getSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" ? value : undefined;
}

