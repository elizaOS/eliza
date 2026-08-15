/**
 * Gateway-local DM-policy gate, applied BEFORE the in-worker vs dedicated
 * route choice in gateway-manager (#19912 P1: the Cloud shared event-router
 * gate only runs on the in-worker path, so self-registered agent servers
 * received DMs the policy forbids).
 *
 * This service is standalone (no @elizaos/cloud-shared dependency), so the
 * policy semantics and the metadata subset are mirrored from
 * `packages/cloud/shared/src/lib/services/gateway-discord/dm-policy.ts` and
 * the DiscordConnectionMetadata schema — keep the three in lockstep. The
 * assignment API validates the stored JSONB against the canonical zod schema
 * before it reaches this contract, so absent/malformed rows arrive as null
 * (policy-unknown → historical open behavior).
 */

/** DM-relevant subset of the canonical DiscordConnectionMetadata. */
export interface DiscordConnectionDmMetadata {
  dmPolicy?: "open" | "disabled" | "allowlist" | "pairing" | null;
  ownerDiscordUserId?: string | null;
  ownerDiscordUserIds?: string[] | null;
  dmAllowFrom?: string[] | null;
}

/**
 * Decide whether a direct-message sender passes the connection's DM policy.
 * Mirrors the shared gate exactly: unset/"open" admits everyone, "disabled"
 * admits nobody, "allowlist" admits owners plus dmAllowFrom, "pairing"
 * admits owners only (the gateway has no pairing flow).
 */
export function isDmSenderAllowed(
  metadata: DiscordConnectionDmMetadata,
  authorId: string,
): boolean {
  const dmPolicy = metadata.dmPolicy ?? "open";
  if (dmPolicy === "open") return true;
  if (dmPolicy === "disabled") return false;
  const allowed = new Set<string>(metadata.ownerDiscordUserIds ?? []);
  if (metadata.ownerDiscordUserId) allowed.add(metadata.ownerDiscordUserId);
  if (dmPolicy === "allowlist") {
    for (const id of metadata.dmAllowFrom ?? []) allowed.add(id);
  }
  return allowed.has(authorId);
}
