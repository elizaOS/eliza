import type { IAgentRuntime, UUID } from "@elizaos/core";

// ---------------------------------------------------------------------------
// Per-connector deep link generation
// ---------------------------------------------------------------------------

/**
 * Builds a clickable deep link to a specific message or conversation on its
 * native platform. Falls back to a generic channel description when metadata
 * is insufficient.
 */
export async function buildDeepLink(
  runtime: IAgentRuntime,
  source: string,
  opts: {
    roomId?: string;
    entityId?: string;
    messageId?: string;
    /** Pre-resolved room metadata (avoids an extra DB fetch). */
    roomMeta?: Record<string, unknown>;
    /** Pre-resolved world metadata. */
    worldMeta?: Record<string, unknown>;
  },
): Promise<string | null> {
  const meta = opts.roomMeta ?? (await fetchRoomMeta(runtime, opts.roomId));
  const worldMeta =
    opts.worldMeta ?? (await fetchWorldMetaForRoom(runtime, opts.roomId));

  switch (source) {
    case "discord":
    case "discord-local":
      return buildDiscordLink(meta, worldMeta, opts.messageId);
    case "telegram":
    case "telegram-account":
      return buildTelegramLink(meta, opts.messageId);
    case "signal":
      return buildSignalLink(meta);
    case "imessage":
    case "bluebubbles":
      return buildIMessageLink(meta);
    case "whatsapp":
      return buildWhatsAppLink(meta);
    case "slack":
      return buildSlackLink(meta, worldMeta, opts.messageId);
    case "gmail":
      return buildGmailLink(meta, opts.messageId);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

function buildDiscordLink(
  room: Record<string, unknown>,
  world: Record<string, unknown>,
  messageId?: string,
): string | null {
  const serverId = str(world.serverId) || str(room.serverId);
  const channelId = str(room.channelId);
  if (!channelId) return null;

  // DM channels have no serverId
  const base = serverId
    ? `https://discord.com/channels/${serverId}/${channelId}`
    : `https://discord.com/channels/@me/${channelId}`;
  return messageId ? `${base}/${messageId}` : base;
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

function buildTelegramLink(
  room: Record<string, unknown>,
  messageId?: string,
): string | null {
  const username = str(room.username);
  const chatId = str(room.chatId);

  if (username) {
    return messageId
      ? `https://t.me/${username}/${messageId}`
      : `https://t.me/${username}`;
  }
  if (chatId) {
    // Private groups use numeric IDs with -100 prefix stripped
    const normalized = chatId.replace(/^-100/, "");
    return messageId
      ? `https://t.me/c/${normalized}/${messageId}`
      : `https://t.me/c/${normalized}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------

function buildSignalLink(room: Record<string, unknown>): string | null {
  // Signal doesn't support message-level deep links
  const phoneNumber = str(room.phoneNumber) || str(room.identifier);
  if (phoneNumber) {
    return `signal://signal.me/#p/${phoneNumber}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// iMessage / BlueBubbles
// ---------------------------------------------------------------------------

function buildIMessageLink(room: Record<string, unknown>): string | null {
  const handle =
    str(room.handle) || str(room.chatIdentifier) || str(room.chat_identifier);
  if (handle) {
    return `imessage://${handle}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

function buildWhatsAppLink(room: Record<string, unknown>): string | null {
  const phoneNumber =
    str(room.phoneNumber) || str(room.jid)?.replace(/@.*$/, "");
  if (phoneNumber) {
    return `https://wa.me/${phoneNumber.replace(/\D/g, "")}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

function buildSlackLink(
  room: Record<string, unknown>,
  world: Record<string, unknown>,
  messageId?: string,
): string | null {
  const teamId = str(world.teamId) || str(room.teamId);
  const channelId = str(room.channelId);
  if (!teamId || !channelId) return null;

  if (messageId) {
    // Slack message links use the ts format (e.g. p1234567890123456)
    const ts = messageId.startsWith("p") ? messageId.slice(1) : messageId;
    return `https://app.slack.com/client/${teamId}/${channelId}/thread/${channelId}-${ts}`;
  }
  return `slack://channel?team=${teamId}&id=${channelId}`;
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

function buildGmailLink(
  room: Record<string, unknown>,
  messageId?: string,
): string | null {
  const gmailId = messageId || str(room.gmailMessageId);
  if (gmailId) {
    return `https://mail.google.com/mail/u/0/#inbox/${gmailId}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

async function fetchRoomMeta(
  runtime: IAgentRuntime,
  roomId?: string,
): Promise<Record<string, unknown>> {
  if (!roomId) return {};
  try {
    const room = await runtime.getRoom(roomId as UUID);
    if (!room) return {};
    const meta =
      typeof room.metadata === "object" && room.metadata
        ? (room.metadata as Record<string, unknown>)
        : {};
    return { ...meta, roomId: room.id, roomName: room.name };
  } catch {
    return {};
  }
}

async function fetchWorldMetaForRoom(
  runtime: IAgentRuntime,
  roomId?: string,
): Promise<Record<string, unknown>> {
  if (!roomId) return {};
  try {
    const room = await runtime.getRoom(roomId as UUID);
    if (!room?.worldId) return {};
    const world = await runtime.getWorld(room.worldId);
    if (!world) return {};
    return typeof world.metadata === "object" && world.metadata
      ? (world.metadata as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * Resolve a human-friendly channel name from room metadata.
 */
export async function resolveChannelName(
  runtime: IAgentRuntime,
  source: string,
  roomId?: string,
  senderName?: string,
): Promise<string> {
  if (roomId) {
    try {
      const room = await runtime.getRoom(roomId as UUID);
      if (room?.name) return room.name;
    } catch {
      // fall through
    }
  }
  if (senderName) return `${senderName} (${source})`;
  return source;
}
