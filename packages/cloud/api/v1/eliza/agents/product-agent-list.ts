/**
 * Projects organization agent rows into the canonical Shared/Dedicated product
 * list. A Dedicated row supersedes its Shared source only after the server-owned
 * cutover receipt exists; target creation or readiness alone is not authority.
 */

import { readPersonalElizaCutover } from "@/lib/services/eliza-agent-config";

type ProductAgentRow = {
  id: string;
  execution_tier: string;
  agent_config: unknown;
};

export function projectProductAgentList<T extends ProductAgentRow>(
  agents: readonly T[],
): T[] {
  const supersededSharedIds = new Set<string>();
  for (const agent of agents) {
    if (agent.execution_tier === "shared") continue;
    const cutover = readPersonalElizaCutover(
      agent.agent_config as Record<string, unknown> | null,
    );
    if (cutover) supersededSharedIds.add(cutover.sourceAgentId);
  }
  return agents.filter(
    (agent) =>
      agent.execution_tier !== "shared" || !supersededSharedIds.has(agent.id),
  );
}
