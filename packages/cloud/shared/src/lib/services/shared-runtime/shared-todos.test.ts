/**
 * Exercises the Shared Todo host binding against the real Cloud PGlite client
 * and the canonical plugin SQL store; no repository or CRUD behavior is
 * mocked.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

describe("Shared Todo storage", () => {
  let closeDatabaseConnectionsForTests: () => Promise<void>;
  let createSharedTodoStore: typeof import("./shared-todos").createSharedTodoStore;
  let listSharedTodosSnapshot: typeof import("./shared-todos").listSharedTodosSnapshot;
  let sharedTodoStorageScope: typeof import("./shared-todos").sharedTodoStorageScope;

  beforeAll(async () => {
    process.env.DATABASE_URL = "pglite://memory";
    const todos = await import("./shared-todos");
    ({ createSharedTodoStore, listSharedTodosSnapshot, sharedTodoStorageScope } = todos);
    const database = await import("../../../db/client");
    closeDatabaseConnectionsForTests = database.closeDatabaseConnectionsForTests;
    const migration = await readFile(
      new URL("../../../db/migrations/0206_shared_todos.sql", import.meta.url),
      "utf8",
    );
    await database.getPgliteClientForTests().exec(migration);
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
    await store.create({
      ...scope,
      content: "Pending task",
      activeForm: "Handling pending task",
      status: "pending",
    });
    await store.create({
      ...scope,
      content: "Completed task",
      activeForm: "Completing task",
      status: "completed",
    });
    await store.create({
      ...scope,
      content: "Cancelled task",
      activeForm: "Cancelling task",
      status: "cancelled",
    });
    await store.create({
      ...sharedTodoStorageScope(otherOwner),
      content: "Another owner's task",
      activeForm: "Handling another owner's task",
      status: "pending",
    });

    const snapshot = await listSharedTodosSnapshot(source);
    expect(snapshot).toHaveLength(3);
    expect(snapshot.map((todo) => todo.status).sort()).toEqual([
      "cancelled",
      "completed",
      "pending",
    ]);
    expect(snapshot.map((todo) => todo.id)).toEqual(
      snapshot.map((todo) => todo.id).sort((left, right) => left.localeCompare(right)),
    );
    expect(snapshot.every((todo) => todo.agentId === scope.agentId)).toBe(true);
    expect(snapshot.every((todo) => todo.entityId === scope.entityId)).toBe(true);
    expect(
      await listSharedTodosSnapshot({
        sourceAgentId: "personal:44444444-4444-5444-8444-444444444444",
        ownerId: "55555555-5555-4555-8555-555555555555",
      }),
    ).toEqual([]);
  });
});
