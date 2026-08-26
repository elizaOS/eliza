/**
 * Internal runtime roles capability.
 *
 * Provides OWNER / ADMIN / USER / GUEST role hierarchy with:
 * - Auto-assignment of OWNER to the app user (world owner)
 * - Connector admin whitelisting (Discord, Telegram, etc.)
 * - /role command for live role management
 * - Provider that injects role context for action/provider gating
 *
 * Runtime config lives at:
 *   roles.connectorAdmins = {
 *     "discord": ["discordUserId1", "discordUserId2"],
 *     "telegram": ["telegramUserId1"]
 *   }
 */

import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Plugin,
  roleAction,
  setEntityRoleCas,
  type UUID,
} from "@elizaos/core";
import { rolesProvider } from "./provider.ts";
import type { RolesConfig, RolesWorldMetadata } from "./types.ts";
import {
  hasConfiguredCanonicalOwner,
  matchEntityToConnectorAdminWhitelist,
  normalizeRole,
  resolveCanonicalOwnerId,
} from "./utils.ts";

const BOOTSTRAP_RETRY_TIMERS_KEY = Symbol.for(
  "@elizaos/runtime.roles.bootstrapRetries",
);
const BOOTSTRAP_RETRY_LIMIT = 3;
const CONNECTOR_ADMINS_SETTING_KEY = "ELIZA_ROLES_CONNECTOR_ADMINS_JSON";

type RuntimeWithBootstrapRetries = IAgentRuntime & {
  [BOOTSTRAP_RETRY_TIMERS_KEY]?: Map<string, ReturnType<typeof setTimeout>>;
};

export { rolesProvider } from "./provider.ts";
export type {
  ConnectorAdminWhitelist,
  RoleCheckResult,
  RoleGrantSource,
  RoleName,
  RolesConfig,
  RolesWorldMetadata,
} from "./types.ts";
export { ROLE_RANK } from "./types.ts";
export {
  canModifyRole,
  checkSenderPrivateAccess,
  checkSenderRole,
  getConfiguredOwnerEntityIds,
  getConnectorAdminWhitelist,
  getEntityRole,
  hasConfiguredCanonicalOwner,
  matchEntityToConnectorAdminWhitelist,
  normalizeRole,
  resolveCanonicalOwnerId,
  resolveCanonicalOwnerIdForMessage,
  resolveEntityRole,
  resolveWorldForMessage,
  setConnectorAdminWhitelist,
  setEntityRole,
} from "./utils.ts";
export { roleAction };

function systemRoleMessage(actorEntityId: string, roomId: UUID): Memory {
  return {
    entityId: actorEntityId as UUID,
    roomId,
    content: {
      text: "runtime role authority synchronization",
      source: "roles",
    },
  } as Memory;
}

async function requireCommittedRoleWrite(
  result: Awaited<ReturnType<typeof setEntityRoleCas>>,
  label: string,
): Promise<void> {
  if (result.status !== "committed") {
    throw new Error(`${label} did not commit: ${result.status}`);
  }
}

function getBootstrapRetryTimers(
  runtime: IAgentRuntime,
): Map<string, ReturnType<typeof setTimeout>> {
  const runtimeWithBootstrapRetries = runtime as RuntimeWithBootstrapRetries;
  runtimeWithBootstrapRetries[BOOTSTRAP_RETRY_TIMERS_KEY] ??= new Map();
  return runtimeWithBootstrapRetries[BOOTSTRAP_RETRY_TIMERS_KEY];
}

function scheduleBootstrapRetry(
  runtime: IAgentRuntime,
  label: string,
  task: () => Promise<boolean>,
  attempt = 1,
): void {
  const timers = getBootstrapRetryTimers(runtime);
  const existingTimer = timers.get(label);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const delayMs = Math.min(1500 * attempt, 5000);
  const timer = setTimeout(() => {
    timers.delete(label);
    void task().then((ok) => {
      if (ok) {
        return;
      }

      if (attempt >= BOOTSTRAP_RETRY_LIMIT) {
        logger.warn(
          `[roles] ${label} retries exhausted because runtime state is still unavailable`,
        );
        return;
      }

      logger.info(
        `[roles] ${label} retry ${attempt} skipped because runtime state is still unavailable`,
      );
      scheduleBootstrapRetry(runtime, label, task, attempt + 1);
    });
  }, delayMs);
  timers.set(label, timer);
}

function isExpectedRuntimeStateBootstrapError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /Failed query:\s*select\b.*\bfrom "worlds"/i.test(message) ||
    /relation .*worlds.*does not exist/i.test(message) ||
    /no such table:?\s*worlds/i.test(message)
  );
}

function logRuntimeStateBootstrapDeferral(label: string, err: unknown): void {
  if (isExpectedRuntimeStateBootstrapError(err)) {
    logger.info(
      `[roles] Deferring ${label} bootstrap until runtime worlds are available`,
    );
    return;
  }

  logger.info(
    `[roles] Deferring ${label} bootstrap until runtime worlds are available: ${String(err)}`,
  );
}

/**
 * Ensure the world owner has OWNER role in metadata.
 * Called on plugin init — guarantees the app-local user is always OWNER.
 */
async function ensureOwnerRole(
  runtime: IAgentRuntime,
  opts?: { pruneConnectorAdmins?: boolean },
): Promise<boolean> {
  try {
    const worlds = await runtime.getAllWorlds();

    for (const world of worlds) {
      if (!world.id) continue;
      const metadata = (world.metadata ?? {}) as RolesWorldMetadata;
      const ownerId = resolveCanonicalOwnerId(runtime, metadata);
      if (!ownerId) continue;
      const room = (await runtime.getRooms(world.id))[0];
      if (!room)
        throw new Error(`World ${world.id} has no room for role audit scope`);
      const message = systemRoleMessage(ownerId, room.id);
      const roles = metadata.roles ?? {};
      const roleSources = metadata.roleSources ?? {};
      if (
        metadata.ownership?.ownerId !== ownerId ||
        normalizeRole(roles[ownerId]) !== "OWNER" ||
        roleSources[ownerId] !== "owner"
      ) {
        await requireCommittedRoleWrite(
          await setEntityRoleCas(runtime, message, ownerId, "OWNER", {
            source: "owner",
            worldId: world.id,
            mutateMetadata: (replacement) => {
              replacement.ownership = {
                ...(replacement.ownership ?? {}),
                ownerId,
              };
            },
          }),
          "canonical OWNER synchronization",
        );
      }
      if (hasConfiguredCanonicalOwner(runtime)) {
        for (const [entityId, role] of Object.entries(roles)) {
          if (entityId === ownerId || normalizeRole(role) !== "OWNER") continue;
          await requireCommittedRoleWrite(
            await setEntityRoleCas(runtime, message, entityId, "GUEST", {
              source: "owner",
              worldId: world.id,
              mutateMetadata: (replacement) => {
                delete replacement.roles?.[entityId];
                delete replacement.roleSources?.[entityId];
              },
            }),
            `stale OWNER revocation for ${entityId}`,
          );
        }
      }
      if (opts?.pruneConnectorAdmins) {
        for (const [entityId, source] of Object.entries(roleSources)) {
          if (source !== "connector_admin") continue;
          await requireCommittedRoleWrite(
            await setEntityRoleCas(runtime, message, entityId, "GUEST", {
              source: "connector_admin",
              worldId: world.id,
              mutateMetadata: (replacement) => {
                delete replacement.roles?.[entityId];
                delete replacement.roleSources?.[entityId];
              },
            }),
            `connector-admin revocation for ${entityId}`,
          );
        }
      }
      logger.info(
        `[roles] Synced canonical OWNER ${ownerId} in world ${world.id}`,
      );
    }
    return true;
  } catch (err) {
    logRuntimeStateBootstrapDeferral("owner role", err);
    return false;
  }
}

/**
 * Apply connector admin whitelists from config.
 * Scans worlds for entities matching whitelisted IDs, promotes them to ADMIN,
 * and removes stale connector_admin grants that no longer match.
 */
async function applyConnectorAdminWhitelists(
  runtime: IAgentRuntime,
  whitelist: Record<string, string[]>,
): Promise<boolean> {
  try {
    const worlds = await runtime.getAllWorlds();

    for (const world of worlds) {
      if (!world.id) continue;

      const rooms = await runtime.getRooms(world.id);

      const metadata = (world.metadata ?? {}) as RolesWorldMetadata;
      const ownerId = resolveCanonicalOwnerId(runtime, metadata);
      if (!ownerId) {
        throw new Error(
          `World ${world.id} has no canonical owner for connector role audit authority`,
        );
      }
      const auditRoom = rooms[0];
      if (!auditRoom)
        throw new Error(`World ${world.id} has no room for role audit scope`);
      const message = systemRoleMessage(ownerId, auditRoom.id);
      const matchedEntityIds = new Set<string>();

      for (const room of rooms) {
        const entities = await runtime.getEntitiesForRoom(room.id);
        for (const entity of entities) {
          if (!entity.id) continue;
          const matched = matchEntityToConnectorAdminWhitelist(
            (entity.metadata as Record<string, unknown> | undefined) ??
              undefined,
            whitelist,
          );
          if (!matched) continue;
          matchedEntityIds.add(entity.id);
          if (
            metadata.roleSources?.[entity.id] === "connector_admin" &&
            normalizeRole(metadata.roles?.[entity.id]) === "ADMIN"
          )
            continue;
          await requireCommittedRoleWrite(
            await setEntityRoleCas(runtime, message, entity.id, "ADMIN", {
              source: "connector_admin",
              worldId: world.id,
            }),
            `connector-admin promotion for ${entity.id}`,
          );
        }
      }

      for (const [entityId, source] of Object.entries(
        metadata.roleSources ?? {},
      )) {
        if (source !== "connector_admin" || matchedEntityIds.has(entityId))
          continue;
        await requireCommittedRoleWrite(
          await setEntityRoleCas(runtime, message, entityId, "GUEST", {
            source: "connector_admin",
            worldId: world.id,
            mutateMetadata: (replacement) => {
              delete replacement.roles?.[entityId];
              delete replacement.roleSources?.[entityId];
            },
          }),
          `stale connector-admin revocation for ${entityId}`,
        );
      }
    }
    return true;
  } catch (err) {
    logRuntimeStateBootstrapDeferral("connector admin", err);
    return false;
  }
}

function loadConnectorAdminsConfig(
  pluginConfig: Record<string, unknown> | undefined,
  runtime: IAgentRuntime,
): RolesConfig {
  const directConfig = pluginConfig as RolesConfig | undefined;
  if (directConfig?.connectorAdmins) {
    return directConfig;
  }

  const raw =
    typeof runtime.getSetting === "function"
      ? runtime.getSetting(CONNECTOR_ADMINS_SETTING_KEY)
      : undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { connectorAdmins: parsed as RolesConfig["connectorAdmins"] };
  } catch (error) {
    logger.warn(
      `[roles] Failed to parse ${CONNECTOR_ADMINS_SETTING_KEY}: ${String(error)}`,
    );
    return {};
  }
}

const rolesPlugin: Plugin = {
  name: "roles",
  description:
    "Role-based access control — OWNER/ADMIN/USER/GUEST hierarchy with " +
    "connector whitelisting and /role command.",

  providers: [rolesProvider],
  actions: [roleAction],

  async init(pluginConfig: Record<string, unknown>, runtime: IAgentRuntime) {
    logger.info("[roles] Initializing roles");
    const config = loadConnectorAdminsConfig(pluginConfig, runtime);
    const connectorAdmins = config.connectorAdmins ?? {};
    const hasConnectorAdmins = Object.values(connectorAdmins).some(
      (ids) => ids.length > 0,
    );

    // Step 1: Ensure world owners have OWNER role
    const ownerBootstrapOk = await ensureOwnerRole(runtime, {
      pruneConnectorAdmins: !hasConnectorAdmins,
    });
    if (!ownerBootstrapOk) {
      scheduleBootstrapRetry(runtime, "Owner role bootstrap", () =>
        ensureOwnerRole(runtime, {
          pruneConnectorAdmins: !hasConnectorAdmins,
        }),
      );
    }

    // Step 2: Apply connector admin whitelists if configured
    if (hasConnectorAdmins) {
      const adminBootstrapOk = await applyConnectorAdminWhitelists(
        runtime,
        connectorAdmins,
      );
      if (!adminBootstrapOk) {
        scheduleBootstrapRetry(runtime, "Connector admin bootstrap", () =>
          applyConnectorAdminWhitelists(runtime, connectorAdmins),
        );
      }
    }

    // Step 3: Re-fire the bootstrap on every world-creation event. init()
    // runs before any connector (Discord/Telegram/etc.) has populated
    // runtime.worlds, so ensureOwnerRole sees an empty set and the scheduled
    // retry tail fires three times within ~10s — usually still before the
    // connector worlds land. Without this hook the owner role never lands in
    // world metadata, resolveStage1SenderRole forever returns USER, and
    // every ADMIN-gated context (tasks/code/automation/connectors) stays
    // hidden from the Stage 1 planner. Hooking WORLD_JOINED + WORLD_CONNECTED
    // makes the bootstrap converge as soon as the first connector world
    // appears, regardless of the initial retry-window timing.
    const rerunOwnerBootstrap = async (label: string): Promise<void> => {
      const ok = await ensureOwnerRole(runtime, {
        pruneConnectorAdmins: !hasConnectorAdmins,
      });
      if (ok) {
        logger.info(`[roles] Owner role re-applied after ${label}`);
      }
      if (hasConnectorAdmins) {
        await applyConnectorAdminWhitelists(runtime, connectorAdmins);
      }
    };
    runtime.registerEvent("WORLD_JOINED", async () => {
      await rerunOwnerBootstrap("WORLD_JOINED");
    });
    runtime.registerEvent("WORLD_CONNECTED", async () => {
      await rerunOwnerBootstrap("WORLD_CONNECTED");
    });

    logger.info("[roles] Roles initialized");
  },
};

export default rolesPlugin;
