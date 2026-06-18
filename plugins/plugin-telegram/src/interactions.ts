/**
 * Render the interactive blocks an agent embeds in a reply (choice pickers,
 * suggestion chips, task cards, secret/OAuth requests) as native Telegram
 * inline keyboards, and decode the callback when the user taps one.
 *
 * The block vocabulary, parsing, neutral layout, and the 64-byte-safe callback
 * codec all live in `@elizaos/core` (`messaging/interactions`) so the dashboard,
 * Discord, and Telegram render the same agent output identically. This module is
 * the thin Telegram-specific projection: neutral buttons → telegraf buttons.
 */

import {
  type Content,
  type InteractionBlock,
  type NeutralButton,
  parseInteractionBlocks,
  toNeutralLayout,
} from "@elizaos/core";
import type { InlineKeyboardButton } from "@telegraf/types";
import { Markup } from "telegraf";

/** Telegram allows up to 8 buttons per inline-keyboard row. */
const MAX_BUTTONS_PER_ROW = 8;

export interface TelegramInteractionRender {
  /** Prose with interaction markers stripped (plus any non-button block text). */
  text: string;
  /** Inline-keyboard rows; empty when the reply has no native controls. */
  keyboardRows: InlineKeyboardButton[][];
  /**
   * True when a block could not be fully rendered as buttons (an `allowCustom`
   * choice, or a form/secret with no link-out URL) and the user is expected to
   * answer with a free-text reply.
   */
  needsFreeTextReply: boolean;
}

export interface TelegramInteractionOptions {
  /** Resolve a link-out URL for task / form / secret blocks. */
  resolveUrl?: (block: InteractionBlock) => string | undefined;
}

function toTelegramButton(button: NeutralButton): InlineKeyboardButton | null {
  if (button.url) return Markup.button.url(button.label, button.url);
  if (button.callbackData)
    return Markup.button.callback(button.label, button.callbackData);
  return null;
}

/**
 * Project a reply's interaction blocks onto Telegram inline-keyboard rows + the
 * prose to display. Plain replies (no blocks) pass through unchanged with no
 * keyboard, so this is a safe no-op on the common path.
 */
export function renderTelegramInteractions(
  content: Content,
  opts: TelegramInteractionOptions = {},
): TelegramInteractionRender {
  const { blocks, cleanedText } = parseInteractionBlocks(content.text ?? "");
  if (blocks.length === 0) {
    return {
      text: content.text ?? "",
      keyboardRows: [],
      needsFreeTextReply: false,
    };
  }

  const keyboardRows: InlineKeyboardButton[][] = [];
  const extraLines: string[] = [];
  let needsFreeTextReply = false;

  for (const block of blocks) {
    const layout = toNeutralLayout(block, {
      resolveUrl: opts.resolveUrl,
      maxButtonsPerRow: MAX_BUTTONS_PER_ROW,
    });
    let producedButton = false;
    for (const row of layout.rows) {
      const buttons = (row.buttons ?? [])
        .map(toTelegramButton)
        .filter((b): b is InlineKeyboardButton => b !== null);
      if (buttons.length > 0) {
        keyboardRows.push(buttons);
        producedButton = true;
      }
    }
    // Telegram has no native multi-select; a select-only block falls back to text.
    if (layout.needsFallback) needsFreeTextReply = true;
    // Preserve a block's own text (e.g. a task title) when it had no button.
    if (!producedButton && layout.text) extraLines.push(layout.text);
  }

  const text = [cleanedText, ...extraLines]
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
  return { text, keyboardRows, needsFreeTextReply };
}
