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
import { logger, stringToUuid } from "@elizaos/core";
import { normalizeTelegramAccountId } from "./accounts";

/**
 * Durable store for the board's message id per (chat, thread) key, so the board
 * survives an agent restart instead of re-posting a duplicate (#8902 AC3). The
 * default is an in-process map (lost on restart); the Telegram service wires the
 * runtime-memory-backed store below in production.
 */
export interface BoardMessageStore {
  load(key: string): Promise<number | undefined> | number | undefined;
  save(key: string, messageId: number): Promise<void> | void;
  forget(key: string): Promise<void> | void;
}

/** In-process board store — fast, but the board is forgotten on restart. */
export function createInMemoryBoardStore(): BoardMessageStore {
  const map = new Map<string, number>();
  return {
    load: (key) => map.get(key),
    save: (key, messageId) => {
      map.set(key, messageId);
    },
    forget: (key) => {
      map.delete(key);
    },
  };
}

const BOARD_MEMORY_TABLE = "telegram_task_board";

/**
 * Runtime-memory-backed board store (#8902 AC3): persists the board message id
 * keyed by (chat, thread) so `/tasks` after a restart edits the existing pinned
 * board instead of posting a duplicate. Keyed by a deterministic UUID derived
 * from the board key; upserts via getMemoryById → updateMemory/createMemory;
 * `forget` tombstones the id (no hard-delete in the memory API) so a deleted
 * board is re-posted. All operations are best-effort — a store failure degrades
 * to "post a fresh board", never throws into the command path.
 */
export function createRuntimeMemoryBoardStore(
  runtime: IAgentRuntime,
): BoardMessageStore {
  const idFor = (key: string): UUID => stringToUuid(`tg-task-board:${key}`);
  const roomFor = (key: string): UUID =>
    stringToUuid(`tg-task-board-room:${key}`);
  const readId = (mem: Memory | null): number | undefined => {
    const v = (mem?.content as { boardMessageId?: unknown } | undefined)
      ?.boardMessageId;
    return typeof v === "number" ? v : undefined;
  };
  return {
    async load(key) {
      try {
        return readId(await runtime.getMemoryById(idFor(key)));
      } catch {
        return undefined;
      }
    },
    async save(key, messageId) {
      const id = idFor(key);
      const content = { boardMessageId: messageId, boardKey: key } as const;
      try {
        const existing = await runtime.getMemoryById(id);
        if (existing) {
          await runtime.updateMemory({ id, content });
          return;
        }
        await runtime.createMemory(
          {
            id,
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: roomFor(key),
            content,
          } as Memory,
          BOARD_MEMORY_TABLE,
        );
      } catch (error) {
        logger.warn(
          `[TelegramTaskBoard] failed to persist board id: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    async forget(key) {
      try {
        const id = idFor(key);
        if (await runtime.getMemoryById(id)) {
          // No hard-delete on the memory API — tombstone the id so load() misses.
          await runtime.updateMemory({ id, content: { boardKey: key } });
        }
      } catch {
        // best-effort
      }
    },
  };
}

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
  /**
   * Pin a freshly-posted board so it stays at the top of the chat (#8902 AC1).
   * Best-effort and only on a NEW post (an in-place edit keeps the existing pin).
   */
  pin?: (
    chatId: number | string,
    messageId: number,
    threadId?: number,
  ) => Promise<void>;
  /** Durable board-message-id store (#8902 AC3). Defaults to in-process. */
  store?: BoardMessageStore;
}

/**
 * Owns one board message per (chat, thread) and keeps it current: first render
 * posts, later renders edit in place. An edit failure (e.g. the message was
 * deleted) falls back to posting a fresh board so the user always gets one.
 */
export class TelegramTaskBoard {
  private readonly store: BoardMessageStore;

  constructor(private readonly deps: TaskBoardDeps) {
    this.store = deps.store ?? createInMemoryBoardStore();
  }

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
    const existing = await this.store.load(key);
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
        await this.store.forget(key);
      }
    }
    const { messageId } = await this.deps.post(chatId, text, threadId);
    await this.store.save(key, messageId);
    // Pin only a freshly-posted board (#8902 AC1) — an edit keeps the prior pin.
    if (this.deps.pin) {
      try {
        await this.deps.pin(chatId, messageId, threadId);
      } catch (error) {
        logger.warn(
          `[TelegramTaskBoard] pin failed (board still posted): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return messageId;
  }

  /** Forget a stored board (e.g. when a chat is reset). */
  async forget(chatId: number | string, threadId?: number): Promise<void> {
    await this.store.forget(this.key(chatId, threadId));
  }
}

interface TaskServiceLike {
  listTasks(filter?: {
    includeArchived?: boolean;
  }): Promise<Array<{ id: string; title: string; status: string }>>;
}

interface TaskSupervisorLike {
  registerDigestSink?: (
    source: string,
    sink: (
      target: { source: string; roomId: UUID; accountId?: string },
      content: unknown,
    ) => Promise<boolean | undefined> | boolean | undefined,
  ) => () => void;
}

interface RuntimeWithRooms {
  getRoom?: (roomId: UUID) => Promise<{
    channelId?: string | null;
    metadata?: {
      accountId?: string | null;
      threadId?: string | number | null;
      telegramThreadId?: string | number | null;
      telegram?: { accountId?: string | null } | null;
    } | null;
  } | null>;
}

interface RuntimeServiceLoader {
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
}

const TASK_SUPERVISOR_SERVICE_TYPE = "ORCHESTRATOR_TASK_SUPERVISOR";
const TELEGRAM_CHAT_ID_PATTERN = /^-?\d+$/;
const TELEGRAM_THREADED_CHANNEL_PATTERN = /^(-?\d+)-(\d+)$/;

function parseTelegramBoardTargetParts(
  channelId: string,
  explicitThreadId?: string | number | null,
): { chatId: string; threadId?: number } | null {
  const explicitThreadNumber =
    typeof explicitThreadId === "number"
      ? explicitThreadId
      : typeof explicitThreadId === "string" && /^\d+$/.test(explicitThreadId)
        ? Number.parseInt(explicitThreadId, 10)
        : undefined;
  const threadedMatch = channelId.match(TELEGRAM_THREADED_CHANNEL_PATTERN);
  if (threadedMatch) {
    return {
      chatId: threadedMatch[1],
      threadId: explicitThreadNumber ?? Number.parseInt(threadedMatch[2], 10),
    };
  }
  if (!TELEGRAM_CHAT_ID_PATTERN.test(channelId)) return null;
  return { chatId: channelId, threadId: explicitThreadNumber };
}

async function resolveTelegramBoardTarget(
  runtime: IAgentRuntime,
  roomId: UUID,
): Promise<{ chatId: string; threadId?: number; accountId?: string } | null> {
  const room = await (runtime as RuntimeWithRooms).getRoom?.(roomId);
  if (!room?.channelId) return null;
  const parts = parseTelegramBoardTargetParts(
    room.channelId,
    room.metadata?.telegramThreadId ?? room.metadata?.threadId,
  );
  if (!parts) return null;
  const rawAccountId =
    room.metadata?.accountId ?? room.metadata?.telegram?.accountId;
  return {
    ...parts,
    ...(rawAccountId
      ? { accountId: normalizeTelegramAccountId(rawAccountId) }
      : {}),
  };
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
    pinChatMessage: (
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
  accountId?: string,
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
    // Pin the freshly-posted board so it stays at the top (#8902 AC1); quiet so
    // it doesn't ping everyone.
    pin: async (chatId, messageId) => {
      await bot.telegram.pinChatMessage(chatId, messageId, {
        disable_notification: true,
      });
    },
    // Persist the board message id so `/tasks` after a restart edits the pinned
    // board instead of posting a duplicate (#8902 AC3).
    store: createRuntimeMemoryBoardStore(runtime),
  });
  registerTelegramTaskBoardSupervisorSink(runtime, board, accountId);
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
 * Let the orchestrator's change-driven task supervisor refresh Telegram's
 * pinned board instead of posting a separate digest message for every status
 * change (#8902 AC2). Kept duck-typed to avoid a hard dependency from the
 * Telegram connector back into the orchestrator plugin.
 */
export function registerTelegramTaskBoardSupervisorSink(
  runtime: IAgentRuntime,
  board: TelegramTaskBoard,
  accountId?: string,
): (() => void) | undefined {
  let unregister: (() => void) | undefined;
  const ownAccountId = accountId
    ? normalizeTelegramAccountId(accountId)
    : undefined;
  const tryRegister = () => {
    if (unregister) return unregister;
    const supervisor = runtime.getService<Service & TaskSupervisorLike>(
      TASK_SUPERVISOR_SERVICE_TYPE,
    );
    if (typeof supervisor?.registerDigestSink !== "function") return undefined;
    unregister = supervisor.registerDigestSink(
      "telegram",
      async (target): Promise<boolean> => {
        const destination = await resolveTelegramBoardTarget(
          runtime,
          target.roomId,
        );
        if (!destination) return false;
        const targetAccountId = target.accountId
          ? normalizeTelegramAccountId(target.accountId)
          : destination.accountId;
        if (
          ownAccountId &&
          targetAccountId &&
          normalizeTelegramAccountId(targetAccountId) !== ownAccountId
        ) {
          return false;
        }
        const entries = await loadTaskBoardEntries(runtime);
        await board.render(destination.chatId, entries, destination.threadId);
        return true;
      },
    );
    return unregister;
  };

  const registered = tryRegister();
  if (registered) return registered;

  void (runtime as RuntimeServiceLoader)
    .getServiceLoadPromise?.(TASK_SUPERVISOR_SERVICE_TYPE)
    ?.then(() => {
      tryRegister();
    })
    .catch(() => undefined);
  return undefined;
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
