import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  composeTaskBoard,
  createInMemoryBoardStore,
  createRuntimeMemoryBoardStore,
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
