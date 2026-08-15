/**
 * Pure DM-policy gate for gateway-managed Discord connections. The event
 * router consults it for every direct message before any character lookup or
 * response generation, so a "disabled" or allowlist policy fails closed at
 * the earliest routing step.
 *
 * Mirrors the agent plugin's DISCORD_DM_POLICY semantics: unset or "open"
 * keeps the gateway's historical open-DM behavior; "disabled" admits nobody;
 * "allowlist" admits owners plus dmAllowFrom; "pairing" admits owners only,
 * because the gateway has no pairing flow.
 */
import type { DiscordConnectionMetadata } from "../../../db/schemas/discord-connections";

/** Decide whether a direct-message sender passes the connection's DM policy. */
export function isDmSenderAllowed(
  metadata: NonNullable<DiscordConnectionMetadata>,
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
