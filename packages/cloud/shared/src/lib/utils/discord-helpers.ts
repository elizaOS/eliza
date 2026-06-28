/**
 * Discord Utility Functions
 *
 * Helper functions for Discord API interactions.
 */

// Discord Channel Types (from discord-api-types)
export const DiscordChannelType = {
  GuildText: 0,
  DM: 1,
  GuildVoice: 2,
  GroupDM: 3,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
  GuildStageVoice: 13,
  GuildDirectory: 14,
  GuildForum: 15,
  GuildMedia: 16,
} as const;

export const DISCORD_RATE_LIMITS = {
  MESSAGES_PER_SECOND: 5,
  MESSAGES_PER_CHANNEL_PER_SECOND: 5,
  MAX_MESSAGE_LENGTH: 2000,
  MAX_EMBED_DESCRIPTION: 4096,
  MAX_EMBEDS_PER_MESSAGE: 10,
  MAX_EMBED_TOTAL_CHARS: 6000,
} as const;

/**
 * Discord blurple color
 */
export const DISCORD_BLURPLE = 0x5865f2;

/**
 * Get Discord CDN URL for guild icon
 */
export function getGuildIconUrl(
  guildId: string,
  iconHash: string | null,
  size: 64 | 128 | 256 | 512 = 128,
): string | null {
  if (!iconHash) return null;
  const ext = iconHash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.${ext}?size=${size}`;
}

/**
 * Get human-readable channel type name
 */
export function getChannelTypeName(type: number): string {
  switch (type) {
    case DiscordChannelType.GuildText:
      return "Text Channel";
    case DiscordChannelType.GuildAnnouncement:
      return "Announcement Channel";
    case DiscordChannelType.GuildVoice:
      return "Voice Channel";
    case DiscordChannelType.GuildCategory:
      return "Category";
    case DiscordChannelType.GuildForum:
      return "Forum";
    case DiscordChannelType.GuildStageVoice:
      return "Stage Channel";
    default:
      return "Channel";
  }
}

/**
 * Check if channel type is text-based (can send messages)
 */
export function isTextChannel(type: number): boolean {
  return type === DiscordChannelType.GuildText || type === DiscordChannelType.GuildAnnouncement;
}

/**
 * Split long messages for Discord's 2000 char limit
 */
export function splitMessage(text: string, maxLength = 2000): string[] {
  if (!text) return [];
  if (text.length <= maxLength) return [text];

  const messages: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      messages.push(remaining);
      break;
    }

    // Find a good break point (newline or space)
    let breakPoint = remaining.lastIndexOf("\n", maxLength);
    if (breakPoint === -1 || breakPoint < maxLength * 0.5) {
      breakPoint = remaining.lastIndexOf(" ", maxLength);
    }
    if (breakPoint === -1 || breakPoint < maxLength * 0.5) {
      breakPoint = maxLength;
    }

    messages.push(remaining.substring(0, breakPoint));
    remaining = remaining.substring(breakPoint).trimStart();
  }

  return messages;
}

/**
 * Escape Discord markdown characters
 */
export function escapeMarkdown(text: string): string {
  if (!text) return "";
  return text.replace(/([*_~`|\\])/g, "\\$1");
}

/**
 * Format text as Discord code block
 */
export function codeBlock(text: string, language = ""): string {
  return `\`\`\`${language}\n${text}\n\`\`\``;
}

/**
 * Format text as inline code
 */
export function inlineCode(text: string): string {
  return `\`${text}\``;
}

/**
 * Create bold text
 */
export function bold(text: string): string {
  return `**${text}**`;
}

/**
 * Create italic text
 */
export function italic(text: string): string {
  return `*${text}*`;
}

/**
 * Create strikethrough text
 */
export function strikethrough(text: string): string {
  return `~~${text}~~`;
}

/**
 * Create mention string for user/role/channel
 */
export function mention(id: string, type: "user" | "role" | "channel"): string {
  switch (type) {
    case "user":
      return `<@${id}>`;
    case "role":
      return `<@&${id}>`;
    case "channel":
      return `<#${id}>`;
  }
}

/**
 * Create a hyperlink
 */
export function hyperlink(text: string, url: string): string {
  return `[${text}](${url})`;
}

/**
 * Truncate text to a maximum length with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
}

/**
 * Mask a guild/channel ID for logging (privacy)
 */
export function maskId(id: string): string {
  if (!id || id.length <= 6) return id;
  return `${id.slice(0, 3)}...${id.slice(-3)}`;
}

/**
 * Validate Discord snowflake ID format
 */
export function isValidSnowflake(id: string): boolean {
  // Discord snowflakes are 17-19 digit numbers
  return /^\d{17,19}$/.test(id);
}

/**
 * Create a link button component
 */
export function createLinkButton(label: string, url: string) {
  return {
    type: 2 as const, // Button
    style: 5 as const, // Link
    label,
    url,
  };
}

/**
 * Create an action row with buttons
 */
export function createActionRow(buttons: Array<{ label: string; url: string }>) {
  return {
    type: 1 as const, // Action Row
    components: buttons.map((b) => createLinkButton(b.label, b.url)),
  };
}

/**
 * Create a basic embed
 */
export function createEmbed(options: {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  thumbnailUrl?: string;
  imageUrl?: string;
  footerText?: string;
}) {
  const embed: Record<string, unknown> = {};

  if (options.title) embed.title = options.title;
  if (options.description) embed.description = truncate(options.description, 4096);
  if (options.url) embed.url = options.url;
  if (options.color !== undefined) embed.color = options.color;
  if (options.thumbnailUrl) embed.thumbnail = { url: options.thumbnailUrl };
  if (options.imageUrl) embed.image = { url: options.imageUrl };
  if (options.footerText) embed.footer = { text: options.footerText };

  return embed;
}
