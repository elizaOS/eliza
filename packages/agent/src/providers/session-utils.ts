/**
 * Session utility functions for the eliza plugin.
 *
 * Session providers are owned by @elizaos/core; this module re-exports the
 * canonical collection and adds the agent-local store-path resolution used to
 * point those providers at this agent's session store.
 */

import * as path from "node:path";
import { getSessionProviders, resolveStateDir } from "@elizaos/core";

export { getSessionProviders };

const DEFAULT_AGENT_ID = "main";

/**
 * Resolve the sessions directory for an agent.
 */
function resolveAgentSessionsDir(agentId?: string): string {
  const id = agentId ?? DEFAULT_AGENT_ID;
  return path.join(resolveStateDir(), "agents", id, "sessions");
}

/**
 * Resolve the default session store path.
 */
export function resolveDefaultSessionStorePath(agentId?: string): string {
  return path.join(resolveAgentSessionsDir(agentId), "sessions.json");
}
