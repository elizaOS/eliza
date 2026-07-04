/**
 * Unit tests for the pinned task board: `composeTaskBoard` rendering (status
 * emoji, closed tail, empty state) and the board's edit-in-place behavior —
 * post on first render, edit the same message thereafter, with separate boards
 * per chat/thread. Bot API calls are mocked.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  composeTaskBoard,
  createInMemoryBoardStore,
  createRuntimeMemoryBoardStore,
  registerTelegramTaskBoardCommand,
  registerTelegramTaskBoardSupervisorSink,
  type TaskBoardEntry,
  TelegramTaskBoard,
  taskBoardEmoji,
} from "./task-board";

const entries: TaskBoardEntry[] = [
  { id: "1", title: "ship feature", status: "active" },
  { id: "2", title: "verify fix", status: "validating" },
  { id: "3", title: "old task", status: "done" },
];

describe("composeTaskBoard (#8902)", () => {
  it("lists live tasks with status emoji and a closed tail", () => {
    const board = composeTaskBoard(entries);
    expect(board).toContain("📋 Task board (2 active)");
    expect(board).toContain(
      `${taskBoardEmoji("active")} ship feature — active`,
    );
    expect(board).toContain(
      `${taskBoardEmoji("validating")} verify fix — validating`,
    );
    expect(board).toContain("recently closed:");
    expect(board).toContain(`${taskBoardEmoji("done")} old task — done`);
  });

  it("renders an empty state with no tasks", () => {
    expect(composeTaskBoard([])).toContain("No tasks yet");
  });
});

describe("TelegramTaskBoard (#8902)", () => {
  it("posts on first render, then edits the same message in place", async () => {
    const post = vi.fn(async () => ({ messageId: 42 }));
    const edit = vi.fn(async () => undefined);
    const board = new TelegramTaskBoard({ post, edit });

    const id1 = await board.render(100, entries);
    expect(id1).toBe(42);
    expect(post).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();

    // second render → edits message 42 (no new post = no flooding)
    const id2 = await board.render(100, [
      { id: "1", title: "ship feature", status: "done" },
    ]);
    expect(id2).toBe(42);
    expect(post).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith(100, 42, expect.any(String), undefined);
  });

  it("keeps separate boards per chat/thread", async () => {
    let next = 0;
    const post = vi.fn(async () => ({ messageId: ++next }));
    const edit = vi.fn(async () => undefined);
    const board = new TelegramTaskBoard({ post, edit });
    await board.render(100, entries);
    await board.render(100, entries, 7); // same chat, different thread
    await board.render(200, entries); // different chat
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("reposts a fresh board when an in-place edit fails (message deleted)", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ messageId: 1 })
      .mockResolvedValueOnce({ messageId: 2 });
    const edit = vi.fn().mockRejectedValueOnce(new Error("message not found"));
    const board = new TelegramTaskBoard({ post, edit });
    await board.render(100, entries); // posts msg 1
    const id = await board.render(100, entries); // edit fails → reposts msg 2
    expect(id).toBe(2);
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe("TelegramTaskBoard pinning (#8902 AC1)", () => {
  it("pins a freshly-posted board once, and NOT on an in-place edit", async () => {
    const post = vi.fn(async () => ({ messageId: 42 }));
    const edit = vi.fn(async () => undefined);
    const pin = vi.fn(async () => undefined);
    const board = new TelegramTaskBoard({ post, edit, pin });
    await board.render(100, entries); // post → pin
    await board.render(100, entries); // edit → no pin
    expect(post).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledWith(100, 42, undefined);
  });

  it("still posts the board when pinning fails (best-effort)", async () => {
    const post = vi.fn(async () => ({ messageId: 7 }));
    const edit = vi.fn(async () => undefined);
    const pin = vi.fn(async () => {
      throw new Error("not enough rights to pin");
    });
    const id = await new TelegramTaskBoard({ post, edit, pin }).render(
      100,
      entries,
    );
    expect(id).toBe(7);
    expect(pin).toHaveBeenCalledTimes(1);
  });
});

describe("TelegramTaskBoard persistence (#8902 AC3)", () => {
  it("survives a 'restart' via a shared store — edits the persisted board, not re-post", async () => {
    const store = createInMemoryBoardStore();
    // First process: posts + persists the id.
    const post1 = vi.fn(async () => ({ messageId: 55 }));
    await new TelegramTaskBoard({
      post: post1,
      edit: vi.fn(async () => undefined),
      store,
    }).render(100, entries);
    expect(post1).toHaveBeenCalledTimes(1);

    // Restart: a NEW board instance with the SAME store must EDIT id 55, not post.
    const post2 = vi.fn(async () => ({ messageId: 999 }));
    const edit2 = vi.fn(async () => undefined);
    const id = await new TelegramTaskBoard({
      post: post2,
      edit: edit2,
      store,
    }).render(100, entries);
    expect(id).toBe(55);
    expect(edit2).toHaveBeenCalledWith(100, 55, expect.any(String), undefined);
    expect(post2).not.toHaveBeenCalled();
  });
});

describe("createRuntimeMemoryBoardStore (#8902 AC3)", () => {
  // Faithful in-memory fake of the runtime memory API (id-keyed upsert), so the
  // store's real getMemoryById/createMemory/updateMemory usage is exercised.
  function fakeRuntime(): IAgentRuntime {
    const mem = new Map<string, Memory>();
    return {
      agentId: "00000000-0000-0000-0000-0000000000aa" as UUID,
      getMemoryById: async (id: UUID) => mem.get(id) ?? null,
      createMemory: async (m: Memory) => {
        mem.set(m.id as string, m);
        return m.id as UUID;
      },
      updateMemory: async (m: Partial<Memory> & { id: UUID }) => {
        const prev = mem.get(m.id as string);
        mem.set(
          m.id as string,
          {
            ...(prev as Memory),
            ...m,
            content: m.content ?? prev?.content,
          } as Memory,
        );
        return true;
      },
    } as unknown as IAgentRuntime;
  }

  it("round-trips a board id (save → load), upserts, and tombstones on forget", async () => {
    const store = createRuntimeMemoryBoardStore(fakeRuntime());
    expect(await store.load("100:")).toBeUndefined();
    await store.save("100:", 321);
    expect(await store.load("100:")).toBe(321);
    await store.save("100:", 654); // upsert same key
    expect(await store.load("100:")).toBe(654);
    await store.forget("100:");
    expect(await store.load("100:")).toBeUndefined();
  });
});

describe("Telegram task board supervisor sink (#8902 AC2)", () => {
  function fakeRuntime(options: {
    tasks: TaskBoardEntry[];
    onRegister?: (
      source: string,
      sink: (
        target: { source: string; roomId: UUID },
        content: unknown,
      ) => Promise<boolean | undefined> | boolean | undefined,
    ) => void;
    room?: { channelId?: string; metadata?: Record<string, unknown> } | null;
  }): IAgentRuntime {
    const mem = new Map<string, Memory>();
    const taskService = {
      listTasks: vi.fn(async () => options.tasks),
    };
    const supervisor = {
      registerDigestSink: vi.fn((source, sink) => {
        options.onRegister?.(source, sink);
        return vi.fn();
      }),
    };
    return {
      agentId: "00000000-0000-0000-0000-0000000000bb" as UUID,
      getMemoryById: async (id: UUID) => mem.get(id) ?? null,
      createMemory: async (m: Memory) => {
        mem.set(m.id as string, m);
        return m.id as UUID;
      },
      updateMemory: async (m: Partial<Memory> & { id: UUID }) => {
        const prev = mem.get(m.id as string);
        mem.set(
          m.id as string,
          {
            ...(prev as Memory),
            ...m,
            content: m.content ?? prev?.content,
          } as Memory,
        );
        return true;
      },
      getRoom: async () =>
        "room" in options
          ? options.room
          : {
              channelId: "-1001234567890-42",
              metadata: { telegramThreadId: "42" },
            },
      getService: (serviceType: string) => {
        if (serviceType === "ORCHESTRATOR_TASK_SERVICE") return taskService;
        if (serviceType === "ORCHESTRATOR_TASK_SUPERVISOR") return supervisor;
        return undefined;
      },
    } as unknown as IAgentRuntime;
  }

  it("updates the existing pinned board on supervisor status changes instead of posting a digest", async () => {
    let commandHandler:
      | ((ctx: {
          chat?: { id: number };
          message?: { message_thread_id?: number };
        }) => Promise<void>)
      | undefined;
    let capturedSink:
      | ((
          target: { source: string; roomId: UUID },
          content: unknown,
        ) => Promise<boolean | undefined> | boolean | undefined)
      | undefined;
    const bot = {
      command: vi.fn((_name, handler) => {
        commandHandler = handler;
      }),
      telegram: {
        sendMessage: vi.fn(async () => ({ message_id: 77 })),
        pinChatMessage: vi.fn(async () => undefined),
      },
    };
    const messageManager = {
      editMessage: vi.fn(async () => undefined),
    };
    const runtime = fakeRuntime({
      tasks: [{ id: "1", title: "ship feature", status: "active" }],
      onRegister: (_source, sink) => {
        capturedSink = sink;
      },
    });

    registerTelegramTaskBoardCommand(bot, runtime, messageManager);
    await commandHandler?.({
      chat: { id: -1001234567890 },
      message: { message_thread_id: 42 },
    });

    expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(messageManager.editMessage).not.toHaveBeenCalled();

    (
      runtime.getService("ORCHESTRATOR_TASK_SERVICE") as {
        listTasks: ReturnType<typeof vi.fn>;
      }
    ).listTasks.mockResolvedValueOnce([
      { id: "1", title: "ship feature", status: "validating" },
    ]);
    const handled = await capturedSink?.(
      {
        source: "telegram",
        roomId: "00000000-0000-4000-8000-000000000890" as UUID,
      },
      { text: "digest" },
    );

    expect(handled).toBe(true);
    expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(messageManager.editMessage).toHaveBeenCalledWith(
      "-1001234567890",
      77,
      expect.stringContaining("validating"),
      42,
    );
  });

  it("declines supervisor delivery when the Telegram room cannot be resolved", async () => {
    let capturedSink:
      | ((
          target: { source: string; roomId: UUID },
          content: unknown,
        ) => Promise<boolean | undefined> | boolean | undefined)
      | undefined;
    const runtime = fakeRuntime({
      tasks: entries,
      room: null,
      onRegister: (_source, sink) => {
        capturedSink = sink;
      },
    });
    const board = new TelegramTaskBoard({
      post: vi.fn(async () => ({ messageId: 1 })),
      edit: vi.fn(async () => undefined),
    });

    registerTelegramTaskBoardSupervisorSink(runtime, board);

    await expect(
      capturedSink?.(
        {
          source: "telegram",
          roomId: "00000000-0000-4000-8000-000000000890" as UUID,
        },
        { text: "digest" },
      ),
    ).resolves.toBe(false);
  });

  it("declines a supervisor update for a different Telegram account", async () => {
    const capturedSinks: Array<
      (
        target: { source: string; roomId: UUID; accountId?: string },
        content: unknown,
      ) => Promise<boolean | undefined> | boolean | undefined
    > = [];
    const runtime = fakeRuntime({
      tasks: [{ id: "1", title: "ship feature", status: "active" }],
      room: {
        channelId: "-1001234567890-42",
        metadata: { accountId: "secondary", telegramThreadId: "42" },
      },
      onRegister: (_source, sink) => {
        capturedSinks.push(sink);
      },
    });
    const defaultEdit = vi.fn(async () => undefined);
    const secondaryEdit = vi.fn(async () => undefined);
    const defaultBoard = new TelegramTaskBoard({
      post: vi.fn(async () => ({ messageId: 10 })),
      edit: defaultEdit,
    });
    const secondaryBoard = new TelegramTaskBoard({
      post: vi.fn(async () => ({ messageId: 20 })),
      edit: secondaryEdit,
    });

    await secondaryBoard.render("-1001234567890", entries, 42);
    registerTelegramTaskBoardSupervisorSink(runtime, defaultBoard, "default");
    registerTelegramTaskBoardSupervisorSink(
      runtime,
      secondaryBoard,
      "secondary",
    );

    await expect(
      capturedSinks[0]?.(
        {
          source: "telegram",
          roomId: "00000000-0000-4000-8000-000000000890" as UUID,
        },
        { text: "digest" },
      ),
    ).resolves.toBe(false);
    await expect(
      capturedSinks[1]?.(
        {
          source: "telegram",
          roomId: "00000000-0000-4000-8000-000000000890" as UUID,
        },
        { text: "digest" },
      ),
    ).resolves.toBe(true);

    expect(defaultEdit).not.toHaveBeenCalled();
    expect(secondaryEdit).toHaveBeenCalledWith(
      "-1001234567890",
      20,
      expect.any(String),
      42,
    );
  });
});
