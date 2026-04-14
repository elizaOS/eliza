/**
 * Late-join whitelist evaluator.
 *
 * Problem: the roles bootstrap only runs at startup.
 * Entities that join AFTER init are never auto-promoted.
 *
 * Solution: This evaluator runs on each message. If the sender has no role
 * (NONE) and matches the connector admin whitelist from config, it promotes
 * them to ADMIN.
 *
 * Lightweight by design: skips early if the sender already has a role, and
 * only reads config + entity metadata when promotion is possible.
 */

import {
  type Evaluator,
  getConnectorAdminWhitelist,
  type IAgentRuntime,
  logger,
  type Memory,
  matchEntityToConnectorAdminWhitelist,
  resolveWorldForMessage,
  type State,
  setEntityRole,
  type UUID,
} from "@elizaos/core";
import { loadElizaConfig } from "../config/config.js";

/**
 * Load the connectorAdmins whitelist from eliza.json.
 * Returns an empty object if not configured.
 */
function hasWhitelistEntries(whitelist: Record<string, string[]>): boolean {
  return Object.values(whitelist).some((ids) => ids.length > 0);
}

function loadConnectorAdminWhitelist(
  runtime: IAgentRuntime,
): Record<string, string[]> {
  // Prefer the runtime copy populated during roles init so env/runtime settings
  // and config-file deployments behave the same way for late joiners.
  const runtimeWhitelist = getConnectorAdminWhitelist(runtime);
  if (hasWhitelistEntries(runtimeWhitelist)) {
    return runtimeWhitelist;
  }

  try {
    const cfg = loadElizaConfig();
    return cfg.roles?.connectorAdmins ?? {};
  } catch {
    return {};
  }
}

export const lateJoinWhitelistEvaluator: Evaluator = {
  name: "late_join_whitelist",
  description:
    "Auto-promotes entities matching connector admin whitelist on first message",
  alwaysRun: true,
  examples: [],

  /**
   * Only run when the sender has no role (NONE) in the current world.
   * Entities that already have ADMIN or OWNER are skipped immediately.
   */
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const resolved = await resolveWorldForMessage(runtime, message);
    if (!resolved) return false;

    return typeof resolved.metadata.roles?.[message.entityId] !== "string";
  },

  handler: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    const whitelist = loadConnectorAdminWhitelist(runtime);
    if (!hasWhitelistEntries(whitelist)) return undefined;

    const entity = await runtime.getEntityById(message.entityId as UUID);
    if (!entity) return undefined;

    const matched = matchEntityToConnectorAdminWhitelist(
      entity.metadata as Record<string, unknown> | undefined,
      whitelist,
    );
    if (!matched) return undefined;

    await setEntityRole(
      runtime,
      message,
      message.entityId as string,
      "ADMIN",
      "connector_admin",
    );
    logger.info(
      `[roles] Late-join: promoted entity ${message.entityId} to ADMIN (whitelist match)`,
    );
    return undefined;
  },
};
