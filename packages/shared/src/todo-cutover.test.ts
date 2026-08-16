/** Verifies the cross-runtime Todo cutover wire, bounds, and digest integrity. */

import { describe, expect, it } from "vitest";
import {
  createSharedTodoCutoverSnapshot,
  MAX_SHARED_TODO_CUTOVER_BYTES,
  MAX_SHARED_TODO_CUTOVER_COUNT,
  MAX_SHARED_TODO_CUTOVER_MUTATION_COUNT,
  parseSharedTodoCutoverSnapshot,
  TodoCutoverContractError,
} from "./todo-cutover.js";

const uuid = (suffix: number) =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

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

const mutation = (
  mutationId: string,
  idempotencyKey: string,
  overrides: Record<string, unknown> = {},
) => ({
  version: 1,
  mutationId,
  idempotencyKey,
  requestDigest: "a".repeat(64),
  operation: "clear",
  applied: true,
  resultJson: { version: 1, result: { action: "clear", count: 1 } },
  committedAt: "2026-08-14T11:00:00.000Z",
  ...overrides,
});

describe("Shared Todo cutover contract", () => {
  it("sorts records and produces a stable verified digest", async () => {
    const first = await createSharedTodoCutoverSnapshot({
      sourceAgentId: "personal:source",
      todos: [record(uuid(2), uuid(1)), record(uuid(1))],
      mutations: [
        mutation(uuid(102), "turn-2", {
          resultJson: { z: 1, A: { y: 2, x: 1 } },
        }),
        mutation(uuid(101), "turn-1"),
      ],
    });
    const second = await createSharedTodoCutoverSnapshot({
      sourceAgentId: "personal:source",
      todos: [record(uuid(1)), record(uuid(2), uuid(1))],
      mutations: [
        mutation(uuid(101).toUpperCase(), "turn-1"),
        mutation(uuid(102), "turn-2", {
          resultJson: { A: { x: 1, y: 2 }, z: 1 },
        }),
      ],
    });

    expect(first).toEqual(second);
    expect(first.todos.map((todo) => todo.sourceId)).toEqual([
      uuid(1),
      uuid(2),
    ]);
    expect(first.mutations.map((entry) => entry.mutationId)).toEqual([
      uuid(101),
      uuid(102),
    ]);
    expect(first.mutations[1].resultJson).toEqual({
      A: { x: 1, y: 2 },
      z: 1,
    });
    await expect(parseSharedTodoCutoverSnapshot(first)).resolves.toEqual(first);
  });

  it("orders mutations by canonical commit time before mutation id", async () => {
    const snapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: "personal:source",
      todos: [],
      mutations: [
        mutation(uuid(202), "later", {
          committedAt: "2026-08-14T12:00:00.000Z",
        }),
        mutation(uuid(203), "earlier-high-id", {
          committedAt: "2026-08-14T09:00:00-02:00",
        }),
        mutation(uuid(201), "earlier-low-id"),
      ],
    });

    expect(
      snapshot.mutations.map((entry) => [entry.committedAt, entry.mutationId]),
    ).toEqual([
      ["2026-08-14T11:00:00.000Z", uuid(201)],
      ["2026-08-14T11:00:00.000Z", uuid(203)],
      ["2026-08-14T12:00:00.000Z", uuid(202)],
    ]);
  });

  it("uses runtime-independent code-unit ordering and canonical metadata", async () => {
    const snapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: "personal:source",
      todos: [
        { ...record(uuid(11)), metadata: { z: 1, A: { y: 2, x: 1 } } },
        {
          ...record(uuid(10)),
          metadata: { A: { x: 1, y: 2 }, z: 1 },
        },
      ],
      mutations: [],
    });

    expect(snapshot.todos.map((todo) => todo.sourceId)).toEqual([
      uuid(10),
      uuid(11),
    ]);
    expect(Object.keys(snapshot.todos[0].metadata)).toEqual(["A", "z"]);
    expect(Object.keys(snapshot.todos[0].metadata.A as object)).toEqual([
      "x",
      "y",
    ]);
  });

  it("rejects tampering and incomplete parent snapshots", async () => {
    const snapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: "personal:source",
      todos: [record(uuid(1))],
      mutations: [mutation(uuid(101), "turn-1")],
    });
    await expect(
      parseSharedTodoCutoverSnapshot({
        ...snapshot,
        todos: [{ ...snapshot.todos[0], content: "tampered" }],
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_DIGEST_MISMATCH" });
    await expect(
      parseSharedTodoCutoverSnapshot({
        ...snapshot,
        mutations: [{ ...snapshot.mutations[0], applied: false }],
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_DIGEST_MISMATCH" });
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [record(uuid(2), uuid(1))],
        mutations: [],
      }),
    ).rejects.toBeInstanceOf(TodoCutoverContractError);
  });

  it("requires exact v2 arrays and accepts a digest-bound empty snapshot", async () => {
    const snapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: "personal:source",
      todos: [],
      mutations: [],
    });
    await expect(parseSharedTodoCutoverSnapshot(snapshot)).resolves.toEqual(
      snapshot,
    );
    await expect(
      parseSharedTodoCutoverSnapshot({ ...snapshot, version: 1 }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_INVALID_VERSION" });
    await expect(
      parseSharedTodoCutoverSnapshot({
        version: snapshot.version,
        sourceAgentId: snapshot.sourceAgentId,
        todos: snapshot.todos,
        digest: snapshot.digest,
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_INVALID_MUTATIONS" });
    await expect(
      parseSharedTodoCutoverSnapshot({
        version: snapshot.version,
        sourceAgentId: snapshot.sourceAgentId,
        mutations: snapshot.mutations,
        digest: snapshot.digest,
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_INVALID_RECORDS" });
  });

  it("enforces record, hierarchy, and reserved-metadata bounds", async () => {
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: Array.from(
          { length: MAX_SHARED_TODO_CUTOVER_COUNT + 1 },
          (_, index) => record(uuid(index + 1)),
        ),
        mutations: [],
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_TOO_MANY_RECORDS" });
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [],
        mutations: Array.from(
          { length: MAX_SHARED_TODO_CUTOVER_MUTATION_COUNT + 1 },
          (_, index) => mutation(uuid(index + 10_000), `mutation-${index}`),
        ),
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_TOO_MANY_MUTATIONS" });
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [record(uuid(1), uuid(2)), record(uuid(2), uuid(1))],
        mutations: [],
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_PARENT_CYCLE" });
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [
          {
            ...record(uuid(1)),
            metadata: { __elizaSharedTodoImport: { forged: true } },
          },
        ],
        mutations: [],
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_RESERVED_METADATA" });
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [],
        mutations: [
          mutation(uuid(101), "oversized", {
            resultJson: {
              payload: "x".repeat(MAX_SHARED_TODO_CUTOVER_BYTES),
            },
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_PAYLOAD_TOO_LARGE" });
  });

  it.each([
    ["wire version", { version: 2 }, "TODO_CUTOVER_INVALID_MUTATION_VERSION"],
    [
      "blank idempotency key",
      { idempotencyKey: "   " },
      "TODO_CUTOVER_INVALID_FIELD",
    ],
    [
      "oversized idempotency key",
      { idempotencyKey: "x".repeat(1_025) },
      "TODO_CUTOVER_FIELD_TOO_LARGE",
    ],
    [
      "uppercase digest",
      { requestDigest: "A".repeat(64) },
      "TODO_CUTOVER_INVALID_REQUEST_DIGEST",
    ],
    [
      "non-mutating operation",
      { operation: "list" },
      "TODO_CUTOVER_INVALID_MUTATION_OPERATION",
    ],
    ["applied flag", { applied: "yes" }, "TODO_CUTOVER_INVALID_FIELD"],
    [
      "non-JSON result",
      { resultJson: { count: Number.NaN } },
      "TODO_CUTOVER_INVALID_METADATA",
    ],
    [
      "commit timestamp",
      { committedAt: "not-a-time" },
      "TODO_CUTOVER_INVALID_TIMESTAMP",
    ],
    [
      "non-ISO commit timestamp",
      { committedAt: "August 14, 2026 10:00:00" },
      "TODO_CUTOVER_INVALID_TIMESTAMP",
    ],
    [
      "impossible ISO calendar date",
      { committedAt: "2026-02-30T10:00:00Z" },
      "TODO_CUTOVER_INVALID_TIMESTAMP",
    ],
  ])("rejects invalid mutation %s", async (_label, overrides, code) => {
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [],
        mutations: [mutation(uuid(101), "turn-1", overrides)],
      }),
    ).rejects.toMatchObject({ code });
  });

  it("normalizes UUIDs before duplicate and hierarchy checks", async () => {
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [record("not-a-uuid")],
        mutations: [],
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_INVALID_UUID" });

    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [record(uuid(1)), record(uuid(1).toUpperCase())],
        mutations: [],
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_DUPLICATE_ID" });

    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [],
        mutations: [mutation("not-a-uuid", "turn-1")],
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_INVALID_UUID" });
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [],
        mutations: [
          mutation(uuid(101), "turn-1"),
          mutation(uuid(101).toUpperCase(), "turn-2"),
        ],
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_DUPLICATE_MUTATION_ID" });
  });

  it("rejects duplicate idempotency keys independently of mutation ids", async () => {
    await expect(
      createSharedTodoCutoverSnapshot({
        sourceAgentId: "personal:source",
        todos: [],
        mutations: [
          mutation(uuid(101), "same-turn"),
          mutation(uuid(102), "same-turn"),
        ],
      }),
    ).rejects.toMatchObject({
      code: "TODO_CUTOVER_DUPLICATE_IDEMPOTENCY_KEY",
    });
  });
});
