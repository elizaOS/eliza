/**
 * Unit tests for the pinned task board: `composeTaskBoard` rendering (status
 * emoji, closed tail, empty state) and the board's edit-in-place behavior —
 * post on first render, edit the same message thereafter, with separate boards
 * per chat/thread. Bot API calls are mocked.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type BoardMessageStore,
  composeTaskBoard,
  createInMemoryBoardStore,
  createRuntimeMemoryBoardStore,
  registerTelegramTaskBoardCommand,
  registerTelegramTaskBoardSupervisorSink,
  type TaskBoardEntry,
  TelegramTaskBoard,
  taskBoardEmoji,
} from "./task-board";

/**
 * A store whose load/save/forget each await a microtask, mirroring the
 * runtime-memory store's real DB round-trips (getMemoryById → update/create).
 * This yields to the event loop mid-operation, which is exactly the window that
 * let two concurrent first renders both observe `undefined` before the fix.
 */
function asyncBoardStore(
  seed?: Map<string, number>,
): BoardMessageStore & { map: Map<string, number> } {
  const map = seed ?? new Map<string, number>();
  return {
    map,
    load: async (key) => {
      await Promise.resolve();
      return map.get(key);
    },
    save: async (key, id) => {
      await Promise.resolve();
      map.set(key, id);
    },
    forget: async (key) => {
      await Promise.resolve();
      map.delete(key);
    },
  };
}

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

describe("TelegramTaskBoard concurrent render serialization (#29899, #8902 AC3)", () => {
  it("posts exactly once when two first renders race for the same board", async () => {
    let next = 0;
    const post = vi.fn(async () => ({ messageId: ++next }));
    const edit = vi.fn(async () => undefined);
    const pin = vi.fn(async () => undefined);
    const store = asyncBoardStore();
    const board = new TelegramTaskBoard({ post, edit, pin, store });

    // Fire both concurrently (e.g. the supervisor sink + a `/tasks` command)
    // for the SAME (chat, thread). Without serialization both would observe
    // `existing === undefined`, both post, and both pin — a duplicate board.
    const [id1, id2] = await Promise.all([
      board.render(100, entries),
      board.render(100, entries),
    ]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
    // Both callers resolve to the single posted board id.
    expect(id1).toBe(1);
    expect(id2).toBe(1);
    // Exactly one id is persisted — no orphaned message.
    expect(store.map.get("100:")).toBe(1);
    // The in-flight chain is cleared once both settle.
    expect(
      (board as unknown as { inFlight: Map<string, unknown> }).inFlight.size,
    ).toBe(0);
  });

  it("only edits (never posts) when a stored id already exists under concurrency", async () => {
    const post = vi.fn(async () => ({ messageId: 999 }));
    const edit = vi.fn(async () => undefined);
    const pin = vi.fn(async () => undefined);
    // Seed the store as if a board was posted in a prior process (restart).
    const store = asyncBoardStore(new Map([["100:", 55]]));
    const board = new TelegramTaskBoard({ post, edit, pin, store });

    const ids = await Promise.all([
      board.render(100, entries),
      board.render(100, entries),
      board.render(100, entries),
    ]);

    expect(post).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledTimes(3);
    expect(ids).toEqual([55, 55, 55]);
    for (const call of edit.mock.calls) {
      expect(call).toEqual([100, 55, expect.any(String), undefined]);
    }
  });

  it("reposts exactly once when the first edit fails mid-race (message deleted)", async () => {
    let next = 10;
    const post = vi.fn(async () => ({ messageId: ++next }));
    // First edit rejects (board message was deleted); later edits succeed.
    const edit = vi
      .fn()
      .mockRejectedValueOnce(new Error("message to edit not found"))
      .mockResolvedValue(undefined);
    const pin = vi.fn(async () => undefined);
    const store = asyncBoardStore(new Map([["100:", 55]]));
    const board = new TelegramTaskBoard({ post, edit, pin, store });

    const ids = await Promise.all([
      board.render(100, entries),
      board.render(100, entries),
    ]);

    // The failed edit forgets the stale id and reposts a single fresh board;
    // the second render then edits that reposted board in place.
    expect(post).toHaveBeenCalledTimes(1);
    expect(ids[0]).toBe(11);
    expect(ids[1]).toBe(11);
    expect(store.map.get("100:")).toBe(11);
    expect(pin).toHaveBeenCalledTimes(1);
  });

  it("serializes forget() with an in-flight render so a reset can't strand the store mid-edit", async () => {
    // Reproduces the latent race called out in review: forget() mutates the
    // same (chat, thread) key as render. If it ran outside the chain it could
    // delete a stored id WHILE a render is blocked inside edit() — the render
    // then returns the existing id without re-saving, leaving the store empty
    // while a live pinned board still exists, so the next render double-posts.
    let releaseEdit: () => void = () => {};
    const editGate = new Promise<void>((resolve) => {
      releaseEdit = resolve;
    });
    const post = vi.fn(async () => ({ messageId: 999 }));
    const edit = vi.fn(async () => {
      await editGate;
    });
    // Seed a stored board id, as if posted in a prior process.
    const store = asyncBoardStore(new Map([["100:", 55]]));
    const board = new TelegramTaskBoard({ post, edit, store });

    // A render is in flight and blocked inside edit(); a concurrent reset asks
    // to forget the same board and must queue behind the render.
    const rendering = board.render(100, entries);
    const forgetting = board.forget(100);

    // Let the render reach edit() and the forget settle into the queue.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(edit).toHaveBeenCalledTimes(1);
    // forget is queued, NOT yet applied — the id survives mid-edit.
    expect(store.map.get("100:")).toBe(55);

    releaseEdit();
    const id = await rendering;
    await forgetting;

    // The render edited the existing board (no double-post); forget applied only
    // after the render completed.
    expect(id).toBe(55);
    expect(post).not.toHaveBeenCalled();
    expect(store.map.has("100:")).toBe(false);

    // A later render after the reset posts exactly one fresh board.
    const id2 = await board.render(100, entries);
    expect(id2).toBe(999);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a failed op on the chain does not abort a later render for the same board", async () => {
    // Pins the documented `enqueue` guarantee: `await prior.catch(() =>
    // undefined)` waits for the prior op to SETTLE, not succeed, so a rejected
    // predecessor must not propagate into a later op's promise. This is
    // reachable in production because `enqueue` is generic — `forget` rides it
    // too — and any op that actually rejects would otherwise make every queued
    // render for that board fail with an unrelated earlier error. Fails against
    // the `await prior;` mutant (no `.catch`) and no other.
    let next = 0;
    const post = vi.fn(async () => ({ messageId: ++next }));
    const edit = vi.fn(async () => undefined);
    const pin = vi.fn(async () => undefined);
    const store = asyncBoardStore();
    let failNextSave = true;
    const failingStore: BoardMessageStore & { map: Map<string, number> } = {
      ...store,
      save: async (key, id) => {
        if (failNextSave) {
          failNextSave = false;
          throw new Error("db write failed");
        }
        return store.save(key, id);
      },
    };
    const board = new TelegramTaskBoard({
      post,
      edit,
      pin,
      store: failingStore,
    });

    // First render's save rejects, so its chain promise rejects.
    const first = board.render(100, entries).catch((e) => e);
    // Second render queues behind it and must still resolve on its own merit.
    const second = board.render(100, entries);

    await first;
    await expect(second).resolves.toBeTypeOf("number");
    // The later render posted and persisted its own board despite the earlier
    // failure — no id was stranded by the predecessor's rejection.
    expect(store.map.get("100:")).toBe(2);
  });

  it("a render started after an earlier one settles still serializes behind the queued one", async () => {
    // Pins the tail check `if (this.inFlight.get(key) === run)` on the chain
    // cleanup. With three renders A→B→C: A settles while B is still queued, and
    // only THEN does C arrive. The tail check keeps the map entry pointing at B
    // (not A) so C serializes behind B. An unconditional `delete` in A's finally
    // would empty the map, C would read `prior === undefined`, start a fresh
    // chain, and enter edit() alongside the still-in-flight B — serialization
    // genuinely lost. Fails against that mutant (edit called twice) and no other.
    let next = 0;
    const post = vi.fn(async () => ({ messageId: ++next }));
    const pin = vi.fn(async () => undefined);
    const store = asyncBoardStore();

    let releaseEdit: () => void = () => {};
    const editGate = new Promise<void>((resolve) => {
      releaseEdit = resolve;
    });
    let editCalls = 0;
    const edit = vi.fn(async () => {
      editCalls += 1;
      if (editCalls === 1) await editGate; // hold B inside its op
      return undefined;
    });

    const board = new TelegramTaskBoard({ post, edit, pin, store });

    // A posts and settles. B queues behind A and then blocks inside edit().
    const a = board.render(100, entries);
    const b = board.render(100, entries);
    await a;
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // C starts while B is still in flight; it must serialize behind B.
    const c = board.render(100, entries);
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // C has not entered edit() — only B has, and B is still blocked.
    expect(edit).toHaveBeenCalledTimes(1);

    releaseEdit();
    await Promise.all([b, c]);
    // A posted the single board; B and C both edited it in place.
    expect(post).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it("keeps distinct (chat, thread) keys unserialized from each other", async () => {
    let next = 0;
    const post = vi.fn(async () => ({ messageId: ++next }));
    const edit = vi.fn(async () => undefined);
    const store = asyncBoardStore();
    const board = new TelegramTaskBoard({ post, edit, store });

    // Different threads / chats are independent boards — each posts once.
    await Promise.all([
      board.render(100, entries),
      board.render(100, entries, 7),
      board.render(200, entries),
    ]);

    expect(post).toHaveBeenCalledTimes(3);
    expect(edit).not.toHaveBeenCalled();
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
