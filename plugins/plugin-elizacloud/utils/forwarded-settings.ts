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
  "NANO_MODEL",
  "MEDIUM_MODEL",
  "SMALL_MODEL",
  "LARGE_MODEL",
  "MEGA_MODEL",
  "RESPONSE_HANDLER_MODEL",
  "ACTION_PLANNER_MODEL",
  "SHOULD_RESPOND_MODEL",
  "PLANNER_MODEL",
  "RESPONSE_MODEL",
  "ELIZAOS_CLOUD_SMALL_MODEL",
  "ELIZAOS_CLOUD_NANO_MODEL",
  "ELIZAOS_CLOUD_MEDIUM_MODEL",
  "ELIZAOS_CLOUD_LARGE_MODEL",
  "ELIZAOS_CLOUD_MEGA_MODEL",
  "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
  "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
  "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
  "ELIZAOS_CLOUD_PLANNER_MODEL",
  "ELIZAOS_CLOUD_RESPONSE_MODEL",
] as const;

export function collectEnvVars(runtime: IAgentRuntime): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of FORWARDED_SETTINGS) {
    const val = runtime.getSetting(key);
    if (val) vars[key] = String(val);
  }
  return vars;
}
