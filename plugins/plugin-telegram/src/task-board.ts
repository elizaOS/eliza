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

import {
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Memory,
  type Service,
  type UUID,
} from "@elizaos/core";
import { scopedTelegramKey } from "./command-registration";

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

export interface TaskBoardRecord {
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
  /** Pin a freshly-posted board message so Telegram users can find it. */
  pin?: (
    chatId: number | string,
    messageId: number,
    threadId?: number,
  ) => Promise<void>;
  /** Load a persisted board message id for this chat/thread. */
  load?: (
    chatId: number | string,
    threadId?: number,
  ) => Promise<TaskBoardRecord | null>;
  /** Persist the board message id for this chat/thread. */
  save?: (
    chatId: number | string,
    record: TaskBoardRecord,
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
    const existing =
      this.boardMsgByKey.get(key) ??
      (await this.deps.load?.(chatId, threadId))?.messageId;
    if (existing !== undefined) {
      this.boardMsgByKey.set(key, existing);
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
      }
    }
    const { messageId } = await this.deps.post(chatId, text, threadId);
    this.boardMsgByKey.set(key, messageId);
    await this.deps.save?.(chatId, { messageId }, threadId);
    await this.pinBestEffort(chatId, messageId, threadId);
    return messageId;
  }

  private async pinBestEffort(
    chatId: number | string,
    messageId: number,
    threadId?: number,
  ): Promise<void> {
    try {
      await this.deps.pin?.(chatId, messageId, threadId);
    } catch (error) {
      logger.warn(
        `[TelegramTaskBoard] pin failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Forget a stored board (e.g. when a chat is reset). */
  forget(chatId: number | string, threadId?: number): void {
    this.boardMsgByKey.delete(this.key(chatId, threadId));
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
      extra?: { disable_notification?: boolean; message_thread_id?: number },
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

const TASK_BOARD_MEMORY_TYPE = "telegram_task_board";

function boardRoomKey(chatId: number | string, accountId: string): string {
  return scopedTelegramKey(String(chatId), accountId);
}

function boardThreadRoomKey(
  chatId: number | string,
  threadId: number | undefined,
  accountId: string,
): string {
  const roomKey = threadId !== undefined ? `${chatId}-${threadId}` : chatId;
  return scopedTelegramKey(String(roomKey), accountId);
}

function boardMemoryId(
  runtime: IAgentRuntime,
  accountId: string,
  chatId: number | string,
  threadId?: number,
): UUID {
  return createUniqueUuid(
    runtime,
    `telegram-task-board:${boardThreadRoomKey(chatId, threadId, accountId)}`,
  ) as UUID;
}

function boardRoomId(
  runtime: IAgentRuntime,
  accountId: string,
  chatId: number | string,
  threadId?: number,
): UUID {
  return createUniqueUuid(
    runtime,
    boardThreadRoomKey(chatId, threadId, accountId),
  ) as UUID;
}

function boardWorldId(
  runtime: IAgentRuntime,
  accountId: string,
  chatId: number | string,
): UUID {
  return createUniqueUuid(runtime, boardRoomKey(chatId, accountId)) as UUID;
}

function parseBoardRecord(memory: Memory | undefined): TaskBoardRecord | null {
  const messageId = memory?.content.messageId;
  return typeof messageId === "number" && Number.isInteger(messageId)
    ? { messageId }
    : null;
}

async function loadPersistedBoard(
  runtime: IAgentRuntime,
  accountId: string,
  chatId: number | string,
  threadId?: number,
): Promise<TaskBoardRecord | null> {
  const memory = await runtime.getMemoryById(
    boardMemoryId(runtime, accountId, chatId, threadId),
  );
  return parseBoardRecord(memory ?? undefined);
}

async function savePersistedBoard(
  runtime: IAgentRuntime,
  accountId: string,
  chatId: number | string,
  record: TaskBoardRecord,
  threadId?: number,
): Promise<void> {
  const now = Date.now();
  const id = boardMemoryId(runtime, accountId, chatId, threadId);
  const memory: Memory = {
    id,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: boardRoomId(runtime, accountId, chatId, threadId),
    worldId: boardWorldId(runtime, accountId, chatId),
    createdAt: now,
    unique: true,
    content: {
      text: `Telegram task board message ${record.messageId}`,
      source: "telegram",
      messageId: record.messageId,
    },
    metadata: {
      type: "custom",
      kind: TASK_BOARD_MEMORY_TYPE,
      source: "telegram",
      accountId,
      chatId: String(chatId),
      ...(threadId !== undefined ? { threadId } : {}),
      updatedAt: now,
    },
  };

  if (typeof runtime.upsertMemory === "function") {
    await runtime.upsertMemory(memory, "messages");
    return;
  }
  await runtime.createMemory(memory, "messages", true);
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
  accountId = "default",
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
    edit: async (chatId, messageId, text, threadId) => {
      await messageManager.editMessage(chatId, messageId, text, threadId);
    },
    pin: async (chatId, messageId, threadId) => {
      await bot.telegram.pinChatMessage?.(chatId, messageId, {
        disable_notification: true,
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      });
    },
    load: (chatId, threadId) =>
      loadPersistedBoard(runtime, accountId, chatId, threadId),
    save: (chatId, record, threadId) =>
      savePersistedBoard(runtime, accountId, chatId, record, threadId),
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
