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
  if (!metadata || typeof metadata !== "object") return true;
  if (typeof authorId !== "string" || !authorId) return false;
  const dmPolicy = metadata.dmPolicy ?? "open";
  if (dmPolicy === "open") return true;
  if (dmPolicy === "disabled") return false;

  const allowed = new Set<string>(
    Array.isArray(metadata.ownerDiscordUserIds)
      ? metadata.ownerDiscordUserIds.filter((id) => typeof id === "string")
      : [],
  );
  if (typeof metadata.ownerDiscordUserId === "string") {
    allowed.add(metadata.ownerDiscordUserId);
  }
  if (dmPolicy === "allowlist" && Array.isArray(metadata.dmAllowFrom)) {
    for (const id of metadata.dmAllowFrom) {
      if (typeof id === "string") allowed.add(id);
    }
  }
  return allowed.has(authorId);
}
