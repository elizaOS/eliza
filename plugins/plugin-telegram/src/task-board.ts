/**
 * Telegram pinned task board + `/tasks` command (#8902, EPIC #8885).
 *
 * Telegram has no sidebar, so the equivalent of Codex's task list is a single
 * message that is edited in place as task state changes. `/tasks` renders the
 * board; on subsequent renders for the same chat the existing message is edited
 * (requires the `edit_message` capability, #8903) instead of flooding the chat
 * with a new message each time.
 *
 * The board composer is a pure function so it unit-tests without a bot, and the
 * post-or-edit manager takes injected `post`/`edit` so it tests with mocks.
 */

import type { IAgentRuntime, Memory, Service, UUID } from "@elizaos/core";
import { createUniqueUuid, logger } from "@elizaos/core";

/** A task reduced to what a board line needs. */
export interface TaskBoardEntry {
  id: string;
  title: string;
  status: string;
}

const STATUS_EMOJI: Record<string, string> = {
  open: "📋",
  active: "🚀",
  validating: "🔍",
  waiting_on_user: "⏳",
  blocked: "⛔",
  done: "✅",
  failed: "❌",
  archived: "🗄️",
  interrupted: "⏸️",
};

/** Statuses considered "in flight" — surfaced above the fold on the board. */
const LIVE_STATUSES = new Set([
  "open",
  "active",
  "validating",
  "waiting_on_user",
  "blocked",
]);

export function taskBoardEmoji(status: string): string {
  return STATUS_EMOJI[status] ?? "•";
}

/**
 * Render the board body — plain text (no Markdown) so the same string is safe
 * for both the initial post and an in-place MarkdownV2 edit. Live tasks first,
 * then a capped "recently closed" tail.
 */
export function composeTaskBoard(entries: TaskBoardEntry[]): string {
  if (entries.length === 0) {
    return "📋 Task board\n\nNo tasks yet. Start one and it'll show up here.";
  }
  const live = entries.filter((e) => LIVE_STATUSES.has(e.status));
  const closed = entries.filter((e) => !LIVE_STATUSES.has(e.status));
  const line = (e: TaskBoardEntry) =>
    `${taskBoardEmoji(e.status)} ${e.title} — ${e.status}`;
  const sections: string[] = [`📋 Task board (${live.length} active)`];
  if (live.length > 0) sections.push(live.map(line).join("\n"));
  if (closed.length > 0)
    sections.push(
      `recently closed:\n${closed.slice(0, 5).map(line).join("\n")}`,
    );
  return sections.join("\n\n");
}

export interface TaskBoardPostResult {
  /** The message id of the board, for in-place edits on the next render. */
  messageId: number;
}

export interface TaskBoardDeps {
  /** Post a new board message; returns its message id. */
  post: (
    chatId: number | string,
    text: string,
    threadId?: number,
  ) => Promise<TaskBoardPostResult>;
  /** Edit the existing board message in place. */
  edit: (
    chatId: number | string,
    messageId: number,
    text: string,
    threadId?: number,
  ) => Promise<void>;
  /** Best-effort pin for a newly posted board message. */
  pin?: (
    chatId: number | string,
    messageId: number,
    threadId?: number,
  ) => Promise<void>;
  /** Load a persisted board message id for this chat/thread. */
  loadMessageId?: (
    chatId: number | string,
    threadId?: number,
  ) => Promise<number | undefined>;
  /** Persist the board message id for this chat/thread. */
  saveMessageId?: (
    chatId: number | string,
    messageId: number,
    threadId?: number,
  ) => Promise<void>;
  /** Forget a persisted board message id after deletion/edit failure. */
  forgetMessageId?: (
    chatId: number | string,
    threadId?: number,
  ) => Promise<void>;
}

/**
 * Owns one board message per (chat, thread) and keeps it current: first render
 * posts, later renders edit in place. An edit failure (e.g. the message was
 * deleted) falls back to posting a fresh board so the user always gets one.
 */
export class TelegramTaskBoard {
  private readonly boardMsgByKey = new Map<string, number>();

  constructor(private readonly deps: TaskBoardDeps) {}

  private key(chatId: number | string, threadId?: number): string {
    return `${chatId}:${threadId ?? ""}`;
  }

  /** Returns the board message id (existing or newly posted). */
  async render(
    chatId: number | string,
    entries: TaskBoardEntry[],
    threadId?: number,
  ): Promise<number> {
    const text = composeTaskBoard(entries);
    const key = this.key(chatId, threadId);
    let existing = this.boardMsgByKey.get(key);
    if (existing === undefined && this.deps.loadMessageId) {
      existing = await this.deps.loadMessageId(chatId, threadId);
      if (existing !== undefined) this.boardMsgByKey.set(key, existing);
    }
    if (existing !== undefined) {
      try {
        await this.deps.edit(chatId, existing, text, threadId);
        return existing;
      } catch (error) {
        // The board message may have been deleted — post a fresh one.
        logger.warn(
          `[TelegramTaskBoard] edit failed, reposting: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.boardMsgByKey.delete(key);
        await this.deps.forgetMessageId?.(chatId, threadId);
      }
    }
    const { messageId } = await this.deps.post(chatId, text, threadId);
    this.boardMsgByKey.set(key, messageId);
    await this.deps.saveMessageId?.(chatId, messageId, threadId);
    try {
      await this.deps.pin?.(chatId, messageId, threadId);
    } catch (error) {
      logger.warn(
        `[TelegramTaskBoard] pin failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return messageId;
  }

  /** Forget a stored board (e.g. when a chat is reset). */
  forget(chatId: number | string, threadId?: number): void {
    this.boardMsgByKey.delete(this.key(chatId, threadId));
    void this.deps.forgetMessageId?.(chatId, threadId);
  }
}

interface TaskServiceLike {
  listTasks(filter?: {
    includeArchived?: boolean;
  }): Promise<Array<{ id: string; title: string; status: string }>>;
}

/** Minimal Telegraf surface the board command needs (kept narrow for testing). */
interface TaskBoardBot {
  command: (
    name: string,
    handler: (ctx: {
      chat?: { id: number };
      message?: { message_thread_id?: number };
    }) => Promise<void>,
  ) => void;
  telegram: {
    sendMessage: (
      chatId: number | string,
      text: string,
      extra?: { message_thread_id?: number },
    ) => Promise<{ message_id: number }>;
    pinChatMessage?: (
      chatId: number | string,
      messageId: number,
      extra?: { disable_notification?: boolean },
    ) => Promise<unknown>;
  };
}

interface TaskBoardMessageManager {
  editMessage: (
    chatId: number | string,
    messageId: number,
    text: string,
    messageThreadId?: number,
  ) => Promise<void>;
}

/**
 * Register the `/tasks` command. Holds one {@link TelegramTaskBoard} for the
 * bot's lifetime so repeated `/tasks` edit the same message in place. Returns
 * the board so the supervisor (or tests) can drive renders too.
 */
export function registerTelegramTaskBoardCommand(
  bot: TaskBoardBot,
  runtime: IAgentRuntime,
  messageManager: TaskBoardMessageManager,
): TelegramTaskBoard {
  const board = new TelegramTaskBoard({
    post: async (chatId, text, threadId) => {
      const sent = await bot.telegram.sendMessage(
        chatId,
        text,
        threadId !== undefined ? { message_thread_id: threadId } : undefined,
      );
      return { messageId: sent.message_id };
    },
    pin: bot.telegram.pinChatMessage
      ? async (chatId, messageId) => {
          await bot.telegram.pinChatMessage?.(chatId, messageId, {
            disable_notification: true,
          });
        }
      : undefined,
    edit: async (chatId, messageId, text, threadId) => {
      await messageManager.editMessage(chatId, messageId, text, threadId);
    },
    loadMessageId: (chatId, threadId) =>
      loadPersistedTaskBoardMessageId(runtime, chatId, threadId),
    saveMessageId: (chatId, messageId, threadId) =>
      savePersistedTaskBoardMessageId(runtime, chatId, messageId, threadId),
    forgetMessageId: (chatId, threadId) =>
      forgetPersistedTaskBoardMessageId(runtime, chatId, threadId),
  });
  bot.command("tasks", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const threadId = ctx.message?.message_thread_id;
    try {
      const entries = await loadTaskBoardEntries(runtime);
      await board.render(chatId, entries, threadId);
    } catch (error) {
      logger.warn(
        `[TelegramTaskBoard] /tasks render failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
  return board;
}

function taskBoardMemoryIds(
  runtime: IAgentRuntime,
  chatId: number | string,
  threadId?: number,
): { id: UUID; roomId: UUID; metadata: Record<string, unknown> } {
  const key = `${chatId}:${threadId ?? ""}`;
  return {
    id: createUniqueUuid(runtime, `telegram-task-board-memory:${key}`) as UUID,
    roomId: createUniqueUuid(
      runtime,
      `telegram-task-board-room:${key}`,
    ) as UUID,
    metadata: {
      type: "telegram_task_board",
      chatId: String(chatId),
      threadId: threadId ?? null,
    },
  };
}

export async function loadPersistedTaskBoardMessageId(
  runtime: IAgentRuntime,
  chatId: number | string,
  threadId?: number,
): Promise<number | undefined> {
  const { id } = taskBoardMemoryIds(runtime, chatId, threadId);
  const memory = await runtime.getMemoryById(id).catch(() => null);
  const metadata = memory?.metadata as Record<string, unknown> | undefined;
  const messageId = metadata?.messageId;
  return typeof messageId === "number" && Number.isFinite(messageId)
    ? messageId
    : undefined;
}

export async function savePersistedTaskBoardMessageId(
  runtime: IAgentRuntime,
  chatId: number | string,
  messageId: number,
  threadId?: number,
): Promise<void> {
  const { id, roomId, metadata } = taskBoardMemoryIds(
    runtime,
    chatId,
    threadId,
  );
  const nextMetadata = { ...metadata, messageId };
  const existing = await runtime.getMemoryById(id).catch(() => null);
  if (existing) {
    await runtime.updateMemory({ id, metadata: nextMetadata });
    return;
  }
  await runtime.createMemory(
    {
      id,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId,
      content: {
        text: `Telegram task board ${chatId}${threadId ? `/${threadId}` : ""}`,
        source: "telegram",
        type: "telegram_task_board",
      },
      metadata: nextMetadata,
    } as Memory,
    "memories",
    true,
  );
}

export async function forgetPersistedTaskBoardMessageId(
  runtime: IAgentRuntime,
  chatId: number | string,
  threadId?: number,
): Promise<void> {
  const { id } = taskBoardMemoryIds(runtime, chatId, threadId);
  await runtime.deleteMemory(id).catch(() => undefined);
}

/**
 * Read the current orchestrator task list as board entries. Returns [] when the
 * orchestrator isn't loaded (board still renders an empty state).
 */
export async function loadTaskBoardEntries(
  runtime: IAgentRuntime,
): Promise<TaskBoardEntry[]> {
  const svc = runtime.getService<Service & TaskServiceLike>(
    "ORCHESTRATOR_TASK_SERVICE",
  );
  if (!svc || typeof svc.listTasks !== "function") return [];
  const tasks = await svc.listTasks({ includeArchived: false });
  return tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
}
