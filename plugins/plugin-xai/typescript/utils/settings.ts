import type { IAgentRuntime } from "@elizaos/core";

export function getSetting(
  runtime: IAgentRuntime | null | undefined,
  key: string,
  defaultValue?: string
): string | undefined {
  if (runtime && typeof runtime.getSetting === "function") {
    const value = runtime.getSetting(key);
    if (value !== undefined && value !== null) {
      return String(value);
    }
  }

  return process.env[key] ?? defaultValue;
}
