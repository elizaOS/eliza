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
