/**
 * Minimal agent identity consumed by the container-free shared runtime.
 *
 * Database-backed shared agents and the account-native personal Eliza both
 * satisfy this contract. Keeping the runtime on this structural boundary lets
 * the personal service remain rowless without fabricating an AgentSandbox.
 */

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
