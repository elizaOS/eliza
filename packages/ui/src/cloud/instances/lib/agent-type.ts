import type { AgentExecutionTier } from "@elizaos/cloud-shared/lib/types/cloud-api";

export type UserFacingAgentType = "Shared Agent" | "Dedicated Agent";

/**
 * The Cloud product has two user-facing agent types. Execution tiers remain
 * authoritative internally, but infrastructure variants are never product
 * labels.
 */
export function getUserFacingAgentType(
  executionTier: AgentExecutionTier,
): UserFacingAgentType {
  return executionTier === "shared" ? "Shared Agent" : "Dedicated Agent";
}
