export function buildDeepLink(
  source: string,
  opts: {
    messageId?: string;
    roomMeta?: Record<string, unknown>;
    worldMeta?: Record<string, unknown>;
  },
): string | null {
  const meta = opts.roomMeta ?? {};
  const worldMeta = opts.worldMeta ?? {};

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

function buildDiscordLink(
  room: Record<string, unknown>,
  world: Record<string, unknown>,
  messageId?: string,
): string | null {
  const serverId = str(world.serverId) || str(room.serverId);
  const channelId = str(room.channelId);
  if (!channelId) return null;

  const base = serverId
    ? `https://discord.com/channels/${serverId}/${channelId}`
    : `https://discord.com/channels/@me/${channelId}`;
  return messageId ? `${base}/${messageId}` : base;
}

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
    const normalized = chatId.replace(/^-100/, "");
    return messageId
      ? `https://t.me/c/${normalized}/${messageId}`
      : `https://t.me/c/${normalized}`;
  }
  return null;
}

function buildSignalLink(room: Record<string, unknown>): string | null {
  const phoneNumber = str(room.phoneNumber) || str(room.identifier);
  if (phoneNumber) {
    return `signal://signal.me/#p/${phoneNumber}`;
  }
  return null;
}

function buildIMessageLink(room: Record<string, unknown>): string | null {
  const handle =
    str(room.handle) || str(room.chatIdentifier) || str(room.chat_identifier);
  if (handle) {
    return `imessage://${handle}`;
  }
  return null;
}

function buildWhatsAppLink(room: Record<string, unknown>): string | null {
  const phoneNumber =
    str(room.phoneNumber) || str(room.jid)?.replace(/@.*$/, "");
  if (phoneNumber) {
    return `https://wa.me/${phoneNumber.replace(/\D/g, "")}`;
  }
  return null;
}

function buildSlackLink(
  room: Record<string, unknown>,
  world: Record<string, unknown>,
  messageId?: string,
): string | null {
  const teamId = str(world.teamId) || str(room.teamId);
  const channelId = str(room.channelId);
  if (!teamId || !channelId) return null;

  if (messageId) {
    const ts = messageId.startsWith("p") ? messageId.slice(1) : messageId;
    return `https://app.slack.com/client/${teamId}/${channelId}/thread/${channelId}-${ts}`;
  }
  return `slack://channel?team=${teamId}&id=${channelId}`;
}

function buildGmailLink(
  room: Record<string, unknown>,
  messageId?: string,
): string | null {
  const gmailId = messageId || str(room.gmailMessageId);
  if (gmailId) {
    const account =
      str(room.gmailAccountEmail) ||
      str(room.accountEmail) ||
      str(room.email) ||
      "0";
    return `https://mail.google.com/mail/u/${encodeURIComponent(account)}/#inbox/${gmailId}`;
  }
  return null;
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return null;
}

export function resolveChannelName(
  source: string,
  roomName?: string,
  senderName?: string,
): string {
  if (roomName) return roomName;
  if (senderName) return `${senderName} (${source})`;
  return source;
}
