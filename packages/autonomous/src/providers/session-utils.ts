/**
 * Session utility functions for milady plugin.
 *
 * These are simplified versions for use until @elizaos/core exports them.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { Provider } from "@elizaos/core";

const DEFAULT_AGENT_ID = "main";

/**
 * Resolve the sessions directory for an agent.
 */
function resolveAgentSessionsDir(agentId?: string): string {
  const id = agentId ?? DEFAULT_AGENT_ID;
  const stateDir =
    process.env.MILADY_STATE_DIR ?? path.join(os.homedir(), ".milady");
  return path.join(stateDir, "agents", id, "sessions");
}

/**
 * Resolve the default session store path.
 */
export function resolveDefaultSessionStorePath(agentId?: string): string {
  return path.join(resolveAgentSessionsDir(agentId), "sessions.json");
}

/**
 * Get session providers.
 *
 * Returns an empty array for now - session providers will be added
 * when @elizaos/core exports them.
 */
export function getSessionProviders(_options?: {
  storePath?: string;
}): Provider[] {
  // Session providers are not yet available in npm @elizaos/core.
  // Return empty array to allow startup without session tracking.
  return [];
}
