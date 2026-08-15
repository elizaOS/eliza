/**
 * Exercises the Shared Todo host binding against the real Cloud PGlite client
 * and the canonical plugin SQL store; no repository or CRUD behavior is
 * mocked.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

describe("Shared Todo storage", () => {
  let database: typeof import("../../../db/client");
  let closeDatabaseConnectionsForTests: () => Promise<void>;
  let createSharedTodoStore: typeof import("./shared-todos").createSharedTodoStore;
  let readSharedTodoCutoverState: typeof import("./shared-todos").readSharedTodoCutoverState;
  let sharedTodoStorageScope: typeof import("./shared-todos").sharedTodoStorageScope;

  beforeAll(async () => {
    process.env.DATABASE_URL = "pglite://memory";
    const todos = await import("./shared-todos");
    ({ createSharedTodoStore, readSharedTodoCutoverState, sharedTodoStorageScope } = todos);
    database = await import("../../../db/client");
    closeDatabaseConnectionsForTests = database.closeDatabaseConnectionsForTests;
    for (const filename of ["0206_shared_todos.sql", "0207_todo_mutation_ledger.sql"]) {
      await database
        .getPgliteClientForTests()
        .exec(
          await readFile(new URL(`../../../db/migrations/${filename}`, import.meta.url), "utf8"),
        );
    }
  });

  afterAll(async () => {
    await closeDatabaseConnectionsForTests?.();
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  test("derives isolated UUID scopes and returns the complete stable source snapshot", async () => {
    const source = {
      sourceAgentId: "personal:11111111-1111-5111-8111-111111111111",
      ownerId: "22222222-2222-4222-8222-222222222222",
    };
    const otherOwner = { ...source, ownerId: "33333333-3333-4333-8333-333333333333" };
    const scope = sharedTodoStorageScope(source);

    expect(sharedTodoStorageScope(source)).toEqual(scope);
    expect(sharedTodoStorageScope(otherOwner)).not.toEqual(scope);
    expect(scope.agentId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    expect(scope.entityId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    expect(JSON.stringify(scope)).not.toContain("personal:");
    expect(() => sharedTodoStorageScope({ sourceAgentId: " ", ownerId: source.ownerId })).toThrow(
      "Shared Todo storage scope is incomplete",
    );

    const store = createSharedTodoStore();
    for (const [index, todo] of [
      {
        content: "Pending task",
        activeForm: "Handling pending task",
        status: "pending" as const,
      },
      {
        content: "Completed task",
        activeForm: "Completing task",
        status: "completed" as const,
      },
      {
        content: "Cancelled task",
        activeForm: "Cancelling task",
        status: "cancelled" as const,
      },
    ].entries()) {
      await store.applyMutation({
        scope,
        idempotencyKey: `telegram:source-message-${index}:action-0`,
        mutation: { action: "create", input: todo },
      });
    }
    await store.applyMutation({
      scope: sharedTodoStorageScope(otherOwner),
      idempotencyKey: "telegram:other-owner:action-0",
      mutation: {
        action: "create",
        input: {
          content: "Another owner's task",
          activeForm: "Handling another owner's task",
          status: "pending",
        },
      },
    });

    const snapshot = await readSharedTodoCutoverState(source);
    expect(snapshot.todos).toHaveLength(3);
    expect(snapshot.todos.map((todo) => todo.status).sort()).toEqual([
      "cancelled",
      "completed",
      "pending",
    ]);
    expect(snapshot.todos).toEqual(
      [...snapshot.todos].sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      ),
    );
    expect(snapshot.todos.every((todo) => todo.agentId === scope.agentId)).toBe(true);
    expect(snapshot.todos.every((todo) => todo.entityId === scope.entityId)).toBe(true);
    expect(snapshot.mutations).toHaveLength(3);
    expect(snapshot.mutations).toEqual(
      [...snapshot.mutations].sort(
        (left, right) =>
          Date.parse(left.committedAt) - Date.parse(right.committedAt) ||
          left.mutationId.localeCompare(right.mutationId),
      ),
    );
    expect(
      snapshot.mutations.every(
        (mutation) =>
          mutation.version === 1 &&
          mutation.operation === "create" &&
          /^[a-f0-9]{64}$/.test(mutation.requestDigest),
      ),
    ).toBe(true);
    expect(
      await readSharedTodoCutoverState({
        sourceAgentId: "personal:44444444-4444-5444-8444-444444444444",
        ownerId: "55555555-5555-4555-8555-555555555555",
      }),
    ).toEqual({ todos: [], mutations: [] });

    await database.getPgliteClientForTests().exec("DROP TABLE todos.todo_mutations");
    await expect(readSharedTodoCutoverState(source)).rejects.toThrow("todo_mutations");
  });
});
