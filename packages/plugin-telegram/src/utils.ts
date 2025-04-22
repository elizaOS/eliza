import { Markup } from 'telegraf';
import { InlineKeyboardButton } from '@telegraf/types';
import { Button } from './types';

/**
 * Escapes Markdown special characters in the given text, excluding code blocks.
 * @param {string} text - The text to escape Markdown characters from.
 * @returns {string} The text with escaped Markdown characters.
 */
export function escapeMarkdown(text: string): string {
  // Don't escape if it's a code block
  if (text.startsWith('```') && text.endsWith('```')) {
    return text;
  }

  // Split the text by code blocks
  const parts = text.split(/(```[\s\S]*?```)/g);

  return parts
    .map((part, index) => {
      // If it's a code block (odd indices in the split result will be code blocks)
      if (index % 2 === 1) {
        return part;
      }
      // For regular text, only escape characters that need escaping in Markdown
      return (
        part
          // First preserve any intended inline code spans
          .replace(/`.*?`/g, (match) => match)
          // Then only escape the minimal set of special characters that need escaping in Markdown mode
          .replace(/([*_`\\])/g, '\\$1')
      );
    })
    .join('');
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
