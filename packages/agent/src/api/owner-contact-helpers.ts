/**
 * Shared helper for auto-populating owner contacts when a connector
 * successfully pairs. Called by the per-platform setup routes
 * (signal-routes, whatsapp-routes, telegram-setup-routes, etc.).
 *
 * Writes to `config.agents.defaults.ownerContacts[source]` so LifeOps
 * reminder delivery can immediately find the owner on the newly
 * connected platform without manual configuration.
 */

type MinimalConfig = Record<string, unknown> & {
  agents?: {
    defaults?: {
      ownerContacts?: Record<
        string,
        { entityId?: string; channelId?: string; roomId?: string }
      >;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

export interface OwnerContactUpdate {
  /** Canonical connector source name (e.g. "signal", "telegram", "discord", "whatsapp", "imessage"). */
  source: string;
  /** Platform-specific channel/chat ID (phone number, chat id, etc.). */
  channelId?: string;
  /** Entity UUID in the runtime, if known. */
  entityId?: string;
  /** Room UUID in the runtime, if known. */
  roomId?: string;
}

/**
 * Write (or update) an owner contact entry in the agent config.
 * Returns true if the config was modified.
 */
export function setOwnerContact(
  config: MinimalConfig,
  update: OwnerContactUpdate,
): boolean {
  if (!update.source) return false;

  // Ensure the nested path exists
  if (!config.agents) {
    config.agents = {};
  }
  if (!config.agents.defaults) {
    config.agents.defaults = {};
  }
  if (!config.agents.defaults.ownerContacts) {
    config.agents.defaults.ownerContacts = {};
  }

  const existing = config.agents.defaults.ownerContacts[update.source];
  const entry: Record<string, string> = {};

  if (update.channelId) entry.channelId = update.channelId;
  if (update.entityId) entry.entityId = update.entityId;
  if (update.roomId) entry.roomId = update.roomId;

  // Don't write empty entries
  if (Object.keys(entry).length === 0) return false;

  // Skip if unchanged
  if (
    existing &&
    existing.channelId === entry.channelId &&
    existing.entityId === entry.entityId &&
    existing.roomId === entry.roomId
  ) {
    return false;
  }

  config.agents.defaults.ownerContacts[update.source] = entry;
  return true;
}
