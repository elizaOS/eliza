/**
 * World creation role backfill provider.
 *
 * Problem: When a new connector creates a new world after roles bootstrap,
 * the owner's role is not set in that world because `ensureOwnerRole()` only
 * runs at boot.
 *
 * Solution: On every message, if the current world has an ownerId but no
 * OWNER role entry, backfill it. This is idempotent -- running it multiple
 * times on the same world is a no-op after the first backfill.
 *
 * Runs as a lightweight provider with a high position number (early/low
 * priority) so it does not add latency to prompt construction. Produces no
 * visible text in the agent context.
 */

import {
  hasConfiguredCanonicalOwner,
  type IAgentRuntime,
  logger,
  type Memory,
  normalizeRole,
  type Provider,
  type ProviderResult,
  type RoleGrantSource,
  type RoleName,
  resolveCanonicalOwnerId,
  type State,
} from "@elizaos/core";

type RolesWorldMetadata = {
  ownership?: { ownerId?: string };
  roles?: Record<string, RoleName>;
  roleSources?: Record<string, RoleGrantSource>;
};

export const roleBackfillProvider: Provider = {
  name: "roleBackfill",
  description:
    "Lazily backfills OWNER role for new worlds created after roles bootstrap.",
  descriptionCompressed:
    "lazily backfill OWNER role new world create after role bootstrap",
  dynamic: true,
  // High position number = runs after the main roles provider (position 10).
  position: 11,
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
    const empty: ProviderResult = { text: "", values: {}, data: {} };
    try {
      const room = await runtime.getRoom(message.roomId);
      if (!room?.worldId) return empty;

      const world = await runtime.getWorld(room.worldId);
      if (!world) return empty;

      const metadata = (world.metadata ?? {}) as RolesWorldMetadata;
      const ownerId = resolveCanonicalOwnerId(runtime, metadata);
      if (!ownerId) return empty;

      const roles = metadata.roles ?? {};
      const roleSources = metadata.roleSources ?? {};
      const currentOwnerRole = normalizeRole(roles[ownerId]);
      const needsOwnershipSync = metadata.ownership?.ownerId !== ownerId;
      const needsOwnerSourceSync = roleSources[ownerId] !== "owner";
      const configuredOwner = hasConfiguredCanonicalOwner(runtime);
      const hasStaleOwners = configuredOwner
        ? Object.entries(roles).some(
            ([entityId, role]) =>
              entityId !== ownerId && normalizeRole(role) === "OWNER",
          )
        : false;

      // Already has OWNER role -- no-op
      if (
        currentOwnerRole === "OWNER" &&
        !needsOwnershipSync &&
        !needsOwnerSourceSync &&
        !hasStaleOwners
      ) {
        return empty;
      }

      // Backfill: set OWNER role for the world owner
      metadata.ownership = { ...(metadata.ownership ?? {}), ownerId };
      roles[ownerId] = "OWNER";
      roleSources[ownerId] = "owner";
      if (configuredOwner) {
        for (const [entityId, role] of Object.entries(roles)) {
          if (entityId !== ownerId && normalizeRole(role) === "OWNER") {
            delete roles[entityId];
            delete roleSources[entityId];
          }
        }
      }
      const updatedMetadata = {
        ...metadata,
        roles,
        roleSources,
      };

      await runtime.updateWorld({
        ...world,
        metadata: updatedMetadata,
      } as Parameters<IAgentRuntime["updateWorld"]>[0]);

      logger.info(
        `[roles] Backfill: set OWNER role for entity ${ownerId} in world ${world.id}`,
      );
    } catch (err) {
      logger.warn(`[roles] Role backfill failed: ${String(err)}`);
    }

    return empty;
  },
};
