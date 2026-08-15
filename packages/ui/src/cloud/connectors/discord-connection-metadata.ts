/**
 * Preserves the complete Discord connection metadata contract while the Cloud
 * editor changes only its owner and direct-message controls.
 */

export type DiscordDmPolicy = "open" | "allowlist" | "pairing" | "disabled";

export interface DiscordConnectionMetadata {
  responseMode?: "always" | "mention" | "keyword";
  keywords?: string[];
  enabledChannels?: string[];
  disabledChannels?: string[];
  ownerDiscordUserId?: string;
  ownerDiscordUserIds?: string[];
  dmPolicy?: DiscordDmPolicy;
  dmAllowFrom?: string[];
}

interface DiscordConnectionMetadataEdit {
  responseMode: "always" | "mention" | "keyword";
  ownerDiscordUserId: string;
  dmPolicy: DiscordDmPolicy;
  dmAllowFrom: string[];
}

/**
 * Composes editable DM controls over the complete stored metadata. The API
 * replaces this JSON object, so preserving fields outside the form here is the
 * boundary that keeps channel restrictions and owner aliases intact.
 */
export function buildDiscordConnectionMetadataUpdate(
  stored: DiscordConnectionMetadata | null,
  edit: DiscordConnectionMetadataEdit,
): DiscordConnectionMetadata {
  const metadata: DiscordConnectionMetadata = {
    ...(stored ?? {}),
    responseMode: edit.responseMode,
  };

  const ownerDiscordUserId = edit.ownerDiscordUserId.trim();
  if (ownerDiscordUserId) {
    metadata.ownerDiscordUserId = ownerDiscordUserId;
  } else {
    delete metadata.ownerDiscordUserId;
  }

  if (edit.dmPolicy === "open") {
    delete metadata.dmPolicy;
  } else {
    metadata.dmPolicy = edit.dmPolicy;
  }

  if (edit.dmAllowFrom.length === 0) {
    delete metadata.dmAllowFrom;
  } else {
    metadata.dmAllowFrom = [...edit.dmAllowFrom];
  }

  return metadata;
}
