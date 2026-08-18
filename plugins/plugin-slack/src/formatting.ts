/**
 * Slack mrkdwn formatting utilities. Converts agent markdown to Slack's
 * `*bold*` / `_italic_` / `~strike~` mrkdwn and chunks it under the message
 * length limit (`markdownToSlackMrkdwn`, `chunkSlackText`), escapes user text so
 * it can't forge Slack control sequences while preserving legitimate
 * angle-bracket mention/link tokens (`escapeSlackMrkdwn`), builds and parses the
 * `<@U…>` / `<#C…>` / `<url|label>` tokens and message permalinks, and derives
 * channel-type / display-name helpers. Used by `service.ts` on the send/receive
 * paths and re-exported from `index.ts`.
 */
import { ElizaError, truncateWellFormed } from "@elizaos/core";
import {
  parseSlackArchivesUrl,
  type SlackChannel,
  type SlackUser,
} from "./types";

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
    const matchIndex = match.index;
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

// Sentinel used during conversion to prevent bold from being matched as italic.
const BOLD_SENTINEL = "\u0000BOLD\u0000";

/**
 * Converts markdown bold to Slack mrkdwn
 * Uses a sentinel to prevent bold from being matched by italic converter
 */
function convertBold(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, `${BOLD_SENTINEL}$1${BOLD_SENTINEL}`);
}

/**
 * Converts markdown italic to Slack mrkdwn
 */
function convertItalic(text: string): string {
  // Markdown uses single * for italic, Slack uses _
  // Then restore bold sentinels to actual asterisks
  const converted = text.replace(
    /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
    "_$1_",
  );
  return converted.replace(new RegExp(BOLD_SENTINEL, "g"), "*");
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
 * Uses a sentinel to prevent headings from being matched by italic converter
 */
function convertHeadings(text: string): string {
  return text.replace(
    /^#{1,6}\s+(.+)$/gm,
    `${BOLD_SENTINEL}$1${BOLD_SENTINEL}`,
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
 * A hard per-chunk cap can never be honored for arbitrary text unless it's a
 * positive integer that can hold at least one UTF-16 code unit; anything
 * else (NaN, 0, negative, fractional) has no sensible "effective bound" and
 * must fail closed instead of silently coercing into one.
 */
function requireValidChunkLimit(maxChars: number, fnName: string): void {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new ElizaError(
      `${fnName}: maxChars must be a positive integer, got ${maxChars}`,
      { code: "SLACK_CHUNK_LIMIT_INVALID", context: { fnName, maxChars } },
    );
  }
}

/**
 * `effectiveLimit` (the actual per-chunk budget after fence/break-point
 * accounting) is too small to hold even one well-formed unit of the
 * remaining text — e.g. an astral character needs 2 UTF-16 code units, so a
 * 1-unit budget can't fit it without splitting a surrogate pair. Widening
 * the chunk past the caller's requested `maxChars` would silently break the
 * "never emits more than maxChars" contract, so this fails closed instead.
 */
function chunkLimitTooSmall(
  fnName: string,
  effectiveLimit: number,
  maxChars: number,
): never {
  throw new ElizaError(
    `${fnName}: a chunk limit of ${effectiveLimit} (from maxChars=${maxChars}) cannot hold the next well-formed character without splitting a surrogate pair`,
    {
      code: "SLACK_CHUNK_LIMIT_TOO_SMALL",
      context: { fnName, effectiveLimit, maxChars },
    },
  );
}

/**
 * Splits plain Slack message text at newline/space boundaries without ever
 * emitting more than `maxChars`. Unlike `chunkSlackText`, this does not add
 * code-fence balancing characters.
 *
 * @throws {ElizaError} if `maxChars` isn't a positive integer, or is too
 * small to fit the next well-formed character (see {@link chunkLimitTooSmall}).
 */
export function splitSlackText(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): string[] {
  requireValidChunkLimit(maxChars, "splitSlackText");
  if (text.length <= maxChars) {
    return [text];
  }

  const messages: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      messages.push(remaining);
      break;
    }

    let splitIndex = maxChars;
    const lastNewline = remaining.lastIndexOf("\n", maxChars);
    if (lastNewline > maxChars / 2) {
      splitIndex = lastNewline + 1;
    } else {
      const lastSpace = remaining.lastIndexOf(" ", maxChars);
      if (lastSpace > maxChars / 2) {
        splitIndex = lastSpace + 1;
      }
    }

    splitIndex = Math.min(splitIndex, maxChars);
    // truncateWellFormed backs the cut off by one unit instead of splitting a
    // surrogate pair; remaining must resume from the actual chunk length, not
    // the requested splitIndex, or one unit of text would be dropped.
    const chunk = truncateWellFormed(remaining, splitIndex);
    if (chunk.length === 0) {
      chunkLimitTooSmall("splitSlackText", splitIndex, maxChars);
    }
    messages.push(chunk);
    remaining = remaining.slice(chunk.length);
  }

  return messages;
}

/**
 * Chunks Slack text while preserving code blocks.
 *
 * @throws {ElizaError} if `maxChars` isn't a positive integer, or is too
 * small to fit the next well-formed character (see {@link chunkLimitTooSmall}).
 */
export function chunkSlackText(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): string[] {
  requireValidChunkLimit(maxChars, "chunkSlackText");
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

    // Find a good break point. Reserve room for the closing "\n```" fence so
    // a chunk that splits inside a code block never exceeds maxChars.
    const hardLimit = Math.max(maxChars - 4, 1);
    let breakPoint = hardLimit;

    // Try to break at a newline
    const newlineIndex = remaining.lastIndexOf("\n", hardLimit);
    if (newlineIndex > maxChars * 0.5) {
      breakPoint = newlineIndex + 1;
    } else {
      // Try to break at a space
      const spaceIndex = remaining.lastIndexOf(" ", hardLimit);
      if (spaceIndex > maxChars * 0.5) {
        breakPoint = spaceIndex + 1;
      }
    }

    // lastIndexOf is inclusive of its fromIndex, so a newline or space sitting
    // exactly on hardLimit yields breakPoint = hardLimit + 1 and the reserved
    // fence budget is spent, pushing the emitted chunk to maxChars + 1.
    breakPoint = Math.min(breakPoint, hardLimit);

    // truncateWellFormed backs the cut off by one unit instead of splitting a
    // surrogate pair; consumedLength (not breakPoint) is how far `remaining`
    // must advance, since the fence suffix appended below isn't part of it.
    let chunk = truncateWellFormed(remaining, breakPoint);
    if (chunk.length === 0) {
      chunkLimitTooSmall("chunkSlackText", breakPoint, maxChars);
    }
    const consumedLength = chunk.length;

    // Check if this chunk ends inside a code block — count fences in the
    // actual emitted chunk, not the max-size window, so a fence that sits
    // between the break point and maxChars doesn't flip the state.
    const codeBlockCount = (chunk.match(/```/g) || []).length;
    inCodeBlock = codeBlockCount % 2 !== 0;

    // If we're breaking inside a code block, close it
    if (inCodeBlock) {
      chunk += "\n```";
    }

    chunks.push(chunk);

    remaining = remaining.slice(consumedLength);

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
  const timeMs =
    typeof timestamp === "number" ? timestamp : timestamp.getTime();
  const date = new Date(timeMs);
  if (!Number.isFinite(date.getTime())) {
    return fallbackText || "Invalid date";
  }
  const unix = Math.floor(timeMs / 1000);
  const fallback = fallbackText || date.toISOString();
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
  const match = link.match(
    /^<((?:https?|slack|mailto|tel):[^|>]+)(?:\|[^>]*)?>$/,
  );
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
    .replace(/<((?:https?|slack|mailto|tel):[^|>]+)\|([^>]*)>/g, "$2") // Links with text → label
    .replace(/<((?:https?|slack|mailto|tel):[^>]+)>/g, "$1") // Plain links → URL
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
 * Parses a Slack message permalink.
 *
 * Prose-embedded or mrkdwn-wrapped links must be extracted before they are
 * passed in. The origin is established by `parseSlackArchivesUrl`, which both
 * this helper and `parseSlackMessageLink` share so the two cannot drift into
 * disagreeing about what counts as a Slack host.
 *
 * The returned `workspaceDomain` is a bare DNS label and so is safe to feed
 * back through `buildSlackMessagePermalink`.
 */
export function parseSlackMessagePermalink(
  link: string,
): { workspaceDomain: string; channelId: string; messageTs: string } | null {
  return parseSlackArchivesUrl(link);
}
