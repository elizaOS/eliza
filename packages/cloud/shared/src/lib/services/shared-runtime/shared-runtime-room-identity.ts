import crypto from "node:crypto";

/**
 * Normalizes caller-selected Shared conversation labels before coordinator,
 * history, and runtime storage identities are derived from them.
 */

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

/** One room-label precedence shared by Durable Object and runtime identities. */
export function normalizeSharedRuntimeRoom(roomId?: unknown, userId?: unknown): string {
  return nonEmptyString(roomId) ?? nonEmptyString(userId) ?? "default";
}

export function stableUuid(raw: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    return raw;
  }
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function sharedRuntimeChannelId(agentId: string, roomId: string): string {
  const room = roomId.trim() || "default";
  return stableUuid(`cloud-bridge-channel:${agentId}:${room}`);
}

/** Storage-safe runtime room key derived from the coordinator's canonical room label. */
export function sharedRuntimeRoomKey(agentId: string, roomId?: unknown, userId?: unknown): string {
  const room = normalizeSharedRuntimeRoom(roomId, userId);
  return sharedRuntimeChannelId(agentId, room);
}
