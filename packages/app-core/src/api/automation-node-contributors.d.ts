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
export declare function registerAutomationNodeContributor(
  id: string,
  contributor: AutomationNodeContributor,
): void;
export declare function listAutomationNodeContributors(): AutomationNodeContributor[];
export declare function clearAutomationNodeContributorsForTests(): void;
//# sourceMappingURL=automation-node-contributors.d.ts.map
