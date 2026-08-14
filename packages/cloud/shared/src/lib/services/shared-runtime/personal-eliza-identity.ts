/**
 * Resolves the account-native personal Eliza into its current execution mode.
 * The control plane uses this read independently of chat history so account,
 * billing, and recovery UI stays available while the Shared runtime is down.
 */

import { findActivePersonalDedicatedTarget } from "../agent-tier-upgrade-target";
import { personalDedicatedAgentApiBase } from "./personal-shared-agent";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";

export type PersonalElizaIdentityDto =
  | {
      id: string;
      displayName: string;
      runtime: "shared";
    }
  | {
      id: string;
      displayName: string;
      runtime: "dedicated";
      activeAgentId: string;
      apiBase: string;
    };

export async function resolvePersonalElizaIdentity(
  agent: SharedRuntimeAgent,
  baseDomain?: string,
): Promise<PersonalElizaIdentityDto> {
  const dedicated = await findActivePersonalDedicatedTarget(agent.organization_id, agent.id);
  const apiBase = dedicated ? personalDedicatedAgentApiBase(dedicated, baseDomain) : null;
  if (dedicated && apiBase) {
    return {
      id: agent.id,
      displayName: dedicated.agent_name ?? agent.agent_name ?? "Eliza",
      runtime: "dedicated",
      activeAgentId: dedicated.id,
      apiBase,
    };
  }
  return {
    id: agent.id,
    displayName: agent.agent_name ?? "Eliza",
    runtime: "shared",
  };
}
