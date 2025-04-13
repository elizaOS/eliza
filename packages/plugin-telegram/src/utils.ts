import { Markup } from 'telegraf';
import { InlineKeyboardButton } from '@telegraf/types';
import { Button } from './types';

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
