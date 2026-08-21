/** Validates the optional public idempotency key used by Shared turn coordinators. */

/**
 * A valid key drives durable claim/replay identity. Invalid or absent input
 * deliberately returns undefined, which loses retry deduplication without
 * granting authority or fabricating a durable identity.
 */
export function sharedTurnClientMessageId(body: unknown): string | undefined {
  // error-policy:J3 untrusted request body — an absent/oversized/non-string key
  // yields an explicit undefined, never a fabricated identity.
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as { clientMessageId?: unknown }).clientMessageId;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  return trimmed;
}
