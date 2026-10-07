import { describe, expect, it } from "vitest";
import { matchTodosByContent, sameTodoContent } from "./todo-match.ts";

function todo(content: string) {
  return { content, status: "pending" as const };
}

describe("todo plural stems", () => {
  it("resolves ordinary plurals to the singular todo and not the stripped stem", () => {
    const notes = [todo("not"), todo("note")];
    expect(
      matchTodosByContent("notes", notes).map((row) => row.content),
    ).toEqual(["note"]);

    const files = [todo("filing taxes"), todo("file")];
    expect(
      matchTodosByContent("files", files).map((row) => row.content),
    ).toEqual(["file"]);

    expect(sameTodoContent("make dinner", "makes dinner")).toBe(true);
    expect(sameTodoContent("Buy notes", "Buy not")).toBe(false);
  });

  it("still treats sibilant and -o plurals as the same todo", () => {
    expect(matchTodosByContent("boxes", [todo("box")])).toHaveLength(1);
    expect(matchTodosByContent("dishes", [todo("dish")])).toHaveLength(1);
    expect(matchTodosByContent("watches", [todo("watch")])).toHaveLength(1);
    expect(matchTodosByContent("heroes", [todo("hero")])).toHaveLength(1);
    expect(matchTodosByContent("classes", [todo("class")])).toHaveLength(1);
  });
});
