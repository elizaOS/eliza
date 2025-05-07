import { Markup } from 'telegraf';
import { InlineKeyboardButton } from '@telegraf/types';
import { Button } from './types';

// A list of Telegram MarkdownV2 reserved characters that must be escaped
const TELEGRAM_RESERVED_REGEX = /([_*[\]()~`>#+\-=|{}.!\\])/g;

/**
 * Escapes plain text for Telegram MarkdownV2.
 * (Any character in 1–126 that is reserved is prefixed with a backslash.)
 */
function escapePlainText(text: string): string {
  return text.replace(TELEGRAM_RESERVED_REGEX, '\\$1');
}

/**
 * Escapes plain text line‐by–line while preserving any leading blockquote markers.
 */
function escapePlainTextPreservingBlockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      // If the line begins with one or more ">" (and optional space),
      // leave that part unescaped.
      const match = line.match(/^(>+\s?)(.*)$/);
      if (match) {
        return match[1] + escapePlainText(match[2]);
      }
      return escapePlainText(line);
    })
    .join('\n');
}

/**
 * Escapes code inside inline or pre-formatted code blocks.
 * Telegram requires that inside code blocks all ` and \ characters are escaped.
 */
function escapeCode(text: string): string {
  return text.replace(/([`\\])/g, '\\$1');
}

/**
 * Escapes a URL for inline links:
 * inside the URL, only ")" and "\" need to be escaped.
 */
function escapeUrl(url: string): string {
  return url.replace(/([)\\])/g, '\\$1');
}

/**
 * This function converts standard markdown to Telegram MarkdownV2.
 *
 * In addition to processing code blocks, inline code, links, bold, strikethrough, and italic,
 * it converts any header lines (those starting with one or more `#`) to bold text.
 *
 * Note: This solution uses a sequence of regex‐replacements and placeholders.
 * It makes assumptions about non–nested formatting and does not cover every edge case.
 */
export function convertMarkdownToTelegram(markdown: string): string {
  // We will temporarily replace recognized markdown tokens with placeholders.
  // Each placeholder is a string like "\u0000{index}\u0000".
  const replacements: string[] = [];
  function storeReplacement(formatted: string): string {
    const placeholder = `\u0000${replacements.length}\u0000`;
    replacements.push(formatted);
    return placeholder;
  }

  let converted = markdown;

  // 1. Fenced code blocks (```...```)
  //    Matches an optional language (letters only) and then any content until the closing ```
  converted = converted.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    const escapedCode = escapeCode(code);
    const formatted = '```' + (lang || '') + '\n' + escapedCode + '```';
    return storeReplacement(formatted);
  });

  // 2. Inline code (`...`)
  converted = converted.replace(/`([^`]+)`/g, (match, code) => {
    const escapedCode = escapeCode(code);
    const formatted = '`' + escapedCode + '`';
    return storeReplacement(formatted);
  });

  // 3. Links: [link text](url)
  converted = converted.replace(
    /$begin:math:display$([^$end:math:display$]+)]$begin:math:text$([^)]+)$end:math:text$/g,
    (match, text, url) => {
      // For link text we escape as plain text.
      const formattedText = escapePlainText(text);
      const escapedURL = escapeUrl(url);
      const formatted = `[${formattedText}](${escapedURL})`;
      return storeReplacement(formatted);
    }
  );

  // 4. Bold text: standard markdown bold **text**
  //    Telegram bold is delimited by single asterisks: *text*
  converted = converted.replace(/\*\*([^*]+)\*\*/g, (match, content) => {
    const formattedContent = escapePlainText(content);
    const formatted = `*${formattedContent}*`;
    return storeReplacement(formatted);
  });

  // 5. Strikethrough: standard markdown uses ~~text~~,
  //    while Telegram uses ~text~
  converted = converted.replace(/~~([^~]+)~~/g, (match, content) => {
    const formattedContent = escapePlainText(content);
    const formatted = `~${formattedContent}~`;
    return storeReplacement(formatted);
  });

  // 6. Italic text:
  //    Standard markdown italic can be written as either *text* or _text_.
  //    In Telegram MarkdownV2 italic must be delimited by underscores.
  //    Process asterisk-based italic first.
  //    (Using negative lookbehind/lookahead to avoid matching bold **)
  converted = converted.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (match, content) => {
    const formattedContent = escapePlainText(content);
    const formatted = `_${formattedContent}_`;
    return storeReplacement(formatted);
  });
  //    Then underscore-based italic.
  converted = converted.replace(/_([^_\n]+)_/g, (match, content) => {
    const formattedContent = escapePlainText(content);
    const formatted = `_${formattedContent}_`;
    return storeReplacement(formatted);
  });

  // 7. Headers: Convert markdown headers (lines starting with '#' characters)
  //    to bold text. This avoids unescaped '#' characters (which crash Telegram)
  //    by removing them and wrapping the rest of the line in bold markers.
  converted = converted.replace(/^(#{1,6})\s*(.*)$/gm, (match, hashes, headerContent: string) => {
    // Remove any trailing whitespace and escape the header text.
    const formatted = `*${escapePlainText(headerContent.trim())}*`;
    return storeReplacement(formatted);
  });

  // Define the placeholder marker as a string constant
  const NULL_CHAR = String.fromCharCode(0);
  const PLACEHOLDER_PATTERN = new RegExp(`(${NULL_CHAR}\\d+${NULL_CHAR})`, 'g');
  const PLACEHOLDER_TEST = new RegExp(`^${NULL_CHAR}\\d+${NULL_CHAR}$`);
  const PLACEHOLDER_REPLACE = new RegExp(`${NULL_CHAR}(\\d+)${NULL_CHAR}`, 'g');

  const finalEscaped = converted
    .split(PLACEHOLDER_PATTERN)
    .map((segment) => {
      // If the segment is a placeholder (matches the pattern), leave it untouched.
      if (PLACEHOLDER_TEST.test(segment)) {
        return segment;
      } else {
        // Otherwise, escape it while preserving any leading blockquote markers.
        return escapePlainTextPreservingBlockquote(segment);
      }
    })
    .join('');

  // Finally, substitute back all placeholders with their preformatted content.
  const finalResult = finalEscaped.replace(PLACEHOLDER_REPLACE, (_, index) => {
    return replacements[parseInt(index)];
  });

  return finalResult;
}

/**
 * Splits a message into chunks that fit within Telegram's message length limit
 */
/**
 * Splits a text message into chunks based on a maximum length for each chunk.
 *
 * @param {string} text - The text message to split.
 * @param {number} maxLength - The maximum length for each chunk (default is 4096).
 * @returns {string[]} An array containing the text message split into chunks.
 */
export function splitMessage(text: string, maxLength = 4096): string[] {
  const chunks: string[] = [];
  let currentChunk = '';

  const lines = text.split('\n');
  for (const line of lines) {
    if (currentChunk.length + line.length + 1 <= maxLength) {
      currentChunk += (currentChunk ? '\n' : '') + line;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = line;
    }
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

/**
 * Converts Eliza buttons into Telegram buttons
 * @param {Button[]} buttons - The buttons from Eliza content
 * @returns {InlineKeyboardButton[]} Array of Telegram buttons
 */
export function convertToTelegramButtons(buttons?: Button[] | null): InlineKeyboardButton[] {
  if (!buttons) return [];
  return buttons.map((button: Button) => {
    switch (button.kind) {
      case 'login':
        return Markup.button.login(button.text, button.url);
      case 'url':
        return Markup.button.url(button.text, button.url);
    }
  });
}
