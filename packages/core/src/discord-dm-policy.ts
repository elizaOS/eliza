/** Canonical Discord direct-message authorization semantics shared across runtimes. */
export interface DiscordDmPolicyMetadata {
  dmPolicy?: "open" | "disabled" | "allowlist" | "pairing";
  ownerDiscordUserId?: string;
  ownerDiscordUserIds?: string[];
  dmAllowFrom?: string[];
}

/**
 * Decide whether a sender is authorized by already-validated DM policy metadata.
 * Transport/envelope validation remains the caller's responsibility.
 */
export function isDiscordDmSenderAllowed(
  metadata: DiscordDmPolicyMetadata,
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
