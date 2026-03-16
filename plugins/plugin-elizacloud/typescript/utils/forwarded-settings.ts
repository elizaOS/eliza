/**
 * Runtime settings keys forwarded into cloud containers as environment
 * variables. Used by both PROVISION_CLOUD_AGENT and RESUME_CLOUD_AGENT.
 */

import type { IAgentRuntime } from "@elizaos/core";

export const FORWARDED_SETTINGS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "ELIZAOS_CLOUD_API_KEY",
  "SMALL_MODEL",
  "LARGE_MODEL",
  "ELIZAOS_CLOUD_SMALL_MODEL",
  "ELIZAOS_CLOUD_LARGE_MODEL",
] as const;

export function collectEnvVars(runtime: IAgentRuntime): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of FORWARDED_SETTINGS) {
    const val = runtime.getSetting(key);
    if (val) vars[key] = String(val);
  }
  return vars;
}
