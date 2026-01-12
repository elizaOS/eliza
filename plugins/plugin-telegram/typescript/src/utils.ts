import { logger } from "@elizaos/core";
import type { InlineKeyboardButton } from "@telegraf/types";
import { Markup } from "telegraf";
import type { Button } from "./types";

const TELEGRAM_RESERVED_REGEX = /([_*[\]()~`>#+\-=|{}.!\\])/g;

function escapePlainText(text: string): string {
  if (!text) return "";
  return text.replace(TELEGRAM_RESERVED_REGEX, "\\$1");
}

function escapePlainTextPreservingBlockquote(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => {
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
  if (!text) return "";
  return text.replace(/([`\\])/g, "\\$1");
}

function escapeUrl(url: string): string {
  if (!url) return "";
  return url.replace(/([)\\])/g, "\\$1");
}

/**
 * This function converts standard markdown to Telegram MarkdownV2.
 *
 * In addition to processing code blocks, inline code, links, bold, strikethrough, and italic,
 * it converts any header lines (those starting with one or more `#`) to bold text.
 *
 * Uses regex replacements with placeholders. Assumes non-nested formatting.
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
  converted = converted.replace(/```(\w+)?\n([\s\S]*?)```/g, (_match, lang, code) => {
    const escapedCode = escapeCode(code);
    const formatted = `\`\`\`${lang || ""}\n${escapedCode}\`\`\``;
    return storeReplacement(formatted);
  });

  converted = converted.replace(/`([^`]+)`/g, (_match, code) => {
    const escapedCode = escapeCode(code);
    const formatted = `\`${escapedCode}\``;
    return storeReplacement(formatted);
  });

  converted = converted.replace(
    /$begin:math:display$([^$end:math:display$]+)]$begin:math:text$([^)]+)$end:math:text$/g,
    (_match, text, url) => {
      const formattedText = escapePlainText(text);
      const escapedURL = escapeUrl(url);
      const formatted = `[${formattedText}](${escapedURL})`;
      return storeReplacement(formatted);
    }
  );

  converted = converted.replace(/\*\*([^*]+)\*\*/g, (_match, content) => {
    const formattedContent = escapePlainText(content);
    const formatted = `*${formattedContent}*`;
    return storeReplacement(formatted);
  });

  converted = converted.replace(/~~([^~]+)~~/g, (_match, content) => {
    const formattedContent = escapePlainText(content);
    const formatted = `~${formattedContent}~`;
    return storeReplacement(formatted);
  });

  converted = converted.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_match, content) => {
    const formattedContent = escapePlainText(content);
    const formatted = `_${formattedContent}_`;
    return storeReplacement(formatted);
  });

  converted = converted.replace(/_([^_\n]+)_/g, (_match, content) => {
    const formattedContent = escapePlainText(content);
    const formatted = `_${formattedContent}_`;
    return storeReplacement(formatted);
  });

  converted = converted.replace(/^(#{1,6})\s*(.*)$/gm, (_match, _hashes, headerContent: string) => {
    const formatted = `*${escapePlainText(headerContent.trim())}*`;
    return storeReplacement(formatted);
  });

  const NULL_CHAR = String.fromCharCode(0);
  const PLACEHOLDER_PATTERN = new RegExp(`(${NULL_CHAR}\\d+${NULL_CHAR})`, "g");
  const PLACEHOLDER_TEST = new RegExp(`^${NULL_CHAR}\\d+${NULL_CHAR}$`);
  const PLACEHOLDER_REPLACE = new RegExp(`${NULL_CHAR}(\\d+)${NULL_CHAR}`, "g");

  const finalEscaped = converted
    .split(PLACEHOLDER_PATTERN)
    .map((segment) => {
      if (PLACEHOLDER_TEST.test(segment)) {
        return segment;
      } else {
        return escapePlainTextPreservingBlockquote(segment);
      }
    })
    .join("");

  const finalResult = finalEscaped.replace(PLACEHOLDER_REPLACE, (_, index) => {
    return replacements[parseInt(index, 10)];
  });

  return finalResult;
}

export function splitMessage(text: string, maxLength = 4096): string[] {
  const chunks: string[] = [];
  if (!text) return chunks;
  let currentChunk = "";

  const lines = text.split("\n");
  for (const line of lines) {
    if (currentChunk.length + line.length + 1 <= maxLength) {
      currentChunk += (currentChunk ? "\n" : "") + line;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = line;
    }
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

export function convertToTelegramButtons(buttons?: Button[] | null): InlineKeyboardButton[] {
  if (!buttons) return [];
  const telegramButtons: InlineKeyboardButton[] = [];

  for (const button of buttons) {
    if (!button || !button.text || !button.url) {
      logger.warn({ button }, "Invalid button configuration, skipping");
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
      default:
        logger.warn(`Unknown button kind '${button.kind}', treating as URL button`);
        telegramButton = Markup.button.url(button.text, button.url);
        break;
    }

    telegramButtons.push(telegramButton);
  }

  return telegramButtons;
}

export function cleanText(text: string | undefined | null): string {
  if (!text) return "";
  return text.split("\u0000").join("");
}
