/** Minimal identity consumed by container-free Shared execution. */

import type { AgentExecutionTier } from "../../../db/schemas/agent-sandboxes";

export interface SharedRuntimeAgent {
  id: string;
  organization_id: string;
  user_id: string;
  character_id: string | null;
  agent_name: string | null;
  agent_config: Record<string, unknown> | null;
  execution_tier: AgentExecutionTier;
}
