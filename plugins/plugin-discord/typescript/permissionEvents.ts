import type { IAgentRuntime } from "@elizaos/core";
import type { AuditLogEvent, Guild, GuildMember, PermissionOverwrites, Role } from "discord.js";
import type { AuditInfo, PermissionDiff, PermissionState } from "./types";

/**
 * Permissions that indicate moderation/admin capabilities.
 * Changes to these permissions are considered elevated and worth tracking.
 */
export const ELEVATED_PERMISSIONS = [
  "Administrator",
  "ManageGuild",
  "ManageChannels",
  "ManageRoles",
  "KickMembers",
  "BanMembers",
  "ModerateMembers",
  "ManageMessages",
  "ManageWebhooks",
  "ManageNicknames",
  "MuteMembers",
  "DeafenMembers",
  "MoveMembers",
  "ManageEvents",
  "ManageThreads",
] as const;

/**
 * Check if a role has any elevated (moderation/admin) permissions
 */
export function isElevatedRole(role: Role): boolean {
  return ELEVATED_PERMISSIONS.some((p) => role.permissions.has(p));
}

/**
 * Check if an array of permission names contains any elevated permissions
 */
export function hasElevatedPermissions(permissions: string[]): boolean {
  return permissions.some((p) =>
    ELEVATED_PERMISSIONS.includes(p as (typeof ELEVATED_PERMISSIONS)[number])
  );
}

/**
 * Fetch the most recent matching audit log entry for an action.
 * Matches by target ID and filters to entries within 10 seconds.
 * Returns null gracefully on errors (rate limits, missing permissions, etc.)
 */
export async function fetchAuditEntry(
  guild: Guild,
  actionType: AuditLogEvent,
  target: string,
  runtime: IAgentRuntime
): Promise<AuditInfo | null> {
  try {
    const logs = await guild.fetchAuditLogs({ type: actionType, limit: 5 });
    const now = Date.now();

    for (const entry of logs.entries.values()) {
      // Match by target and ensure entry is recent (within 10 seconds)
      // Type guard: entry.target can be various types, not all have 'id'
      const targetId = entry.target && "id" in entry.target ? entry.target.id : undefined;
      if (targetId === target && now - entry.createdTimestamp < 10000) {
        return {
          executorId: entry.executor?.id ?? "unknown",
          executorTag: entry.executor?.tag ?? "Unknown",
          reason: entry.reason,
        };
      }
    }
  } catch (err) {
    // Graceful degradation - rate limits, missing permissions, etc.
    runtime.logger.debug(`Audit log fetch failed (non-critical): ${err}`);
  }
  return null;
}

/**
 * Get the permission state from allow/deny arrays
 */
function getState(perm: string, allow: string[], deny: string[]): PermissionState {
  if (allow.includes(perm)) {
    return "ALLOW";
  }
  if (deny.includes(perm)) {
    return "DENY";
  }
  return "NEUTRAL";
}

/**
 * Convert an overwrite to a list of changes (used for CREATE/DELETE)
 * For CREATE: from NEUTRAL to the actual state (ALLOW/DENY)
 * For DELETE: from the actual state (ALLOW/DENY) to NEUTRAL
 */
function overwriteToChanges(ow: PermissionOverwrites, isDelete: boolean = false): PermissionDiff[] {
  const changes: PermissionDiff[] = [];
  for (const p of ow.allow.toArray()) {
    changes.push({
      permission: p,
      oldState: isDelete ? "ALLOW" : "NEUTRAL",
      newState: isDelete ? "NEUTRAL" : "ALLOW",
    });
  }
  for (const p of ow.deny.toArray()) {
    changes.push({
      permission: p,
      oldState: isDelete ? "DENY" : "NEUTRAL",
      newState: isDelete ? "NEUTRAL" : "DENY",
    });
  }
  return changes;
}

/**
 * Diff two permission overwrites and determine what changed.
 * Returns the list of changes and the action type (CREATE/UPDATE/DELETE).
 */
export function diffOverwrites(
  oldOw: PermissionOverwrites | undefined | null,
  newOw: PermissionOverwrites | undefined | null
): { changes: PermissionDiff[]; action: "CREATE" | "UPDATE" | "DELETE" } {
  // Both null - no change
  if (!oldOw && !newOw) {
    return { changes: [], action: "UPDATE" };
  }

  // Created new overwrite
  if (!oldOw && newOw) {
    return { changes: overwriteToChanges(newOw, false), action: "CREATE" };
  }

  // Deleted overwrite
  if (oldOw && !newOw) {
    return { changes: overwriteToChanges(oldOw, true), action: "DELETE" };
  }

  // Updated overwrite - compare old and new
  const changes: PermissionDiff[] = [];
  const oldAllow = oldOw?.allow.toArray();
  const oldDeny = oldOw?.deny.toArray();
  const newAllow = newOw?.allow.toArray();
  const newDeny = newOw?.deny.toArray();

  // Get all permissions that exist in either old or new
  const allPerms = new Set([...oldAllow, ...oldDeny, ...newAllow, ...newDeny]);

  for (const perm of allPerms) {
    const oldState = getState(perm, oldAllow, oldDeny);
    const newState = getState(perm, newAllow, newDeny);
    if (oldState !== newState) {
      changes.push({ permission: perm, oldState, newState });
    }
  }

  return { changes, action: "UPDATE" };
}

/**
 * Diff two role permission sets and return what changed.
 */
export function diffRolePermissions(oldRole: Role, newRole: Role): PermissionDiff[] {
  const oldPerms = oldRole.permissions.toArray();
  const newPerms = newRole.permissions.toArray();
  const changes: PermissionDiff[] = [];

  // Find added permissions
  for (const p of newPerms) {
    if (!oldPerms.includes(p)) {
      changes.push({ permission: p, oldState: "NEUTRAL", newState: "ALLOW" });
    }
  }

  // Find removed permissions
  for (const p of oldPerms) {
    if (!newPerms.includes(p)) {
      changes.push({ permission: p, oldState: "ALLOW", newState: "NEUTRAL" });
    }
  }

  return changes;
}

/**
 * Diff member roles to find added and removed roles.
 */
export function diffMemberRoles(
  oldMember: GuildMember,
  newMember: GuildMember
): { added: Role[]; removed: Role[] } {
  const oldRoles = oldMember.roles.cache;
  const newRoles = newMember.roles.cache;

  return {
    added: [...newRoles.filter((r) => !oldRoles.has(r.id)).values()],
    removed: [...oldRoles.filter((r) => !newRoles.has(r.id)).values()],
  };
}
