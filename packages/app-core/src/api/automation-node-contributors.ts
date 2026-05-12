import type { loadElizaConfig } from "@elizaos/agent";
import type { AgentRuntime, UUID } from "@elizaos/core";
import type { AutomationNodeDescriptor } from "@elizaos/ui";

export interface AutomationNodeContributorContext {
  runtime: AgentRuntime;
  config: ReturnType<typeof loadElizaConfig>;
  agentName: string;
  adminEntityId: UUID;
}

export type AutomationNodeContributor = (
  context: AutomationNodeContributorContext,
) => Promise<AutomationNodeDescriptor[]> | AutomationNodeDescriptor[];

const contributors = new Map<string, AutomationNodeContributor>();

export function registerAutomationNodeContributor(
  id: string,
  contributor: AutomationNodeContributor,
): void {
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new Error("Automation node contributor id is required");
  }
  contributors.set(normalizedId, contributor);
}

export function listAutomationNodeContributors(): AutomationNodeContributor[] {
  return [...contributors.values()];
}

export function clearAutomationNodeContributorsForTests(): void {
  contributors.clear();
}
