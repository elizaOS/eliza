/**
 * LINE text chunk limit (API supports 5000 characters per message)
 */
export const LINE_TEXT_CHUNK_LIMIT = 5000;

/**
 * LINE max messages per reply (API supports up to 5 messages in a reply)
 */
export const LINE_MAX_REPLY_MESSAGES = 5;

/**
 * Represents a markdown table extracted from text
 */
export interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

/**
 * Represents a code block extracted from text
 */
export interface CodeBlock {
  language?: string;
  code: string;
}

/**
 * Represents a markdown link
 */
export interface MarkdownLink {
  text: string;
  url: string;
}

/**
 * Result of processing text for LINE
 */
export interface ProcessedLineMessage {
  text: string;
  tables: MarkdownTable[];
  codeBlocks: CodeBlock[];
  links: MarkdownLink[];
}

/**
 * Options for text chunking
 */
export interface ChunkLineTextOpts {
  limit?: number;
  preserveCodeBlocks?: boolean;
}

/**
 * Regex patterns for markdown detection
 */
const MARKDOWN_TABLE_REGEX = /^\|(.+)\|[\r\n]+\|[-:\s|]+\|[\r\n]+((?:\|.+\|[\r\n]*)+)/gm;
const MARKDOWN_CODE_BLOCK_REGEX = /```(\w*)\n([\s\S]*?)```/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Parses a single table row (pipe-separated values)
 */
function parseTableRow(row: string): string[] {
  return row
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell, index, arr) => {
      // Filter out empty cells at start/end (from leading/trailing pipes)
      if (index === 0 && cell === "") {
        return false;
      }
      if (index === arr.length - 1 && cell === "") {
        return false;
      }
      return true;
    });
}

/**
 * Extracts markdown tables from text
 */
export function extractMarkdownTables(text: string): {
  tables: MarkdownTable[];
  textWithoutTables: string;
} {
  const tables: MarkdownTable[] = [];
  let textWithoutTables = text;

  // Reset regex state
  MARKDOWN_TABLE_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  const matches: { fullMatch: string; table: MarkdownTable }[] = [];

  match = MARKDOWN_TABLE_REGEX.exec(text);
  while (match !== null) {
    const fullMatch = match[0];
    const headerLine = match[1];
    const bodyLines = match[2];

    const headers = parseTableRow(headerLine);
    const rows = bodyLines
      .trim()
      .split(/[\r\n]+/)
      .filter((line) => line.trim())
      .map(parseTableRow);

    if (headers.length > 0 && rows.length > 0) {
      matches.push({
        fullMatch,
        table: { headers, rows },
      });
    }

    match = MARKDOWN_TABLE_REGEX.exec(text);
  }

  // Remove tables from text in reverse order to preserve indices
  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, table } = matches[i];
    tables.unshift(table);
    textWithoutTables = textWithoutTables.replace(fullMatch, "");
  }

  return { tables, textWithoutTables };
}

/**
 * Extracts code blocks from text
 */
export function extractCodeBlocks(text: string): {
  codeBlocks: CodeBlock[];
  textWithoutCode: string;
} {
  const codeBlocks: CodeBlock[] = [];
  let textWithoutCode = text;

  // Reset regex state
  MARKDOWN_CODE_BLOCK_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  const matches: { fullMatch: string; block: CodeBlock }[] = [];

  match = MARKDOWN_CODE_BLOCK_REGEX.exec(text);
  while (match !== null) {
    const fullMatch = match[0];
    const language = match[1] || undefined;
    const code = match[2];

    matches.push({
      fullMatch,
      block: { language, code: code.trim() },
    });

    match = MARKDOWN_CODE_BLOCK_REGEX.exec(text);
  }

  // Remove code blocks in reverse order
  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, block } = matches[i];
    codeBlocks.unshift(block);
    textWithoutCode = textWithoutCode.replace(fullMatch, "");
  }

  return { codeBlocks, textWithoutCode };
}

/**
 * Extracts markdown links from text
 */
export function extractLinks(text: string): {
  links: MarkdownLink[];
  textWithLinks: string;
} {
  const links: MarkdownLink[] = [];

  // Reset regex state
  MARKDOWN_LINK_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  match = MARKDOWN_LINK_REGEX.exec(text);
  while (match !== null) {
    links.push({
      text: match[1],
      url: match[2],
    });

    match = MARKDOWN_LINK_REGEX.exec(text);
  }

  // Replace markdown links with just the text (for plain text output)
  const textWithLinks = text.replace(MARKDOWN_LINK_REGEX, "$1");

  return { links, textWithLinks };
}

/**
 * Strips markdown formatting from text
 */
export function stripMarkdown(text: string): string {
  let result = text;

  // Remove bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/__(.+?)__/g, "$1");

  // Remove italic: *text* or _text_ (but not already processed)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "$1");

  // Remove strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "$1");

  // Remove headers: # Title, ## Title, etc.
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // Remove blockquotes: > text
  result = result.replace(/^>\s?(.*)$/gm, "$1");

  // Remove horizontal rules: ---, ***, ___
  result = result.replace(/^[-*_]{3,}$/gm, "");

  // Remove inline code: `code`
  result = result.replace(/`([^`]+)`/g, "$1");

  // Clean up extra whitespace
  result = result.replace(/\n{3,}/g, "\n\n");
  result = result.trim();

  return result;
}

/**
 * Checks if text contains markdown that needs conversion
 */
export function hasMarkdownContent(text: string): boolean {
  // Check for tables
  MARKDOWN_TABLE_REGEX.lastIndex = 0;
  if (MARKDOWN_TABLE_REGEX.test(text)) {
    return true;
  }

  // Check for code blocks
  MARKDOWN_CODE_BLOCK_REGEX.lastIndex = 0;
  if (MARKDOWN_CODE_BLOCK_REGEX.test(text)) {
    return true;
  }

  // Check for other markdown patterns
  if (/\*\*[^*]+\*\*/.test(text)) {
    return true;
  }
  if (/~~[^~]+~~/.test(text)) {
    return true;
  }
  if (/^#{1,6}\s+/m.test(text)) {
    return true;
  }
  if (/^>\s+/m.test(text)) {
    return true;
  }

  return false;
}

/**
 * Processes text for LINE output
 */
export function processLineMessage(text: string): ProcessedLineMessage {
  let processedText = text;

  // Extract tables
  const { tables, textWithoutTables } = extractMarkdownTables(processedText);
  processedText = textWithoutTables;

  // Extract code blocks
  const { codeBlocks, textWithoutCode } = extractCodeBlocks(processedText);
  processedText = textWithoutCode;

  // Handle links
  const { links, textWithLinks } = extractLinks(processedText);
  processedText = textWithLinks;

  // Strip remaining markdown formatting
  processedText = stripMarkdown(processedText);

  return {
    text: processedText,
    tables,
    codeBlocks,
    links,
  };
}

/**
 * Splits text at the last safe break point within the limit
 */
function splitAtBreakPoint(text: string, limit: number): { chunk: string; remainder: string } {
  if (text.length <= limit) {
    return { chunk: text, remainder: "" };
  }

  // Try to find a natural break point
  const searchArea = text.slice(0, limit);

  // Prefer double newlines (paragraph breaks)
  const doubleNewline = searchArea.lastIndexOf("\n\n");
  if (doubleNewline > limit * 0.5) {
    return {
      chunk: text.slice(0, doubleNewline).trimEnd(),
      remainder: text.slice(doubleNewline + 2).trimStart(),
    };
  }

  // Try single newlines
  const singleNewline = searchArea.lastIndexOf("\n");
  if (singleNewline > limit * 0.5) {
    return {
      chunk: text.slice(0, singleNewline).trimEnd(),
      remainder: text.slice(singleNewline + 1).trimStart(),
    };
  }

  // Try sentence boundaries
  const sentenceEnd = Math.max(
    searchArea.lastIndexOf(". "),
    searchArea.lastIndexOf("! "),
    searchArea.lastIndexOf("? ")
  );
  if (sentenceEnd > limit * 0.5) {
    return {
      chunk: text.slice(0, sentenceEnd + 1).trimEnd(),
      remainder: text.slice(sentenceEnd + 2).trimStart(),
    };
  }

  // Try word boundaries
  const space = searchArea.lastIndexOf(" ");
  if (space > limit * 0.5) {
    return {
      chunk: text.slice(0, space).trimEnd(),
      remainder: text.slice(space + 1).trimStart(),
    };
  }

  // Hard break at limit
  return {
    chunk: text.slice(0, limit),
    remainder: text.slice(limit),
  };
}

/**
 * Chunks text for LINE messages
 */
export function chunkLineText(text: string, opts: ChunkLineTextOpts = {}): string[] {
  const limit = opts.limit ?? LINE_TEXT_CHUNK_LIMIT;

  if (!text?.trim()) {
    return [];
  }

  const normalizedText = text.trim();
  if (normalizedText.length <= limit) {
    return [normalizedText];
  }

  const chunks: string[] = [];
  let remaining = normalizedText;

  while (remaining.length > 0) {
    const { chunk, remainder } = splitAtBreakPoint(remaining, limit);
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remainder;
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Processes and chunks a markdown message for LINE
 */
export function markdownToLineChunks(
  markdown: string,
  opts: ChunkLineTextOpts = {}
): {
  textChunks: string[];
  tables: MarkdownTable[];
  codeBlocks: CodeBlock[];
  links: MarkdownLink[];
} {
  const processed = processLineMessage(markdown);
  const textChunks = chunkLineText(processed.text, opts);

  return {
    textChunks,
    tables: processed.tables,
    codeBlocks: processed.codeBlocks,
    links: processed.links,
  };
}

/**
 * Formats a table as plain text
 */
export function formatTableAsText(table: MarkdownTable): string {
  const lines: string[] = [];

  // Header
  lines.push(table.headers.join(" | "));
  lines.push("-".repeat(lines[0].length));

  // Rows
  for (const row of table.rows) {
    lines.push(row.join(" | "));
  }

  return lines.join("\n");
}

/**
 * Formats a code block as plain text
 */
export function formatCodeBlockAsText(block: CodeBlock): string {
  const langLabel = block.language ? `[${block.language}]` : "[code]";
  return `${langLabel}\n${block.code}`;
}

/**
 * Truncates text to a maximum length with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= 3) {
    return "...".slice(0, maxLength);
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * Formats a LINE user display name
 */
export function formatLineUser(displayName: string, userId: string): string {
  return displayName || `User(${userId.slice(0, 8)}...)`;
}

/**
 * Builds a LINE deep link URL
 */
export function buildLineDeepLink(_type: "user" | "group" | "room", id: string): string {
  return `line://ti/p/${id}`;
}

/**
 * Resolves the system location string for logging
 */
export function resolveLineSystemLocation(params: {
  chatType: "user" | "group" | "room";
  chatId: string;
  chatName?: string;
}): string {
  const { chatType, chatId, chatName } = params;
  const name = chatName || chatId.slice(0, 8);
  return `LINE ${chatType}:${name}`;
}

/**
 * Checks if a chat is a group chat
 */
export function isGroupChat(params: { groupId?: string; roomId?: string }): boolean {
  return Boolean(params.groupId || params.roomId);
}

/**
 * Gets the chat ID from context
 */
export function getChatId(params: { userId: string; groupId?: string; roomId?: string }): string {
  return params.groupId || params.roomId || params.userId;
}

/**
 * Gets the chat type from context
 */
export function getChatType(params: {
  groupId?: string;
  roomId?: string;
}): "user" | "group" | "room" {
  if (params.groupId) {
    return "group";
  }
  if (params.roomId) {
    return "room";
  }
  return "user";
}
