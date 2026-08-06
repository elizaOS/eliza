import type { Api } from "grammy";
import { GrammyError } from "grammy";
import type { StreamChunk } from "../types/index";
import { splitTelegramMessage, TELEGRAM_MAX_MESSAGE } from "./limits";
import { startTypingRefresh } from "./typing-refresh";

const EDIT_THROTTLE_MS = 350;
const EDIT_MIN_CHARS = 48;
const MAX_API_RETRIES = 12;

/** Bot API allows `message_thread_id` for forum topics; @grammyjs/types may omit it on `editMessageText`. */
function editThreadOpts(messageThreadId?: number): { message_thread_id?: number } {
  return messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {};
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < MAX_API_RETRIES; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (e instanceof GrammyError && e.error_code === 429) {
        const retryAfter = Number((e.parameters as { retry_after?: number }).retry_after ?? 1) * 1000;
        await new Promise((r) => setTimeout(r, retryAfter));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** Same text as before — not an error; avoid treating as preview failure. */
function isMessageNotModified(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.error_code === 400 &&
    typeof err.description === "string" &&
    err.description.toLowerCase().includes("message is not modified")
  );
}

/** Telegram requires non-empty text; use zero-width space so nothing visible appears before real tokens. */
const EMPTY_PREVIEW_PLACEHOLDER = "\u200b";

function previewBody(acc: string): string {
  if (!acc) return EMPTY_PREVIEW_PLACEHOLDER;
  return acc.length > TELEGRAM_MAX_MESSAGE ? acc.slice(0, TELEGRAM_MAX_MESSAGE) : acc;
}

export interface TelegramPartialReplyArgs {
  chatId: number | string;
  messageThreadId?: number;
  typingIndicator: boolean;
  stream: AsyncIterable<StreamChunk>;
  onAssistantMessage?: (event: { content: string; done: boolean }) => void;
  onToolCalls?: (toolCalls: NonNullable<StreamChunk["toolCalls"]>) => void;
  onToolResult?: (event: {
    toolCall: NonNullable<StreamChunk["toolCall"]>;
    toolResult: NonNullable<StreamChunk["toolResult"]>;
  }) => void;
}

/**
 * Sends a live-updating preview (send + throttled editMessageText), then finalizes.
 * Falls back to buffer-then-send if the initial message cannot be sent.
 */
export async function runTelegramPartialReply(api: Api, args: TelegramPartialReplyArgs): Promise<void> {
  const { chatId, messageThreadId, typingIndicator, stream, onAssistantMessage, onToolCalls, onToolResult } = args;

  const stopTyping = startTypingRefresh(api, chatId, messageThreadId, typingIndicator);

  const sendParts = async (parts: string[]) => {
    for (const part of parts) {
      await withRetry(() => api.sendMessage(chatId, part, { message_thread_id: messageThreadId }));
    }
  };

  let previewMessageId: number | undefined;
  /** First sendMessage failed — finish with sendParts only. */
  let previewCreateFailed = false;
  let acc = "";
  let previewBroken = false;
  let lastEditAt = 0;
  let lastEditLen = 0;

  /** First real message is sent only after assistant text exists so sendChatAction(typing) stays visible until then. */
  const ensurePreviewMessage = async () => {
    if (previewMessageId !== undefined || previewCreateFailed || !acc) return;
    try {
      const sent = await withRetry(() =>
        api.sendMessage(chatId, previewBody(acc), { message_thread_id: messageThreadId }),
      );
      if (!sent.message_id) {
        previewCreateFailed = true;
        return;
      }
      previewMessageId = sent.message_id;
    } catch {
      previewCreateFailed = true;
    }
  };

  const flushEdit = async (force: boolean) => {
    if (previewMessageId === undefined || previewBroken) return;
    const messageId = previewMessageId;
    const now = Date.now();
    const delta = acc.length - lastEditLen;
    if (!force && now - lastEditAt < EDIT_THROTTLE_MS && delta < EDIT_MIN_CHARS) return;
    try {
      await withRetry(() =>
        api.editMessageText(chatId, messageId, previewBody(acc), editThreadOpts(messageThreadId) as never),
      );
      lastEditAt = Date.now();
      lastEditLen = acc.length;
    } catch (e) {
      if (isMessageNotModified(e)) {
        lastEditAt = Date.now();
        lastEditLen = acc.length;
        return;
      }
      previewBroken = true;
    }
  };

  try {
    try {
      for await (const chunk of stream) {
        switch (chunk.type) {
          case "content":
            if (chunk.content) {
              acc += chunk.content;
              onAssistantMessage?.({ content: acc, done: false });
              await ensurePreviewMessage();
              await flushEdit(false);
            }
            break;
          case "tool_calls":
            if (chunk.toolCalls) {
              onToolCalls?.(chunk.toolCalls);
            }
            break;
          case "tool_result":
            if (chunk.toolCall && chunk.toolResult) {
              onToolResult?.({ toolCall: chunk.toolCall, toolResult: chunk.toolResult });
            }
            break;
        }
      }
    } catch (err: unknown) {
      await flushEdit(true);
      const msg = err instanceof Error ? err.message : String(err);
      const errText = `Error: ${msg.slice(0, TELEGRAM_MAX_MESSAGE)}`;
      onAssistantMessage?.({ content: errText, done: true });
      if (previewMessageId !== undefined && !previewBroken) {
        const messageId = previewMessageId;
        try {
          await withRetry(() =>
            api.editMessageText(chatId, messageId, errText, editThreadOpts(messageThreadId) as never),
          );
        } catch {
          await sendParts(splitTelegramMessage(errText));
        }
      } else {
        await sendParts(splitTelegramMessage(errText));
      }
      return;
    }

    await flushEdit(true);

    const trimmed = acc.trim() || "(no text output)";
    const parts = splitTelegramMessage(trimmed);
    onAssistantMessage?.({ content: trimmed, done: true });

    if (previewMessageId === undefined) {
      await sendParts(parts);
      return;
    }

    if (parts.length === 0) {
      if (!previewBroken) {
        const messageId = previewMessageId;
        await withRetry(() =>
          api.editMessageText(chatId, messageId, "(no text output)", editThreadOpts(messageThreadId) as never),
        );
      }
      return;
    }

    if (previewBroken) {
      await sendParts(parts);
      return;
    }

    const messageId = previewMessageId;
    try {
      await withRetry(() => api.editMessageText(chatId, messageId, parts[0], editThreadOpts(messageThreadId) as never));
    } catch (e) {
      if (!isMessageNotModified(e)) {
        await sendParts(parts);
        return;
      }
    }
    if (parts.length > 1) {
      await sendParts(parts.slice(1));
    }
  } finally {
    stopTyping();
  }
}
