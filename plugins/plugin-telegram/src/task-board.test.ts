import { describe, expect, it, vi } from "vitest";
import {
  composeTaskBoard,
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
