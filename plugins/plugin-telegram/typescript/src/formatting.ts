import type { Chat, User } from "telegraf/types";

/**
 * Options for markdown to Telegram HTML conversion
 */
export interface MarkdownToTelegramOptions {
  /** How to handle tables: 'code' wraps in code block, 'text' converts to plain text */
  tableMode?: "code" | "text" | "preserve";
  /** Whether to linkify URLs */
  linkify?: boolean;
}

/**
 * Formatted chunk with both HTML and plain text versions
 */
export interface TelegramFormattedChunk {
  html: string;
  text: string;
}

/**
 * Escapes HTML special characters
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escapes HTML attribute special characters
 */
export function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/**
 * Escapes Telegram MarkdownV2 special characters
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Converts markdown bold to Telegram HTML
 */
function convertBold(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

/**
 * Converts markdown italic to Telegram HTML
 */
function convertItalic(text: string): string {
  return text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
}

/**
 * Converts markdown underline to Telegram HTML (using __)
 */
function convertUnderline(text: string): string {
  return text.replace(/__(.+?)__/g, "<u>$1</u>");
}

/**
 * Converts markdown strikethrough to Telegram HTML
 */
function convertStrikethrough(text: string): string {
  return text.replace(/~~(.+?)~~/g, "<s>$1</s>");
}

/**
 * Converts markdown inline code to Telegram HTML
 */
function convertInlineCode(text: string): string {
  return text.replace(/`([^`\n]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);
}

/**
 * Converts markdown code blocks to Telegram HTML
 */
function convertCodeBlocks(text: string): string {
  return text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escapedCode = escapeHtml(code.trim());
    if (lang) {
      return `<pre><code class="language-${escapeHtmlAttr(lang)}">${escapedCode}</code></pre>`;
    }
    return `<pre><code>${escapedCode}</code></pre>`;
  });
}

/**
 * Converts markdown links to Telegram HTML
 */
function convertLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    const safeUrl = escapeHtmlAttr(url.trim());
    return `<a href="${safeUrl}">${escapeHtml(linkText)}</a>`;
  });
}

/**
 * Auto-linkifies URLs in text
 */
function linkifyUrls(text: string): string {
  const urlRegex = /(?<!["'])(https?:\/\/[^\s<>"']+)/g;
  return text.replace(urlRegex, (url) => {
    const safeUrl = escapeHtmlAttr(url);
    return `<a href="${safeUrl}">${escapeHtml(url)}</a>`;
  });
}

/**
 * Converts markdown to Telegram HTML format
 */
export function markdownToTelegramHtml(
  markdown: string,
  options: MarkdownToTelegramOptions = {}
): string {
  if (!markdown) {
    return "";
  }

  let result = markdown;

  // Process code blocks first (before other transformations)
  result = convertCodeBlocks(result);

  // Convert inline code (must be before other inline styles)
  result = convertInlineCode(result);

  // Convert links
  result = convertLinks(result);

  // Escape HTML in remaining text (outside of already processed elements)
  // This is tricky - we need to escape text that's not inside HTML tags
  const htmlTagPattern = /(<(?:b|i|u|s|code|pre|a)[^>]*>[\s\S]*?<\/(?:b|i|u|s|code|pre|a)>)/g;
  const parts = result.split(htmlTagPattern);
  result = parts
    .map((part, index) => {
      // Odd indices are matched HTML tags, even indices are plain text
      if (index % 2 === 0) {
        let text = escapeHtml(part);
        // Now apply markdown transformations to escaped text
        text = convertBold(text);
        text = convertItalic(text);
        text = convertUnderline(text);
        text = convertStrikethrough(text);
        if (options.linkify !== false) {
          text = linkifyUrls(text);
        }
        return text;
      }
      return part;
    })
    .join("");

  return result;
}

/**
 * Converts markdown to Telegram HTML and splits into chunks
 */
export function markdownToTelegramChunks(
  markdown: string,
  limit: number,
  options: MarkdownToTelegramOptions = {}
): TelegramFormattedChunk[] {
  const html = markdownToTelegramHtml(markdown, options);
  const chunks = chunkTelegramText(html, limit);

  return chunks.map((chunk) => ({
    html: chunk,
    text: stripHtmlTags(chunk),
  }));
}

/**
 * Converts markdown to Telegram HTML chunks (HTML only)
 */
export function markdownToTelegramHtmlChunks(markdown: string, limit: number): string[] {
  return markdownToTelegramChunks(markdown, limit).map((chunk) => chunk.html);
}

/**
 * Strips HTML tags from text
 */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

/**
 * Options for chunking Telegram text
 */
export interface ChunkTelegramTextOpts {
  /** Max characters per message. Default: 4096 */
  maxChars?: number;
  /** Preserve HTML tag boundaries when chunking */
  preserveHtml?: boolean;
}

const DEFAULT_MAX_CHARS = 4096;

/**
 * Chunks Telegram text while preserving HTML tag boundaries
 */
export function chunkTelegramText(text: string, maxChars: number = DEFAULT_MAX_CHARS): string[] {
  if (!text) {
    return [];
  }

  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point
    let breakPoint = maxChars;

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

    // Check if we're breaking inside an HTML tag
    const chunk = remaining.slice(0, breakPoint);
    const openTags = chunk.match(/<(\w+)[^>]*>/g) || [];
    const closeTags = chunk.match(/<\/(\w+)>/g) || [];

    // Track unclosed tags
    const tagStack: string[] = [];
    for (const tag of openTags) {
      const tagName = tag.match(/<(\w+)/)?.[1];
      if (tagName && !tag.endsWith("/>")) {
        tagStack.push(tagName);
      }
    }
    for (const tag of closeTags) {
      const tagName = tag.match(/<\/(\w+)>/)?.[1];
      if (tagName) {
        const index = tagStack.lastIndexOf(tagName);
        if (index !== -1) {
          tagStack.splice(index, 1);
        }
      }
    }

    // Close unclosed tags at end of chunk
    let chunkWithClosedTags = chunk;
    const closingTags = tagStack
      .slice()
      .reverse()
      .map((tag) => `</${tag}>`)
      .join("");
    chunkWithClosedTags += closingTags;

    chunks.push(chunkWithClosedTags);

    // Reopen tags at start of next chunk
    const openingTags = tagStack.map((tag) => `<${tag}>`).join("");
    remaining = openingTags + remaining.slice(breakPoint);
  }

  return chunks;
}

/**
 * Formats a Telegram user for display
 */
export function formatTelegramUser(user: User): string {
  if (user.username) {
    return `@${user.username}`;
  }
  if (user.last_name) {
    return `${user.first_name} ${user.last_name}`;
  }
  return user.first_name;
}

/**
 * Formats a Telegram user mention (HTML)
 */
export function formatTelegramUserMention(user: User): string {
  const displayName = formatTelegramUser(user);
  return `<a href="tg://user?id=${user.id}">${escapeHtml(displayName)}</a>`;
}

/**
 * Formats a Telegram chat for display
 */
export function formatTelegramChat(chat: Chat): string {
  if (chat.type === "private") {
    const privateChat = chat as Chat.PrivateChat;
    if (privateChat.username) {
      return `@${privateChat.username}`;
    }
    if (privateChat.last_name) {
      return `${privateChat.first_name} ${privateChat.last_name}`;
    }
    return privateChat.first_name || `User ${chat.id}`;
  }

  const groupChat = chat as Chat.GroupChat | Chat.SupergroupChat | Chat.ChannelChat;
  if ("username" in groupChat && groupChat.username) {
    return `@${groupChat.username}`;
  }
  return groupChat.title || `Chat ${chat.id}`;
}

/**
 * Gets the chat type as a human-readable string
 */
export function getChatTypeString(chat: Chat): string {
  switch (chat.type) {
    case "private":
      return "DM";
    case "group":
      return "Group";
    case "supergroup":
      return "Supergroup";
    case "channel":
      return "Channel";
    default:
      return "Unknown";
  }
}

/**
 * Resolves the system location string for logging/display
 */
export function resolveTelegramSystemLocation(chat: Chat): string {
  const chatType = getChatTypeString(chat);
  const chatName = formatTelegramChat(chat);
  return `${chatType}: ${chatName}`;
}

/**
 * Checks if a chat is a private chat (DM)
 */
export function isPrivateChat(chat: Chat): chat is Chat.PrivateChat {
  return chat.type === "private";
}

/**
 * Checks if a chat is a group chat
 */
export function isGroupChat(chat: Chat): chat is Chat.GroupChat | Chat.SupergroupChat {
  return chat.type === "group" || chat.type === "supergroup";
}

/**
 * Checks if a chat is a channel
 */
export function isChannelChat(chat: Chat): chat is Chat.ChannelChat {
  return chat.type === "channel";
}

/**
 * Truncates text to a maximum length with an ellipsis
 */
export function truncateText(text: string, maxLength: number, ellipsis = "…"): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - ellipsis.length) + ellipsis;
}

/**
 * Builds a Telegram deep link URL
 */
export function buildTelegramDeepLink(botUsername: string, startParam?: string): string {
  const base = `https://t.me/${botUsername}`;
  if (startParam) {
    return `${base}?start=${encodeURIComponent(startParam)}`;
  }
  return base;
}

/**
 * Builds a Telegram message link URL
 */
export function buildTelegramMessageLink(chatUsername: string, messageId: number): string {
  return `https://t.me/${chatUsername}/${messageId}`;
}

/**
 * Parses a Telegram message link URL
 */
export function parseTelegramMessageLink(
  url: string
): { chatUsername: string; messageId: number } | null {
  const match = url.match(/^https?:\/\/t\.me\/([^/]+)\/(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    chatUsername: match[1],
    messageId: parseInt(match[2], 10),
  };
}

/**
 * Formats a caption for media messages
 */
export function formatMediaCaption(text: string, maxLength: number = 1024): string {
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  // Find a good break point
  let breakPoint = maxLength - 1;
  const newlineIndex = text.lastIndexOf("\n", maxLength);
  if (newlineIndex > maxLength * 0.5) {
    breakPoint = newlineIndex;
  } else {
    const spaceIndex = text.lastIndexOf(" ", maxLength);
    if (spaceIndex > maxLength * 0.5) {
      breakPoint = spaceIndex;
    }
  }

  return `${text.slice(0, breakPoint)}…`;
}
