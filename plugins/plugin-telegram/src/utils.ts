/**
 * Text and button helpers for outbound Telegram messages: escapes and converts
 * agent Markdown to Telegram MarkdownV2 (`convertMarkdownToTelegram`) and maps a
 * `Button[]` to Telegraf inline-keyboard markup (`convertToTelegramButtons`).
 */
import { logger } from "@elizaos/core";
import type { InlineKeyboardButton } from "@telegraf/types";
import { Markup } from "telegraf";
import type { Button } from "./types";

// A list of Telegram MarkdownV2 reserved characters that must be escaped
const TELEGRAM_RESERVED_REGEX = /([_*[\]()~`>#+\-=|{}.!\\])/g;
const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Escapes plain text for Telegram MarkdownV2.
 * (Any character in 1–126 that is reserved is prefixed with a backslash.)
 */
function escapePlainText(text: string): string {
  if (!text) {
    return "";
  }
  return text.replace(TELEGRAM_RESERVED_REGEX, "\\$1");
}

/**
 * Escapes plain text line‐by–line while preserving any leading blockquote markers.
 */
function escapePlainTextPreservingBlockquote(text: string): string {
  if (!text) {
    return "";
  }
  return text
    .split("\n")
    .map((line) => {
      // If the line begins with one or more ">" (and optional space),
      // leave that part unescaped.
      const match = line.match(/^(>+\s?)(.*)$/);
      if (match) {
        return match[1] + escapePlainText(match[2]);
      }
      return escapePlainText(line);
    })
    .join("\n");
}

/**
 * Escapes code inside inline or pre-formatted code blocks.
 * Telegram requires that inside code blocks all ` and \ characters are escaped.
 */
function escapeCode(text: string): string {
  if (!text) {
    return "";
  }
  return text.replace(/([`\\])/g, "\\$1");
}

/**
 * Escapes a URL for inline links:
 * inside the URL, only ")" and "\" need to be escaped.
 */
function escapeUrl(url: string): string {
  if (!url) {
    return "";
  }
  return url.replace(/([)\\])/g, "\\$1");
}

/**
 * This function converts standard markdown to Telegram MarkdownV2.
 *
 * In addition to processing code blocks, inline code, links, bold, strikethrough, and italic,
 * it converts any header lines (those starting with one or more `#`) to bold text.
 *
 * Note: This solution uses a sequence of regex replacements and sentinels.
 * It makes assumptions about non–nested formatting and does not cover every edge case.
 */
export function convertMarkdownToTelegram(markdown: string): string {
  // Temporarily replace recognized markdown tokens with sentinel strings.
  // Each sentinel is a string like "\u0000{index}\u0000".
  const replacements: string[] = [];
  function storeReplacement(formatted: string): string {
    const sentinel = `\u0000${replacements.length}\u0000`;
    replacements.push(formatted);
    return sentinel;
  }

  let converted = markdown;

  // 1. Fenced code blocks (```...```)
  //    Matches an optional language (letters only) and then any content until the closing ```
  converted = converted.replace(
    /```(\w+)?\n([\s\S]*?)```/g,
    (_match, lang, code) => {
      const escapedCode = escapeCode(code);
      const formatted = `\`\`\`${lang || ""}\n${escapedCode}\`\`\``;
      return storeReplacement(formatted);
    },
  );

  // 2. Inline code (`...`)
  converted = converted.replace(/`([^`]+)`/g, (_match, code) => {
    const escapedCode = escapeCode(code);
    const formatted = `\`${escapedCode}\``;
    return storeReplacement(formatted);
  });

  // 3. Links: [link text](url)
  converted = converted.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, text, url) => {
      // For link text we escape as plain text.
      const formattedText = escapePlainText(text);
      const escapedURL = escapeUrl(url);
      const formatted = `[${formattedText}](${escapedURL})`;
      return storeReplacement(formatted);
    },
  );

  // 4. Bold text: standard markdown bold **text**
  //    Telegram bold is delimited by single asterisks: *text*
  converted = converted.replace(/\*\*([^*]+)\*\*/g, (_match, content) => {
    const formattedContent = escapePlainText(content);
    const formatted = `*${formattedContent}*`;
    return storeReplacement(formatted);
  });

  // 5. Strikethrough: standard markdown uses ~~text~~,
  //    while Telegram uses ~text~
  converted = converted.replace(/~~([^~]+)~~/g, (_match, content) => {
    const formattedContent = escapePlainText(content);
    const formatted = `~${formattedContent}~`;
    return storeReplacement(formatted);
  });

  // 6. Italic text:
  //    Standard markdown italic can be written as either *text* or _text_.
  //    In Telegram MarkdownV2 italic must be delimited by underscores.
  //    Process asterisk-based italic first.
  //    (Using negative lookbehind/lookahead to avoid matching bold **)
  converted = converted.replace(
    /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
    (_match, content) => {
      const formattedContent = escapePlainText(content);
      const formatted = `_${formattedContent}_`;
      return storeReplacement(formatted);
    },
  );
  //    Then underscore-based italic.
  converted = converted.replace(/_([^_\n]+)_/g, (_match, content) => {
    const formattedContent = escapePlainText(content);
    const formatted = `_${formattedContent}_`;
    return storeReplacement(formatted);
  });

  // 7. Headers: Convert markdown headers (lines starting with '#' characters)
  //    to bold text. This avoids unescaped '#' characters (which crash Telegram)
  //    by removing them and wrapping the rest of the line in bold markers.
  converted = converted.replace(
    /^(#{1,6})\s*(.*)$/gm,
    (_match, _hashes, headerContent: string) => {
      // Remove any trailing whitespace and escape the header text.
      const formatted = `*${escapePlainText(headerContent.trim())}*`;
      return storeReplacement(formatted);
    },
  );

  // Define the sentinel marker as a string constant.
  const NULL_CHAR = String.fromCharCode(0);
  const SENTINEL_PATTERN = new RegExp(`(${NULL_CHAR}\\d+${NULL_CHAR})`, "g");
  const SENTINEL_TEST = new RegExp(`^${NULL_CHAR}\\d+${NULL_CHAR}$`);
  const SENTINEL_REPLACE = new RegExp(`${NULL_CHAR}(\\d+)${NULL_CHAR}`, "g");

  const finalEscaped = converted
    .split(SENTINEL_PATTERN)
    .map((segment) => {
      // If the segment is a sentinel, leave it untouched.
      if (SENTINEL_TEST.test(segment)) {
        return segment;
      } else {
        // Otherwise, escape it while preserving any leading blockquote markers.
        return escapePlainTextPreservingBlockquote(segment);
      }
    })
    .join("");

  // Finally, substitute back all sentinels with their preformatted content.
  // Nested markdown (e.g. inline code inside bold or a header) stores a
  // sentinel *inside* a later replacement, and String.replace does not
  // re-scan replacement text — so resolve iteratively until no sentinel
  // remains. Each replacement can only reference earlier-created sentinels,
  // so this terminates in at most replacements.length passes.
  let finalResult = finalEscaped;
  for (let pass = 0; pass <= replacements.length; pass++) {
    SENTINEL_REPLACE.lastIndex = 0;
    if (!SENTINEL_REPLACE.test(finalResult)) {
      break;
    }
    SENTINEL_REPLACE.lastIndex = 0;
    finalResult = finalResult.replace(SENTINEL_REPLACE, (_, index) => {
      return replacements[Number.parseInt(index, 10)];
    });
  }

  return finalResult;
}

type MarkdownSplitToken =
  | { kind: "plain"; raw: string }
  | { kind: "escaped"; raw: string }
  | { kind: "bold"; marker: "**"; content: string }
  | { kind: "italic"; marker: "*" | "_"; content: string }
  | { kind: "strike"; marker: "~~"; content: string }
  | { kind: "inlineCode"; content: string }
  | { kind: "fence"; language: string; content: string }
  | { kind: "link"; text: string; url: string };

function convertedLength(markdown: string): number {
  return convertMarkdownToTelegram(markdown).length;
}

function tokenRaw(token: MarkdownSplitToken): string {
  switch (token.kind) {
    case "plain":
    case "escaped":
      return token.raw;
    case "bold":
      return `${token.marker}${token.content}${token.marker}`;
    case "italic":
      return `${token.marker}${token.content}${token.marker}`;
    case "strike":
      return `${token.marker}${token.content}${token.marker}`;
    case "inlineCode":
      return `\`${token.content}\``;
    case "fence":
      return `\`\`\`${token.language}\n${token.content}\`\`\``;
    case "link":
      return `[${token.text}](${token.url})`;
  }
}

function findUnescaped(text: string, needle: string, start: number): number {
  let index = text.indexOf(needle, start);
  while (index !== -1) {
    let slashCount = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
      slashCount += 1;
    }
    if (slashCount % 2 === 0) {
      return index;
    }
    index = text.indexOf(needle, index + needle.length);
  }
  return -1;
}

function tokenizeMarkdownForTelegram(markdown: string): MarkdownSplitToken[] {
  const tokens: MarkdownSplitToken[] = [];
  let plain = "";
  const flushPlain = () => {
    if (plain) {
      tokens.push({ kind: "plain", raw: plain });
      plain = "";
    }
  };

  for (let i = 0; i < markdown.length; ) {
    if (markdown[i] === "\\" && i + 1 < markdown.length) {
      flushPlain();
      tokens.push({ kind: "escaped", raw: markdown.slice(i, i + 2) });
      i += 2;
      continue;
    }

    if (markdown.startsWith("```", i)) {
      const close = markdown.indexOf("```", i + 3);
      if (close !== -1) {
        const openingLineEnd = markdown.indexOf("\n", i + 3);
        if (openingLineEnd !== -1 && openingLineEnd < close) {
          flushPlain();
          tokens.push({
            kind: "fence",
            language: markdown.slice(i + 3, openingLineEnd),
            content: markdown.slice(openingLineEnd + 1, close),
          });
          i = close + 3;
          continue;
        }
      }
    }

    if (markdown[i] === "`") {
      const close = findUnescaped(markdown, "`", i + 1);
      if (close !== -1) {
        flushPlain();
        tokens.push({
          kind: "inlineCode",
          content: markdown.slice(i + 1, close),
        });
        i = close + 1;
        continue;
      }
    }

    if (markdown[i] === "[") {
      const textEnd = findUnescaped(markdown, "](", i + 1);
      if (textEnd !== -1) {
        const urlEnd = findUnescaped(markdown, ")", textEnd + 2);
        if (urlEnd !== -1) {
          flushPlain();
          tokens.push({
            kind: "link",
            text: markdown.slice(i + 1, textEnd),
            url: markdown.slice(textEnd + 2, urlEnd),
          });
          i = urlEnd + 1;
          continue;
        }
      }
    }

    if (markdown.startsWith("**", i)) {
      const close = findUnescaped(markdown, "**", i + 2);
      if (close !== -1) {
        flushPlain();
        tokens.push({
          kind: "bold",
          marker: "**",
          content: markdown.slice(i + 2, close),
        });
        i = close + 2;
        continue;
      }
    }

    if (markdown.startsWith("~~", i)) {
      const close = findUnescaped(markdown, "~~", i + 2);
      if (close !== -1) {
        flushPlain();
        tokens.push({
          kind: "strike",
          marker: "~~",
          content: markdown.slice(i + 2, close),
        });
        i = close + 2;
        continue;
      }
    }

    if (markdown[i] === "*" && !markdown.startsWith("**", i)) {
      const close = findUnescaped(markdown, "*", i + 1);
      if (close !== -1 && !markdown.startsWith("*", close + 1)) {
        flushPlain();
        tokens.push({
          kind: "italic",
          marker: "*",
          content: markdown.slice(i + 1, close),
        });
        i = close + 1;
        continue;
      }
    }

    if (markdown[i] === "_") {
      const close = findUnescaped(markdown, "_", i + 1);
      if (close !== -1) {
        flushPlain();
        tokens.push({
          kind: "italic",
          marker: "_",
          content: markdown.slice(i + 1, close),
        });
        i = close + 1;
        continue;
      }
    }

    plain += markdown[i];
    i += 1;
  }

  flushPlain();
  return tokens;
}

function splitPlainMarkdown(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let low = 1;
    let high = remaining.length;
    let best = 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (convertedLength(remaining.slice(0, mid)) <= maxLength) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const preferred = Math.max(
      remaining.lastIndexOf("\n\n", best),
      remaining.lastIndexOf("\n", best),
      remaining.lastIndexOf(" ", best),
    );
    const splitAt = preferred > 0 ? preferred : best;
    const chunk = remaining.slice(0, splitAt).trimEnd();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

function splitWrappedMarkdown(
  content: string,
  wrap: (chunk: string) => string,
  maxLength: number,
): string[] {
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > 0) {
    let low = 1;
    let high = remaining.length;
    let best = 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (convertedLength(wrap(remaining.slice(0, mid))) <= maxLength) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const preferred = Math.max(
      remaining.lastIndexOf("\n\n", best),
      remaining.lastIndexOf("\n", best),
      remaining.lastIndexOf(" ", best),
    );
    const splitAt = preferred > 0 ? preferred : best;
    const inner = remaining.slice(0, splitAt).trimEnd();
    if (inner) {
      chunks.push(wrap(inner));
    }
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

function splitOversizedToken(
  token: MarkdownSplitToken,
  maxLength: number,
): string[] {
  switch (token.kind) {
    case "bold":
      return splitWrappedMarkdown(
        token.content,
        (chunk) => `${token.marker}${chunk}${token.marker}`,
        maxLength,
      );
    case "italic":
      return splitWrappedMarkdown(
        token.content,
        (chunk) => `${token.marker}${chunk}${token.marker}`,
        maxLength,
      );
    case "strike":
      return splitWrappedMarkdown(
        token.content,
        (chunk) => `${token.marker}${chunk}${token.marker}`,
        maxLength,
      );
    case "inlineCode":
      return splitWrappedMarkdown(
        token.content,
        (chunk) => `\`${chunk}\``,
        maxLength,
      );
    case "fence":
      return splitWrappedMarkdown(
        token.content,
        (chunk) => `\`\`\`${token.language}\n${chunk}\`\`\``,
        maxLength,
      );
    case "link": {
      const wrapped = splitWrappedMarkdown(
        token.text,
        (chunk) => `[${chunk}](${token.url})`,
        maxLength,
      );
      if (wrapped.length > 0) {
        return wrapped;
      }
      return splitPlainMarkdown(tokenRaw(token), maxLength);
    }
    case "plain":
    case "escaped":
      return splitPlainMarkdown(token.raw, maxLength);
  }
}

/**
 * Splits source Markdown only at boundaries that remain valid after Telegram
 * MarkdownV2 conversion. Oversized formatting spans are reopened in each output
 * chunk so callers can convert every chunk independently before sending.
 */
export function splitMarkdownForTelegram(
  markdown: string,
  maxLength = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  if (!markdown) {
    return [];
  }
  if (convertedLength(markdown) <= maxLength) {
    return [markdown];
  }

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    current = "";
  };

  for (const token of tokenizeMarkdownForTelegram(markdown)) {
    const raw = tokenRaw(token);
    if (convertedLength(raw) > maxLength) {
      flush();
      for (const piece of splitOversizedToken(token, maxLength)) {
        if (piece && convertedLength(piece) <= maxLength) {
          chunks.push(piece);
        }
      }
      continue;
    }

    const next = current ? `${current}${raw}` : raw;
    if (convertedLength(next) <= maxLength) {
      current = next;
      continue;
    }

    flush();
    current = raw;
  }

  flush();

  return chunks.filter(
    (chunk) => chunk.length > 0 && convertedLength(chunk) <= maxLength,
  );
}

/**
 * Converts Eliza buttons into Telegram buttons
 * @param {Button[]} buttons - The buttons from Eliza content
 * @returns {InlineKeyboardButton[]} Array of Telegram buttons
 */
export function convertToTelegramButtons(
  buttons?: Button[] | null,
): InlineKeyboardButton[] {
  if (!buttons) {
    return [];
  }
  const telegramButtons: InlineKeyboardButton[] = [];

  for (const button of buttons) {
    // Validate button has required properties
    if (!button.text || !button.url) {
      logger.warn(
        { src: "plugin:telegram", button },
        "Invalid button configuration, skipping",
      );
      continue;
    }

    let telegramButton: InlineKeyboardButton;
    switch (button.kind) {
      case "login":
        telegramButton = Markup.button.login(button.text, button.url);
        break;
      case "url":
        telegramButton = Markup.button.url(button.text, button.url);
        break;
      case "web_app":
        telegramButton = {
          text: button.text,
          web_app: { url: button.url },
        };
        break;
      default:
        logger.warn(
          { src: "plugin:telegram", buttonKind: button.kind },
          "Unknown button kind, treating as URL button",
        );
        telegramButton = Markup.button.url(button.text, button.url);
        break;
    }

    telegramButtons.push(telegramButton);
  }

  return telegramButtons;
}

/**
 * Clean text by removing all NULL (\u0000) characters
 * @param {string | undefined | null} text - The text to clean
 * @returns {string} The cleaned text
 */
export function cleanText(text: string | undefined | null): string {
  if (!text) {
    return "";
  }
  // Avoid control char in regex literal; lint-friendly
  return text.split("\u0000").join("");
}
