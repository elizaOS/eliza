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
import {
  ElizaError,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
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

/** Slack splits `<url|label>` on the first raw pipe, so a pipe in the URL must be encoded. */
function escapeSlackLinkUrl(url: string): string {
  return escapeSlackMrkdwnSegment(url.replaceAll("|", "%7C"));
}

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

  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const tokenStart = text.indexOf("<", cursor);
    if (tokenStart < 0) break;
    out.push(escapeSlackMrkdwnSegment(text.slice(cursor, tokenStart)));
    const lineEnd = text.indexOf("\n", tokenStart + 1);
    const tokenEnd = text.indexOf(">", tokenStart + 1);
    if (tokenEnd < 0 || (lineEnd >= 0 && lineEnd < tokenEnd)) {
      const plainEnd = lineEnd < 0 ? text.length : lineEnd + 1;
      out.push(escapeSlackMrkdwnSegment(text.slice(tokenStart, plainEnd)));
      cursor = plainEnd;
      continue;
    }
    const token = text.slice(tokenStart, tokenEnd + 1);
    out.push(
      isAllowedSlackAngleToken(token) ? token : escapeSlackMrkdwnSegment(token),
    );
    cursor = tokenEnd + 1;
  }

  out.push(escapeSlackMrkdwnSegment(text.slice(cursor)));
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
      // Slack accepts a leading quote marker without a following space.
      // Preserve the marker run and escape only the content that follows it.
      const marker = /^>+/.exec(line)?.[0];
      if (marker) {
        return `${marker}${escapeSlackMrkdwnContent(line.slice(marker.length))}`;
      }
      return escapeSlackMrkdwnContent(line);
    })
    .join("\n");
}

// Both sentinels are delimited by a control character, and both delimiters are
// stripped from the input at entry, so caller text can never forge either one.
//
// They use DIFFERENT delimiters deliberately. Sharing one meant `convertItalic`'s
// global BOLD_SENTINEL -> "*" replace could match ACROSS a code token's closing
// delimiter whenever the literal word "BOLD" sat between them. The code token was
// eaten, its body never came back, and a raw control character reached Slack --
// "```\nkeep me\n```BOLD**z**" lost the whole code body that way.
const BOLD_DELIM = "\u0000";
const CODE_DELIM = "\u0001";

// Sentinel used during conversion to prevent bold from being matched as italic.
const BOLD_SENTINEL = `${BOLD_DELIM}BOLD${BOLD_DELIM}`;
// Fenced bodies are lifted out behind this sentinel before the link/heading/
// style passes run, because those passes are regex-based and cannot see fence
// state: a `# comment` line became bold, `a * b` became `a _ b`, and a literal
// `[text](url)` became a Slack link. The sibling Telegram converter
// (plugins/plugin-telegram/src/utils.ts) already substitutes code this way.
const CODE_SENTINEL_PREFIX = `${CODE_DELIM}CODE`;
const CODE_SENTINEL_SUFFIX = CODE_DELIM;

/**
 * Drops the control characters the sentinels are built from. Slack renders
 * neither, so nothing the sender can see is lost, and no text arriving from a
 * tool, a user, or an echoed document can forge a sentinel.
 */
function stripSentinelDelimiters(text: string): string {
  if (!text.includes(BOLD_DELIM) && !text.includes(CODE_DELIM)) {
    return text;
  }
  return text.split(BOLD_DELIM).join("").split(CODE_DELIM).join("");
}

/**
 * Converts markdown bold to Slack mrkdwn
 * Uses a sentinel to prevent bold from being matched by italic converter
 */
function convertBold(text: string): string {
  // ***x*** is bold italic; read as **(*x)** it leaves a stray * that the
  // italic step pairs across the bold marker (`*_x*_`).
  return text
    .replace(
      /\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g,
      `${BOLD_SENTINEL}_$1_${BOLD_SENTINEL}`,
    )
    .replace(/\*\*(.+?)\*\*/g, `${BOLD_SENTINEL}$1${BOLD_SENTINEL}`);
}

/**
 * Converts markdown italic to Slack mrkdwn
 */
function convertItalic(text: string): string {
  // Markdown uses single * for italic, Slack uses _.
  // A * followed by whitespace cannot open italic, and one preceded by
  // whitespace cannot close it, so "2 * 3 * 4" stays literal.
  // Slack mrkdwn has no backslash escape. An unpaired * already renders
  // literally, so do not prefix leftovers with \.
  const converted = text.replace(
    /(?<!\*)\*(?!\*)(?!\s)(.+?)(?<!\s)(?<!\*)\*(?!\*)/g,
    "_$1_",
  );
  return converted.replaceAll(BOLD_SENTINEL, "*");
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
function convertCodeBlocks(text: string, codeSink: string[]): string {
  // Slack code blocks don't support language hints in the same way
  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const opener = text.indexOf("```", cursor);
    if (opener < 0) break;
    const afterOpener = opener + 3;
    const closerAt = text.indexOf("```", afterOpener);
    // Limit the search to this fence so repeated one-line blocks are linear.
    const newlineAt = text
      .slice(afterOpener, closerAt < 0 ? undefined : closerAt)
      .indexOf("\n");
    // The info string is the whole opening line when a newline arrives before
    // the closer. Scanning only [A-Za-z0-9_] left the rest of `c++`, `c#`,
    // and `objective-c` in the body, and a one-line ```x``` was eaten as a
    // language tag so the copied fence was empty.
    const bodyStart =
      newlineAt >= 0 ? afterOpener + newlineAt + 1 : afterOpener;
    const closer = text.indexOf("```", bodyStart);
    if (closer < 0) {
      // An unmatched opener is what a truncated or streamed message produces,
      // and the rest of it is still code the user reads and copies. Pushing it
      // raw left every style pass on it, so a `#` comment came out bold and a
      // markdown link became a Slack link -- the corruption this whole change
      // exists to stop. Hold it aside like a closed body. No closer is
      // invented: the output keeps the input's fence parity.
      const tailToken = `${CODE_SENTINEL_PREFIX}${codeSink.length}${CODE_SENTINEL_SUFFIX}`;
      codeSink.push(
        `\`\`\`\n${escapeSlackMrkdwnSegment(text.slice(bodyStart))}`,
      );
      out.push(text.slice(cursor, opener), tailToken);
      cursor = text.length;
      break;
    }
    // Escape the body here: `escapeSlackMrkdwn` runs after restoration and can
    // no longer reach it, but Slack still renders raw &, < and > inside a fence.
    const token = `${CODE_SENTINEL_PREFIX}${codeSink.length}${CODE_SENTINEL_SUFFIX}`;
    codeSink.push(
      `\`\`\`\n${escapeSlackMrkdwnSegment(text.slice(bodyStart, closer))}\`\`\``,
    );
    out.push(text.slice(cursor, opener), token);
    cursor = closer + 3;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

/** Holds `body` aside until `restoreCodeBlocks` and returns its sentinel. */
function holdAside(body: string, codeSink: string[]): string {
  codeSink.push(body);
  return `${CODE_SENTINEL_PREFIX}${codeSink.length - 1}${CODE_SENTINEL_SUFFIX}`;
}

/**
 * Converts markdown links to Slack mrkdwn links. The finished token is held
 * aside so the style passes cannot rewrite `*` in its URL (`a*b*c` became
 * `a_b_c`, a different address); the label gets the style passes here.
 */
/**
 * A held-aside link token skips escapeSlackMrkdwn, so it must pass the same
 * scheme allowlist here: javascript:, data:, file:, relative URLs and tokens
 * spanning a newline come out escaped as plain text.
 */
function guardLinkToken(token: string): string {
  return isAllowedSlackAngleToken(token) && !token.includes("\n")
    ? token
    : escapeSlackMrkdwnSegment(token);
}

function convertLinks(text: string, codeSink: string[]): string {
  // The URL group tolerates one level of balanced parentheses, as the
  // Telegram converter does: a plain [^)]+ capture cuts a Wikipedia-style
  // URL at its inner closing paren and leaves a malformed link token.
  return text.replace(
    /\[([^\]]+)\]\(((?:[^()]|\([^()]*\))+)\)/g,
    (_, linkText, url) => {
      const trimmedUrl = url.trim();
      const trimmedText = linkText.trim();
      // If link text matches URL, just use URL
      if (
        trimmedText === trimmedUrl ||
        trimmedText === trimmedUrl.replace(/^mailto:/, "")
      ) {
        return holdAside(
          guardLinkToken(`<${escapeSlackLinkUrl(trimmedUrl)}>`),
          codeSink,
        );
      }
      const label = convertStrikethrough(
        convertItalic(convertBold(escapeSlackMrkdwnSegment(trimmedText))),
      );
      return holdAside(
        guardLinkToken(`<${escapeSlackLinkUrl(trimmedUrl)}|${label}>`),
        codeSink,
      );
    },
  );
}

/**
 * Holds inline code spans aside like fenced bodies, so the style passes leave
 * `a*b*c` and `**kwargs` as written. A span never takes in a held sentinel.
 */
function convertInlineCode(text: string, codeSink: string[]): string {
  return text.replace(new RegExp(`\`[^\`\n${CODE_DELIM}]+\``, "g"), (span) =>
    holdAside(escapeSlackMrkdwnSegment(span), codeSink),
  );
}

/**
 * Converts markdown headings to Slack mrkdwn (bold text)
 * Uses a sentinel to prevent headings from being matched by italic converter
 */
function convertHeadings(text: string): string {
  return text.replace(/^#{1,6}\s+(.+)$/gm, (_match, content: string) => {
    // A heading is one Slack bold span. Leaving ** inside that span lets the
    // later bold pass insert more asterisks, so "## **Bold** header" is sent
    // as "**Bold* header*".
    const flattened = content.replace(/\*\*(.+?)\*\*/g, "$1");
    return `${BOLD_SENTINEL}${flattened}${BOLD_SENTINEL}`;
  });
}

/**
 * Puts the held-aside fenced bodies back, after every style pass has run.
 */
function restoreCodeBlocks(text: string, codeSink: string[]): string {
  if (codeSink.length === 0) return text;
  // Single left-to-right pass: a restored body is never rescanned, so a body
  // that happens to contain a later sentinel cannot splice that block into it.
  // (An indexOf scan rather than a regex: biome rejects a control character
  // inside a regex literal via lint/suspicious/noControlCharactersInRegex.)
  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(CODE_SENTINEL_PREFIX, cursor);
    if (start < 0) break;
    const digitsStart = start + CODE_SENTINEL_PREFIX.length;
    const end = text.indexOf(CODE_SENTINEL_SUFFIX, digitsStart);
    if (end < 0) break;
    const digits = text.slice(digitsStart, end);
    const body = /^[0-9]+$/.test(digits) ? codeSink[Number(digits)] : undefined;
    out.push(text.slice(cursor, start), body ?? text.slice(start, end + 1));
    cursor = end + 1;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

/**
 * Converts markdown to Slack mrkdwn format
 */
export function markdownToSlackMrkdwn(markdown: string): string {
  if (!markdown) {
    return "";
  }

  // Process in order: code blocks -> links -> inline code -> headings -> text
  // styles -> escape. Fenced bodies, links, and inline code are held aside for
  // the whole pipeline and restored last.
  const codeSink: string[] = [];
  let result = convertCodeBlocks(stripSentinelDelimiters(markdown), codeSink);
  result = convertLinks(result, codeSink);
  result = convertInlineCode(result, codeSink);
  result = convertHeadings(result);
  result = convertBold(result);
  result = convertItalic(result);
  result = convertStrikethrough(result);
  result = escapeSlackMrkdwn(result);
  result = restoreCodeBlocks(result, codeSink);

  return result;
}

/**
 * Options for chunking Slack text
 */
export interface ChunkSlackTextOpts {
  /** Max characters per message. Default: Slack's 40,000-character hard limit. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 40_000;
const REOPEN_FENCE = "```\n";

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
  reason = "cannot hold the next well-formed character without splitting a surrogate pair",
): never {
  throw new ElizaError(
    `${fnName}: a chunk limit of ${effectiveLimit} (from maxChars=${maxChars}) ${reason}`,
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
  let reopenedFence = false;

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

    // Cutting through a ``` marker would leave "`" and "``" fragments that no
    // longer count as fences, so the code-block state below would be wrong.
    const straddledFence = fenceStraddling(remaining, breakPoint);
    if (straddledFence > 0) {
      breakPoint = straddledFence;
    }

    // truncateWellFormed backs the cut off by one unit instead of splitting a
    // surrogate pair; consumedLength (not breakPoint) is how far `remaining`
    // must advance, since the fence suffix appended below isn't part of it.
    let chunk = truncateWellFormed(remaining, breakPoint);
    if (chunk.length === 0) {
      chunkLimitTooSmall("chunkSlackText", breakPoint, maxChars);
    }
    let consumedLength = chunk.length;
    if (reopenedFence && consumedLength <= REOPEN_FENCE.length) {
      chunkLimitTooSmall(
        "chunkSlackText",
        breakPoint,
        maxChars,
        "cannot hold a reopened code fence plus any of the code inside it",
      );
    }

    // Check if this chunk ends inside a code block — count fences in the
    // actual emitted chunk, not the max-size window, so a fence that sits
    // between the break point and maxChars doesn't flip the state.
    const codeBlockCount = (chunk.match(/```/g) || []).length;
    inCodeBlock = codeBlockCount % 2 !== 0;

    // A block whose opener is followed only by whitespace in this chunk would
    // be sent as an empty code block. Start it in the next chunk instead, or,
    // when the chunk itself starts at the opener, skip that whitespace.
    let emitChunk = true;
    if (inCodeBlock) {
      const opener = chunk.lastIndexOf("```");
      if (chunk.slice(opener + 3).trim() === "") {
        if (opener === 0) {
          emitChunk = consumedLength <= REOPEN_FENCE.length;
        } else if (chunk.slice(0, opener).trim() === "") {
          remaining = remaining.slice(opener);
          reopenedFence = false;
          continue;
        } else {
          chunk = chunk.slice(0, opener);
          consumedLength = opener;
          inCodeBlock = false;
        }
      }
    }

    if (emitChunk) {
      // If we're breaking inside a code block, close it
      if (inCodeBlock) {
        chunk += "\n```";
      }
      chunks.push(chunk);
    }

    remaining = remaining.slice(consumedLength);

    // If we were in a code block, reopen it — unless only whitespace and the
    // block's own closer are left, which would be sent as an empty code block.
    if (inCodeBlock) {
      const closer = remaining.match(/^\s*(?:```|$)/);
      reopenedFence = !closer;
      remaining = closer
        ? remaining
            .slice(closer[0].length)
            .replace(/^\r?\n/, "")
            .replace(/^\s+$/, "")
        : `${REOPEN_FENCE}${remaining}`;
    } else {
      reopenedFence = false;
    }
  }

  return chunks;
}

function fenceStraddling(text: string, index: number): number {
  for (let start = index - 2; start < index; start++) {
    if (start >= 0 && text.startsWith("```", start)) {
      return start;
    }
  }
  return -1;
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
  const safeUrl = escapeSlackLinkUrl(url);
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
  const wellFormed = toWellFormedUnicode(text);
  if (wellFormed.length <= maxLength) {
    return wellFormed;
  }
  const boundedEllipsis = truncateWellFormed(
    toWellFormedUnicode(ellipsis),
    maxLength,
  );
  const budget = Math.max(0, maxLength - boundedEllipsis.length);
  return `${truncateWellFormed(wellFormed, budget)}${boundedEllipsis}`;
}

/**
 * Strips Slack mrkdwn formatting from text
 */
export function stripSlackFormatting(text: string): string {
  const withoutMarkup = text
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
    .replace(/<((?:https?|slack|mailto|tel):[^>]+)>/g, "$1"); // Plain links → URL
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">" };
  return withoutMarkup
    .replace(
      /&(amp|lt|gt);/g,
      (entity, name: string) => entities[name] ?? entity,
    )
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
