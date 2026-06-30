import type { Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  composeTaskBoard,
  registerTelegramTaskBoardCommand,
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
    const pin = vi.fn(async () => undefined);
    const save = vi.fn(async () => undefined);
    const board = new TelegramTaskBoard({ post, edit, pin, save });

    const id1 = await board.render(100, entries);
    expect(id1).toBe(42);
    expect(post).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
    expect(pin).toHaveBeenCalledWith(100, 42, undefined);
    expect(save).toHaveBeenCalledWith(100, { messageId: 42 }, undefined);

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
    const pin = vi.fn(async () => undefined);
    const save = vi.fn(async () => undefined);
    const board = new TelegramTaskBoard({ post, edit, pin, save });
    await board.render(100, entries); // posts msg 1
    const id = await board.render(100, entries); // edit fails → reposts msg 2
    expect(id).toBe(2);
    expect(post).toHaveBeenCalledTimes(2);
    expect(pin).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(100, { messageId: 2 }, undefined);
  });

  it("loads a persisted board id after restart and edits instead of posting", async () => {
    const post = vi.fn(async () => ({ messageId: 99 }));
    const edit = vi.fn(async () => undefined);
    const load = vi.fn(async () => ({ messageId: 77 }));
    const board = new TelegramTaskBoard({ post, edit, load });

    const id = await board.render(100, entries, 7);

    expect(id).toBe(77);
    expect(load).toHaveBeenCalledWith(100, 7);
    expect(edit).toHaveBeenCalledWith(100, 77, expect.any(String), 7);
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps rendering when pinning fails", async () => {
    const post = vi.fn(async () => ({ messageId: 42 }));
    const edit = vi.fn(async () => undefined);
    const pin = vi.fn(async () => {
      throw new Error("missing pin permission");
    });
    const board = new TelegramTaskBoard({ post, edit, pin });

    await expect(board.render(100, entries)).resolves.toBe(42);
    expect(pin).toHaveBeenCalledTimes(1);
  });
});

describe("registerTelegramTaskBoardCommand (#8902)", () => {
  it("pins and persists the board id, then a fresh command instance edits the persisted message", async () => {
    const memories = new Map<string, Memory>();
    let handler: ((ctx: unknown) => Promise<void>) | undefined;
    const sendMessage = vi.fn(async () => ({ message_id: 42 }));
    const pinChatMessage = vi.fn(async () => true);
    const editMessage = vi.fn(async () => undefined);
    const runtime = {
      agentId: "00000000-0000-0000-0000-0000000000aa" as UUID,
      getMemoryById: vi.fn(async (id: string) => memories.get(id) ?? null),
      upsertMemory: vi.fn(async (memory: Memory) => {
        if (!memory.id) throw new Error("missing memory id");
        memories.set(memory.id, memory);
      }),
      getService: vi.fn(() => ({
        listTasks: vi.fn(async () => [
          { id: "1", title: "ship feature", status: "active" },
        ]),
      })),
    };
    const makeBot = () => ({
      command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
        expect(name).toBe("tasks");
        handler = cb;
      }),
      telegram: { sendMessage, pinChatMessage },
    });

    registerTelegramTaskBoardCommand(
      makeBot() as never,
      runtime as never,
      { editMessage } as never,
      "ops",
    );
    await handler?.({ chat: { id: 100 }, message: { message_thread_id: 7 } });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(pinChatMessage).toHaveBeenCalledWith(100, 42, {
      disable_notification: true,
      message_thread_id: 7,
    });
    expect(runtime.upsertMemory).toHaveBeenCalledTimes(1);
    const persisted = [...memories.values()][0];
    expect(persisted.content.messageId).toBe(42);
    expect(persisted.metadata).toMatchObject({
      type: "custom",
      kind: "telegram_task_board",
      accountId: "ops",
      chatId: "100",
      threadId: 7,
    });

    handler = undefined;
    registerTelegramTaskBoardCommand(
      makeBot() as never,
      runtime as never,
      { editMessage } as never,
      "ops",
    );
    await handler?.({ chat: { id: 100 }, message: { message_thread_id: 7 } });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenCalledWith(100, 42, expect.any(String), 7);
  });
});
