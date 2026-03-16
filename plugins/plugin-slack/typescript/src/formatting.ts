import type { SlackChannel, SlackUser } from "./types";

/**
 * Escape special characters for Slack mrkdwn format
 * Preserves Slack's angle-bracket tokens so mentions and links stay intact
 */
function escapeSlackMrkdwnSegment(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const SLACK_ANGLE_TOKEN_RE = /<[^>\n]+>/g;

/**
 * Checks if an angle-bracket token is an allowed Slack format
 */
function isAllowedSlackAngleToken(token: string): boolean {
  if (!token.startsWith("<") || !token.endsWith(">")) {
    return false;
  }
  const inner = token.slice(1, -1);
  return (
    inner.startsWith("@") ||
    inner.startsWith("#") ||
    inner.startsWith("!") ||
    inner.startsWith("mailto:") ||
    inner.startsWith("tel:") ||
    inner.startsWith("http://") ||
    inner.startsWith("https://") ||
    inner.startsWith("slack://")
  );
}

/**
 * Escapes Slack mrkdwn content while preserving valid Slack tokens
 */
function escapeSlackMrkdwnContent(text: string): string {
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  SLACK_ANGLE_TOKEN_RE.lastIndex = 0;
  const out: string[] = [];
  let lastIndex = 0;

  for (
    let match = SLACK_ANGLE_TOKEN_RE.exec(text);
    match;
    match = SLACK_ANGLE_TOKEN_RE.exec(text)
  ) {
    const matchIndex = match.index ?? 0;
    out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex, matchIndex)));
    const token = match[0] ?? "";
    out.push(
      isAllowedSlackAngleToken(token) ? token : escapeSlackMrkdwnSegment(token),
    );
    lastIndex = matchIndex + token.length;
  }

  out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex)));
  return out.join("");
}

/**
 * Escapes Slack mrkdwn text, handling blockquotes specially
 */
export function escapeSlackMrkdwn(text: string): string {
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("> ")) {
        return `> ${escapeSlackMrkdwnContent(line.slice(2))}`;
      }
      return escapeSlackMrkdwnContent(line);
    })
    .join("\n");
}

// Placeholder used during conversion to prevent bold from being matched as italic
const BOLD_PLACEHOLDER = "\u0000BOLD\u0000";

/**
 * Converts markdown bold to Slack mrkdwn
 * Uses placeholder to prevent bold from being matched by italic converter
 */
function convertBold(text: string): string {
  return text.replace(
    /\*\*(.+?)\*\*/g,
    `${BOLD_PLACEHOLDER}$1${BOLD_PLACEHOLDER}`,
  );
}

/**
 * Converts markdown italic to Slack mrkdwn
 */
function convertItalic(text: string): string {
  // Markdown uses single * for italic, Slack uses _
  // Then restore bold placeholders to actual asterisks
  const converted = text.replace(
    /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
    "_$1_",
  );
  return converted.replace(new RegExp(BOLD_PLACEHOLDER, "g"), "*");
}

/**
 * Converts markdown strikethrough to Slack mrkdwn
 */
function convertStrikethrough(text: string): string {
  return text.replace(/~~(.+?)~~/g, "~$1~");
}

/**
 * Converts markdown code blocks to Slack mrkdwn
 */
function convertCodeBlocks(text: string): string {
  // Slack code blocks don't support language hints in the same way
  return text.replace(/```(\w*)\n?([\s\S]*?)```/g, "```\n$2```");
}

/**
 * Converts markdown links to Slack mrkdwn links
 */
function convertLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    const trimmedUrl = url.trim();
    const trimmedText = linkText.trim();
    // If link text matches URL, just use URL
    if (
      trimmedText === trimmedUrl ||
      trimmedText === trimmedUrl.replace(/^mailto:/, "")
    ) {
      return `<${escapeSlackMrkdwnSegment(trimmedUrl)}>`;
    }
    return `<${escapeSlackMrkdwnSegment(trimmedUrl)}|${escapeSlackMrkdwnSegment(trimmedText)}>`;
  });
}

/**
 * Converts markdown headings to Slack mrkdwn (bold text)
 * Uses placeholder to prevent headings from being matched by italic converter
 */
function convertHeadings(text: string): string {
  return text.replace(
    /^#{1,6}\s+(.+)$/gm,
    `${BOLD_PLACEHOLDER}$1${BOLD_PLACEHOLDER}`,
  );
}

/**
 * Converts markdown to Slack mrkdwn format
 */
export function markdownToSlackMrkdwn(markdown: string): string {
  if (!markdown) {
    return "";
  }

  // Process in order: code blocks -> links -> headings -> text styles -> escape
  let result = convertCodeBlocks(markdown);
  result = convertLinks(result);
  result = convertHeadings(result);
  result = convertBold(result);
  result = convertItalic(result);
  result = convertStrikethrough(result);
  result = escapeSlackMrkdwn(result);

  return result;
}

/**
 * Options for chunking Slack text
 */
export interface ChunkSlackTextOpts {
  /** Max characters per message. Default: 4000 */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 4000;

/**
 * Chunks Slack text while preserving code blocks
 */
export function chunkSlackText(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): string[] {
  if (!text) {
    return [];
  }

  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  let inCodeBlock = false;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point
    let breakPoint = maxChars;

    // Check if we're in a code block
    const codeBlockCount = (remaining.slice(0, maxChars).match(/```/g) || [])
      .length;
    inCodeBlock = codeBlockCount % 2 !== 0;

    // Try to break at a newline
    const newlineIndex = remaining.lastIndexOf("\n", maxChars);
    if (newlineIndex > maxChars * 0.5) {
      breakPoint = newlineIndex + 1;
    } else {
      // Try to break at a space
      const spaceIndex = remaining.lastIndexOf(" ", maxChars);
      if (spaceIndex > maxChars * 0.5) {
        breakPoint = spaceIndex + 1;
      }
    }

    let chunk = remaining.slice(0, breakPoint);

    // If we're breaking inside a code block, close it
    if (inCodeBlock) {
      chunk += "\n```";
    }

    chunks.push(chunk);

    remaining = remaining.slice(breakPoint);

    // If we were in a code block, reopen it
    if (inCodeBlock) {
      remaining = `\`\`\`\n${remaining}`;
    }
  }

  return chunks;
}

/**
 * Converts markdown to Slack mrkdwn and splits into chunks
 */
export function markdownToSlackMrkdwnChunks(
  markdown: string,
  limit: number,
): string[] {
  return chunkSlackText(markdownToSlackMrkdwn(markdown), limit);
}

/**
 * Formats a Slack user mention
 */
export function formatSlackUserMention(userId: string): string {
  return `<@${userId}>`;
}

/**
 * Formats a Slack channel mention
 */
export function formatSlackChannelMention(channelId: string): string {
  return `<#${channelId}>`;
}

/**
 * Formats a Slack user group mention
 */
export function formatSlackUserGroupMention(groupId: string): string {
  return `<!subteam^${groupId}>`;
}

/**
 * Formats a Slack special mention (@here, @channel, @everyone)
 */
export function formatSlackSpecialMention(
  type: "here" | "channel" | "everyone",
): string {
  return `<!${type}>`;
}

/**
 * Formats a Slack link
 */
export function formatSlackLink(url: string, text?: string): string {
  const safeUrl = escapeSlackMrkdwnSegment(url);
  if (text && text !== url) {
    return `<${safeUrl}|${escapeSlackMrkdwnSegment(text)}>`;
  }
  return `<${safeUrl}>`;
}

/**
 * Formats a Slack date
 */
export function formatSlackDate(
  timestamp: number | Date,
  format: string = "{date_short_pretty} at {time}",
  fallbackText?: string,
): string {
  const unix = Math.floor(
    (typeof timestamp === "number" ? timestamp : timestamp.getTime()) / 1000,
  );
  const fallback = fallbackText || new Date(unix * 1000).toISOString();
  return `<!date^${unix}^${format}|${fallback}>`;
}

/**
 * Extracts user ID from a Slack mention
 */
export function extractUserIdFromMention(mention: string): string | null {
  const match = mention.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/i);
  return match ? match[1] : null;
}

/**
 * Extracts channel ID from a Slack mention
 */
export function extractChannelIdFromMention(mention: string): string | null {
  const match = mention.match(/^<#([CGD][A-Z0-9]+)(?:\|[^>]*)?>$/i);
  return match ? match[1] : null;
}

/**
 * Extracts URL from a Slack link
 */
export function extractUrlFromSlackLink(link: string): string | null {
  const match = link.match(/^<(https?:\/\/[^|>]+)(?:\|[^>]*)?>$/);
  return match ? match[1] : null;
}

/**
 * Formats a user's display name
 */
export function formatSlackUserDisplayName(user: SlackUser): string {
  return user.profile.displayName || user.profile.realName || user.name;
}

/**
 * Formats a channel for display
 */
export function formatSlackChannel(channel: SlackChannel): string {
  if (channel.isIm) {
    return "Direct Message";
  }
  if (channel.isMpim) {
    return `Group DM: ${channel.name}`;
  }
  return `#${channel.name}`;
}

/**
 * Gets the channel type as a human-readable string
 */
export function getChannelTypeString(channel: SlackChannel): string {
  if (channel.isIm) {
    return "DM";
  }
  if (channel.isMpim) {
    return "Group DM";
  }
  if (channel.isPrivate || channel.isGroup) {
    return "Private Channel";
  }
  return "Channel";
}

/**
 * Resolves the system location string for logging/display
 */
export function resolveSlackSystemLocation(
  channel: SlackChannel,
  teamName?: string,
): string {
  const channelType = getChannelTypeString(channel);
  const channelName = formatSlackChannel(channel);
  if (teamName) {
    return `${teamName} - ${channelType}: ${channelName}`;
  }
  return `${channelType}: ${channelName}`;
}

/**
 * Checks if a channel is a direct message
 */
export function isDirectMessage(channel: SlackChannel): boolean {
  return channel.isIm;
}

/**
 * Checks if a channel is a group DM (multi-party IM)
 */
export function isGroupDm(channel: SlackChannel): boolean {
  return channel.isMpim;
}

/**
 * Checks if a channel is a private channel
 */
export function isPrivateChannel(channel: SlackChannel): boolean {
  return channel.isPrivate || channel.isGroup;
}

/**
 * Truncates text to a maximum length with an ellipsis
 */
export function truncateText(
  text: string,
  maxLength: number,
  ellipsis = "…",
): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - ellipsis.length) + ellipsis;
}

/**
 * Strips Slack mrkdwn formatting from text
 */
export function stripSlackFormatting(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "") // Code blocks (must be before inline code)
    .replace(/\*([^*]+)\*/g, "$1") // Bold
    .replace(/_([^_]+)_/g, "$1") // Italic
    .replace(/~([^~]+)~/g, "$1") // Strikethrough
    .replace(/`([^`]+)`/g, "$1") // Inline code
    .replace(/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/gi, "") // User mentions
    .replace(/<#[CGD][A-Z0-9]+(?:\|[^>]*)?>/gi, "") // Channel mentions
    .replace(/<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>/gi, "") // User group mentions
    .replace(/<!(?:here|channel|everyone)(?:\|[^>]*)?>/gi, "") // Special mentions
    .replace(/<(https?:\/\/[^|>]+)(?:\|([^>]*))?>/, "$2") // Links with text
    .replace(/<(https?:\/\/[^>]+)>/, "$1") // Plain links
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/**
 * Builds a Slack message permalink
 */
export function buildSlackMessagePermalink(
  workspaceDomain: string,
  channelId: string,
  messageTs: string,
): string {
  const formattedTs = `p${messageTs.replace(".", "")}`;
  return `https://${workspaceDomain}.slack.com/archives/${channelId}/${formattedTs}`;
}

/**
 * Parses a Slack message permalink
 */
export function parseSlackMessagePermalink(
  link: string,
): { workspaceDomain: string; channelId: string; messageTs: string } | null {
  const match = link.match(
    /^https?:\/\/([^.]+)\.slack\.com\/archives\/([CGD][A-Z0-9]+)\/p(\d+)/i,
  );
  if (!match) {
    return null;
  }

  const ts = match[3];
  // Convert p1234567890123456 to 1234567890.123456
  const messageTs = `${ts.slice(0, 10)}.${ts.slice(10)}`;

  return {
    workspaceDomain: match[1],
    channelId: match[2],
    messageTs,
  };
}
