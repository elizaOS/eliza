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
  encodePreparedInteractionCallback,
  type InteractionBlock,
  type NeutralButton,
  type PreparedMessageInteraction,
  parseInteractionBlocks,
  renderContentInteractionsAsPlainText,
  stripDashboardOnlyMarkers,
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
  /** Resolve a link-out URL for `navigate` followup chips. */
  resolveNavigateUrl?: (payload: string) => string | undefined;
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
      text: cleanedText,
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
      resolveNavigateUrl: opts.resolveNavigateUrl,
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

  // A buttonless block can contribute fallback prose after parsing (for
  // example, a task title). Strip again at the final delivery boundary so a
  // marker nested inside that block cannot bypass the parsed-text cleanup.
  const text = stripDashboardOnlyMarkers(
    [cleanedText, ...extraLines]
      .filter((s) => s.trim().length > 0)
      .join("\n\n"),
  );
  return { text, keyboardRows, needsFreeTextReply };
}

/** Render only host-prepared authority as Telegram inline-keyboard buttons. */
export function renderPreparedTelegramInteraction(
  prepared: PreparedMessageInteraction,
): TelegramInteractionRender {
  const block = prepared.block;
  const fallback = renderContentInteractionsAsPlainText({
    interactions: [block],
  }).text;
  const hostedUrl =
    prepared.hostedUrl ?? (block.kind === "secret" ? block.url : undefined);
  if (hostedUrl) {
    const label =
      block.kind === "form"
        ? (block.submitLabel ?? "Open form")
        : block.kind === "task"
          ? "Open task"
          : block.kind === "secret"
            ? block.secretKind === "oauth"
              ? `Connect ${block.provider ?? "account"}`
              : (block.submitLabel ?? "Provide securely")
            : "Open";
    return {
      text: block.kind === "task" ? block.title : fallback,
      keyboardRows: [[Markup.button.url(label, hostedUrl)]],
      needsFreeTextReply: false,
    };
  }
  if (
    prepared.delivery.mode !== "native" ||
    (block.kind !== "choice" && block.kind !== "followups")
  ) {
    return { text: fallback, keyboardRows: [], needsFreeTextReply: true };
  }
  const providerOptions =
    block.kind === "choice"
      ? block.options.map((option) => ({
          label: option.label,
          value: option.value,
        }))
      : block.options
          .filter((option) => option.kind !== "navigate")
          .map((option) => ({ label: option.label, value: option.payload }));
  const concrete: InlineKeyboardButton[] = [];
  for (const option of providerOptions) {
    const callbackData = encodePreparedInteractionCallback(
      prepared.callbackData,
      { value: option.value },
      64,
    );
    if (!callbackData) {
      return { text: fallback, keyboardRows: [], needsFreeTextReply: true };
    }
    concrete.push(Markup.button.callback(option.label, callbackData));
  }
  const keyboardRows: InlineKeyboardButton[][] = [];
  for (let index = 0; index < concrete.length; index += MAX_BUTTONS_PER_ROW) {
    keyboardRows.push(concrete.slice(index, index + MAX_BUTTONS_PER_ROW));
  }
  return {
    text:
      block.kind === "choice"
        ? (block.prompt ?? "Choose an option.")
        : "Choose an option.",
    keyboardRows,
    needsFreeTextReply: false,
  };
}
