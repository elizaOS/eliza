/** Verifies the cross-runtime Todo cutover wire, bounds, and digest integrity. */

import { describe, expect, it } from "vitest";
import {
  createSharedTodoCutoverSnapshot,
  MAX_SHARED_TODO_CUTOVER_BYTES,
  MAX_SHARED_TODO_CUTOVER_COUNT,
  parseSharedTodoCutoverSnapshot,
  TodoCutoverContractError,
} from "./todo-cutover.js";

const record = (sourceId: string, parentSourceId: string | null = null) => ({
  sourceId,
  roomId: null,
  worldId: null,
  content: `Todo ${sourceId}`,
  activeForm: `Doing ${sourceId}`,
  status: "pending",
  parentSourceId,
  parentTrajectoryStepId: null,
  metadata: { nested: { b: 2, a: 1 } },
  createdAt: "2026-08-14T10:00:00.000Z",
  updatedAt: "2026-08-14T11:00:00.000Z",
  completedAt: null,
});

describe("Shared Todo cutover contract", () => {
  it("sorts records and produces a stable verified digest", async () => {
    const first = await createSharedTodoCutoverSnapshot({
      sourceAgentId: "personal:source",
      todos: [record("b", "a"), record("a")],
    });
    const second = await createSharedTodoCutoverSnapshot({
      sourceAgentId: "personal:source",
      todos: [record("a"), record("b", "a")],
    });

    expect(first).toEqual(second);
    expect(first.todos.map((todo) => todo.sourceId)).toEqual(["a", "b"]);
    await expect(parseSharedTodoCutoverSnapshot(first)).resolves.toEqual(first);
  });

  it("uses runtime-independent code-unit ordering and canonical metadata", async () => {
    const snapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: "personal:source",
      todos: [
        { ...record("a"), metadata: { z: 1, A: { y: 2, x: 1 } } },
        { ...record("B"), metadata: { A: { x: 1, y: 2 }, z: 1 } },
      ],
    });

    expect(snapshot.todos.map((todo) => todo.sourceId)).toEqual(["B", "a"]);
    expect(Object.keys(snapshot.todos[0].metadata)).toEqual(["A", "z"]);
    expect(Object.keys(snapshot.todos[0].metadata.A as object)).toEqual([
      "x",
      "y",
    ]);
  });

  it("rejects tampering and incomplete parent snapshots", async () => {
    const snapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: "personal:source",
      todos: [record("a")],
    });
    await expect(
      parseSharedTodoCutoverSnapshot({
        ...snapshot,
        todos: [{ ...snapshot.todos[0], content: "tampered" }],
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_DIGEST_MISMATCH" });
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [record("child", "missing")],
      }),
    ).rejects.toBeInstanceOf(TodoCutoverContractError);
  });

  it("accepts a digest-bound empty snapshot instead of treating it as missing", async () => {
    const snapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: "personal:source",
      todos: [],
    });
    await expect(parseSharedTodoCutoverSnapshot(snapshot)).resolves.toEqual(
      snapshot,
    );
  });

  it("enforces record, hierarchy, and reserved-metadata bounds", async () => {
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: Array.from(
          { length: MAX_SHARED_TODO_CUTOVER_COUNT + 1 },
          (_, index) => record(String(index)),
        ),
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_TOO_MANY_RECORDS" });
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [record("a", "b"), record("b", "a")],
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_PARENT_CYCLE" });
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [
          {
            ...record("a"),
            metadata: { __elizaSharedTodoImport: { forged: true } },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_RESERVED_METADATA" });
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [
          {
            ...record("oversized"),
            metadata: { payload: "x".repeat(MAX_SHARED_TODO_CUTOVER_BYTES) },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_PAYLOAD_TOO_LARGE" });
  });
});
