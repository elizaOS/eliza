import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { clearAll, getTodos } from "../store.js";
import { todoWriteAction } from "./todo-write.js";

function mockRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000000",
    getSetting: () => undefined,
    getService: () => null,
  } as unknown as IAgentRuntime;
}

function makeMessage(roomId = "todos-room"): Memory {
  return { roomId } as unknown as Memory;
}

describe("TODO_WRITE", () => {
  afterEach(() => {
    clearAll();
  });

  it("writes an empty list with zero counts", async () => {
    const result = await todoWriteAction.handler!(
      mockRuntime(),
      makeMessage(),
      undefined,
      { parameters: { todos: [] } },
    );
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.pendingCount).toBe(0);
    expect(data?.inProgressCount).toBe(0);
    expect(data?.completedCount).toBe(0);
  });

  it("writes a mixed list and renders markdown checkboxes", async () => {
    const result = await todoWriteAction.handler!(
      mockRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          todos: [
            { content: "first task", status: "pending" },
            { content: "doing now", status: "in_progress" },
            { content: "old work", status: "completed" },
          ],
        },
      },
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain("[ ] first task");
    expect(result.text).toContain("[→] doing now");
    expect(result.text).toContain("[x] old work");
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.pendingCount).toBe(1);
    expect(data?.inProgressCount).toBe(1);
    expect(data?.completedCount).toBe(1);
  });

  it("returns previous list as oldTodos on replace", async () => {
    await todoWriteAction.handler!(mockRuntime(), makeMessage(), undefined, {
      parameters: { todos: [{ content: "original", status: "pending" }] },
    });
    const result = await todoWriteAction.handler!(
      mockRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: { todos: [{ content: "replacement", status: "completed" }] },
      },
    );
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    const oldTodos = data?.oldTodos as Array<{ content: string }>;
    expect(oldTodos.length).toBe(1);
    expect(oldTodos[0]?.content).toBe("original");
  });

  it("rejects an invalid status", async () => {
    const result = await todoWriteAction.handler!(
      mockRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          todos: [{ content: "foo", status: "weird" }],
        },
      },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
  });

  it("rejects empty content", async () => {
    const result = await todoWriteAction.handler!(
      mockRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          todos: [{ content: "", status: "pending" }],
        },
      },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
  });

  it("fails when todos param is missing", async () => {
    const result = await todoWriteAction.handler!(
      mockRuntime(),
      makeMessage(),
      undefined,
      { parameters: {} },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });

  it("fails when message has no roomId", async () => {
    const result = await todoWriteAction.handler!(
      mockRuntime(),
      {} as unknown as Memory,
      undefined,
      { parameters: { todos: [] } },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("roomId");
  });

  it("populates id and activeForm defaults", async () => {
    const result = await todoWriteAction.handler!(
      mockRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          todos: [{ content: "do thing", status: "pending" }],
        },
      },
    );
    expect(result.success).toBe(true);
    const stored = getTodos("todos-room");
    expect(stored.length).toBe(1);
    expect(stored[0]!.id).toBeTruthy();
    expect(stored[0]!.activeForm).toBe("do thing");
  });
});
