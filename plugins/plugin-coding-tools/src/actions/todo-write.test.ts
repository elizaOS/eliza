import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";

import { getTodos, todoWriteAction } from "./todo-write.js";

function makeRuntime(): IAgentRuntime {
  return {
    getSetting: () => undefined,
  } as unknown as IAgentRuntime;
}

function makeMessage(roomId: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001" as UUID,
    entityId: "00000000-0000-0000-0000-000000000002" as UUID,
    roomId: roomId as UUID,
    content: { text: "" },
  } as unknown as Memory;
}

async function invoke(roomId: string, params: Record<string, unknown>) {
  const runtime = makeRuntime();
  const message = makeMessage(roomId);
  return todoWriteAction.handler!(runtime, message, undefined, { parameters: params });
}

describe("todoWriteAction", () => {
  it("accepts an empty list with all counts at zero", async () => {
    const roomId = `room-empty-${Date.now()}`;
    const result = await invoke(roomId, { todos: [] });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.completedCount).toBe(0);
    expect(data?.pendingCount).toBe(0);
    expect(data?.inProgressCount).toBe(0);
    expect(data?.newTodos).toEqual([]);
    expect(getTodos(roomId)).toEqual([]);
  });

  it("renders mixed-status todos with correct boxes and counts", async () => {
    const roomId = `room-mixed-${Date.now()}`;
    const result = await invoke(roomId, {
      todos: [
        { content: "Read file", status: "completed" },
        { content: "Edit module", status: "in_progress", activeForm: "Editing module" },
        { content: "Run tests", status: "pending" },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("- [x] Read file");
    expect(result.text).toContain("- [→] Edit module");
    expect(result.text).toContain("- [ ] Run tests");

    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.completedCount).toBe(1);
    expect(data?.inProgressCount).toBe(1);
    expect(data?.pendingCount).toBe(1);

    const stored = getTodos(roomId);
    expect(stored).toHaveLength(3);
    expect(stored[0]!.activeForm).toBe("Read file"); // defaults to content
    expect(stored[1]!.activeForm).toBe("Editing module");
    expect(stored[0]!.id).toBeTruthy();
  });

  it("returns prior list as oldTodos when replacing", async () => {
    const roomId = `room-replace-${Date.now()}`;
    await invoke(roomId, {
      todos: [{ content: "First", status: "pending" }],
    });
    const result = await invoke(roomId, {
      todos: [{ content: "Second", status: "completed" }],
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    const oldTodos = data?.oldTodos as Array<Record<string, unknown>>;
    expect(oldTodos).toHaveLength(1);
    expect(oldTodos[0]!.content).toBe("First");
    expect(oldTodos[0]!.status).toBe("pending");

    const newTodos = data?.newTodos as Array<Record<string, unknown>>;
    expect(newTodos).toHaveLength(1);
    expect(newTodos[0]!.content).toBe("Second");
  });

  it("rejects an invalid status", async () => {
    const roomId = `room-invalid-${Date.now()}`;
    const result = await invoke(roomId, {
      todos: [{ content: "Bad", status: "broken" }],
    });
    expect(result.success).toBe(false);
    expect(result.text).toMatch(/status/);
  });
});
