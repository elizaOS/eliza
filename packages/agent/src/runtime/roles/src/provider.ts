/**
 * Roles provider — injects the current speaker's role and the server role
 * hierarchy into the agent's context so actions/providers can be gated.
 */

import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
  type UUID,
} from "@elizaos/core";
import { hasAdminAccess } from "../../../security/access.js";
import type { RoleName, RolesWorldMetadata } from "./types.js";
import {
  getEntityRole,
  getLiveEntityMetadataFromMessage,
  hasConfiguredCanonicalOwner,
  normalizeRole,
  resolveCanonicalOwnerId,
  resolveEntityRole,
} from "./utils.js";

export const rolesProvider: Provider = {
  name: "roles",
  description:
    "Provides the current speaker's role and the server role hierarchy. " +
    "Use this to gate actions and decide what a user is allowed to do.",
  dynamic: true,
  position: 10,
  contexts: ["admin", "settings"],
  contextGate: { anyOf: ["admin", "settings"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "ADMIN" },

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    const room = await runtime.getRoom(message.roomId);
    if (!room) {
      return empty();
    }

    if (!room.worldId) {
      return empty();
    }

    const world = await runtime.getWorld(room.worldId);
    if (!world) {
      return empty();
    }

    const metadata = (world.metadata ?? {}) as RolesWorldMetadata;
    const speakerRole = await resolveEntityRole(
      runtime,
      world,
      metadata,
      message.entityId,
      {
        liveEntityMetadata: getLiveEntityMetadataFromMessage(message),
      },
    );
    const storedSpeakerRole = getEntityRole(metadata, message.entityId);
    const roles = { ...(metadata.roles ?? {}) };
    const canonicalOwnerId = resolveCanonicalOwnerId(runtime, metadata);
    const canSeeRoleRoster = await hasAdminAccess(runtime, message);

    if (hasConfiguredCanonicalOwner(runtime) && canonicalOwnerId) {
      for (const [entityId, role] of Object.entries(roles)) {
        if (entityId !== canonicalOwnerId && normalizeRole(role) === "OWNER") {
          delete roles[entityId];
        }
      }
      roles[canonicalOwnerId] = "OWNER";
    }

    if (speakerRole !== storedSpeakerRole) {
      if (speakerRole === "GUEST") {
        delete roles[message.entityId];
      } else {
        roles[message.entityId] = speakerRole;
      }
    }

    // Build a compact role summary for the agent context.
    const owners: string[] = [];
    const admins: string[] = [];
    const users: string[] = [];

    for (const [entityId, role] of Object.entries(roles)) {
      const normalized = normalizeRole(role);
      if (normalized === "OWNER") owners.push(entityId);
      else if (normalized === "ADMIN") admins.push(entityId);
      else if (normalized === "USER") users.push(entityId);
      // GUEST entities are not listed — they're the default
    }

    // Resolve display names where possible (best-effort, no hard failures).
    const resolveNames = async (ids: string[]): Promise<string[]> => {
      const results: string[] = [];
      for (const id of ids) {
        try {
          const entity = await runtime.getEntityById(id as UUID);
          const name =
            entity?.names?.[0] ??
            (
              entity?.metadata as
                | Record<string, Record<string, string>>
                | undefined
            )?.default?.name ??
            id.slice(0, 8);
          results.push(name);
        } catch {
          results.push(id.slice(0, 8));
        }
      }
      return results;
    };

    const ownerNames = canSeeRoleRoster ? await resolveNames(owners) : [];
    const adminNames = canSeeRoleRoster ? await resolveNames(admins) : [];
    const userNames = canSeeRoleRoster ? await resolveNames(users) : [];

    let text = `## Roles\n`;
    text += `Current speaker role: **${speakerRole}**\n`;
    if (canSeeRoleRoster && ownerNames.length > 0) {
      text += `Owners: ${ownerNames.join(", ")}\n`;
    }
    if (canSeeRoleRoster && adminNames.length > 0) {
      text += `Admins: ${adminNames.join(", ")}\n`;
    }
    if (canSeeRoleRoster && userNames.length > 0) {
      text += `Users: ${userNames.join(", ")}\n`;
    }

    const canManage = speakerRole === "OWNER" || speakerRole === "ADMIN";

    logger.debug(
      `[roles] Speaker ${message.entityId} role=${speakerRole} canManage=${canManage}`,
    );

    return {
      text,
      values: {
        speakerRole,
        canManageRoles: canManage,
        ownerCount: canSeeRoleRoster ? owners.length : 0,
        adminCount: canSeeRoleRoster ? admins.length : 0,
        userCount: canSeeRoleRoster ? users.length : 0,
      },
      data: {
        speakerRole,
        canManageRoles: canManage,
        owners: canSeeRoleRoster ? owners : [],
        admins: canSeeRoleRoster ? admins : [],
        users: canSeeRoleRoster ? users : [],
        roles: canSeeRoleRoster ? roles : {},
      },
    };
  },
};

function empty(): ProviderResult {
  return {
    text: "",
    values: {
      speakerRole: "GUEST" as RoleName,
      canManageRoles: false,
    },
    data: {
      speakerRole: "GUEST" as RoleName,
      canManageRoles: false,
      owners: [],
      admins: [],
      users: [],
      roles: {},
    },
  };
}
