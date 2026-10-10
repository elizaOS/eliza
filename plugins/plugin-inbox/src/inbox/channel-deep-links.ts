/**
 * Per-channel deep-link construction for inbox triage entries. `buildDeepLink`
 * turns a source plus room/world metadata into a URL that opens the originating
 * thread in its native client (Discord guild/channel/message, Telegram, Slack,
 * email, …), returning null when the metadata is insufficient;
 * `resolveChannelName` derives the human-facing channel label. Pure.
 */
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
  // The Telegram connector persists no `chatId`/`username` room metadata — the
  // platform chat id lives only on `Room.channelId` (as `<chat.id>`, or
  // `<chat.id>-<threadId>` for forum-topic rooms), which the fetcher overlays
  // into `channelId`. Only the `-100…` supergroup/channel form has a public
  // `t.me/c/<internal>` link; DM ids (positive) and basic-group ids (negative
  // without `-100`) have none, and fabricating `t.me/c/<id>` for them yields a
  // dead URL, so those stay null and the inbox keeps its `/inbox` fallback.
  const rawChatId = chatId ?? telegramChatIdFromChannelId(room.channelId);
  if (rawChatId) {
    const normalized = rawChatId.replace(/^-100/, "");
    if (normalized.length > 0 && rawChatId.startsWith("-100")) {
      return messageId
        ? `https://t.me/c/${normalized}/${messageId}`
        : `https://t.me/c/${normalized}`;
    }
  }
  return null;
}

/** Extract the numeric Telegram supergroup/channel id from a `Room.channelId`
 * value (`-1001234567890` or a forum-topic `-1001234567890-45`), or null when
 * the value is not a `-100…` Telegram chat id (another connector's channel id,
 * a DM id, or a basic-group id — none of those have a public `t.me/c` link). */
function telegramChatIdFromChannelId(channelId: unknown): string | null {
  const value = str(channelId);
  if (!value) return null;
  const match = value.match(/^-100\d+/);
  return match ? match[0] : null;
}

function buildIMessageLink(room: Record<string, unknown>): string | null {
  // plugin-imessage `ensureRoomExists` persists chat.db `chat_identifier` as
  // room metadata `chatId` and `Room.channelId`. It never writes `handle`,
  // `chatIdentifier`, or `chat_identifier`, so those keys alone leave every
  // iMessage triage row without a link. 1:1 ids are a phone or email (bare,
  // or `iMessage;-;+1555…`); group ids (`chat…`, `iMessage;+;chat…`) have no
  // public `imessage://` target and stay null so the inbox keeps `/inbox`.
  const handle =
    str(room.handle) ||
    str(room.chatIdentifier) ||
    str(room.chat_identifier) ||
    imessageDirectAddress(room.chatId) ||
    imessageDirectAddress(room.channelId);
  if (handle) {
    return `imessage://${handle}`;
  }
  return null;
}

/** Phone or email an `imessage://` URL can open, or null for a group chat id. */
function imessageDirectAddress(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const parts = raw.split(";");
  let candidate = raw;
  if (parts.length >= 3) {
    // AppleScript / chat.db form: "<service>;<+|->;<id>". "+" is a group.
    if (parts[1] !== "-") return null;
    candidate = parts.slice(2).join(";");
  }
  if (isImessageEmail(candidate) || isImessagePhone(candidate))
    return candidate;
  return null;
}

function isImessageEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isImessagePhone(value: string): boolean {
  return /^\+?[0-9]{7,15}$/.test(value);
}

function buildWhatsAppLink(room: Record<string, unknown>): string | null {
  const jid = str(room.jid);
  if (jid?.includes("@") && !/^[0-9]+@s\.whatsapp\.net$/i.test(jid)) {
    return null;
  }
  const jidPhone = jid?.includes("@") ? jid.slice(0, jid.indexOf("@")) : jid;
  const raw = str(room.phoneNumber) || jidPhone;
  if (raw) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length > 0) {
      return `https://wa.me/${digits}`;
    }
  }
  return null;
}

function buildSlackLink(
  room: Record<string, unknown>,
  world: Record<string, unknown>,
  messageId?: string,
): string | null {
  // Slack rooms persist the workspace id as room metadata `serverId`
  // (see plugin-slack `ensureRoomExists`); world metadata only nests it under
  // `extra.teamId`. Resolve from any of the three, or the link is never built.
  const worldExtra =
    world.extra &&
    typeof world.extra === "object" &&
    !Array.isArray(world.extra)
      ? (world.extra as Record<string, unknown>)
      : {};
  const teamId =
    str(world.teamId) ||
    str(worldExtra.teamId) ||
    str(room.teamId) ||
    str(room.serverId);
  const channelId = str(room.channelId);
  if (!teamId || !channelId) return null;

  if (messageId) {
    // The web-client thread route takes the raw dotted message ts
    // (app.slack.com/client/<team>/<channel>/thread/<channel>-<ts>), but a
    // stored id may carry the archives-permalink token form p<dotless>
    // (chat.getPermalink maps ts 1358546515.000008 to p135854651500008).
    // Restore the dot before the last six digits so both stored forms open
    // the thread; a dotted ts passes through unchanged.
    const ts = dottedSlackTs(messageId);
    return `https://app.slack.com/client/${teamId}/${channelId}/thread/${channelId}-${ts}`;
  }
  return `slack://channel?team=${teamId}&id=${channelId}`;
}

function dottedSlackTs(messageId: string): string {
  if (!messageId.startsWith("p")) return messageId;
  const digits = messageId.slice(1);
  if (digits.length <= 6) return digits;
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
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
