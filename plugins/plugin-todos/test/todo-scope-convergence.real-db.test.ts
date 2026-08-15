/**
 * Real-PGlite proof that provisional identities can merge Todo rows and replay
 * authority without losing UUIDs, crossing tenants, or surviving a rollback.
 */

import type { AgentRuntime, UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app-core/test/helpers/real-runtime.ts";
import todosPlugin from "../src/index.ts";
import {
  convergeTodoScopesInTransaction,
  createTodosSqlStore,
  TODO_IDEMPOTENCY_CONFLICT_ERROR_CODE,
  TODO_SCOPE_CONVERGENCE_ERROR_CODE,
} from "../src/sql-store.ts";
import type { TodoScope, TodoStore } from "../src/store.ts";

describe("Todo identity-scope convergence — real PGlite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let db: NodePgDatabase;
  let store: TodoStore;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "todo-scope-convergence-real-db",
      plugins: [todosPlugin],
    });
    runtime = testResult.runtime;
    db = runtime.db as NodePgDatabase;
    store = createTodosSqlStore(db);
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  function newScope(): TodoScope {
    return {
      agentId: crypto.randomUUID() as UUID,
      entityId: crypto.randomUUID() as UUID,
    };
  }

  it("moves exact rows and replay authority with a deterministic receipt", async () => {
    const sourceScope = newScope();
    const targetScope = newScope();
    const sourceRoomId = crypto.randomUUID() as UUID;
    const targetRoomId = crypto.randomUUID() as UUID;
    const sourceWorldId = crypto.randomUUID() as UUID;
    const targetWorldId = crypto.randomUUID() as UUID;
    const targetBaseline = await store.applyMutation({
      scope: targetScope,
      idempotencyKey: "target-baseline",
      mutation: {
        action: "create",
        input: { content: "Keep target state unchanged" },
      },
    });
    if (targetBaseline.result.action !== "create") {
      throw new Error("Expected target baseline creation");
    }
    const parent = await store.applyMutation({
      scope: sourceScope,
      idempotencyKey: "source-parent",
      mutation: {
        action: "create",
        input: {
          roomId: sourceRoomId,
          worldId: sourceWorldId,
          content: "Preserve the parent",
        },
      },
    });
    if (parent.result.action !== "create") {
      throw new Error("Expected source parent creation");
    }
    const child = await store.applyMutation({
      scope: sourceScope,
      idempotencyKey: "source-child",
      mutation: {
        action: "create",
        input: {
          roomId: sourceRoomId,
          worldId: sourceWorldId,
          content: "Preserve the child",
          parentTodoId: parent.result.todo.id,
        },
      },
    });
    if (child.result.action !== "create") {
      throw new Error("Expected source child creation");
    }
    const sourceBefore = await store.readCutoverState(sourceScope);
    const targetBefore = await store.readCutoverState(targetScope);
    const input = {
      sourceScope,
      targetScope,
      roomIdMap: { [sourceRoomId]: targetRoomId },
      worldIdMap: { [sourceWorldId]: targetWorldId },
    };

    let rolledBackReceipt:
      | Awaited<ReturnType<typeof convergeTodoScopesInTransaction>>
      | undefined;
    await expect(
      db.transaction(async (tx) => {
        rolledBackReceipt = await convergeTodoScopesInTransaction(tx, input);
        throw new Error("force convergence rollback");
      }),
    ).rejects.toThrow("force convergence rollback");
    expect(await store.readCutoverState(sourceScope)).toEqual(sourceBefore);
    expect(await store.readCutoverState(targetScope)).toEqual(targetBefore);

    const receipt = await db.transaction((tx) =>
      convergeTodoScopesInTransaction(tx, input),
    );
    expect(receipt).toEqual(rolledBackReceipt);
    expect(receipt).toMatchObject({
      sourceTodoCount: 2,
      sourceMutationCount: 2,
    });
    expect(receipt.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.readCutoverState(sourceScope)).toEqual({
      todos: [],
      mutations: [],
    });

    const targetAfter = await store.readCutoverState(targetScope);
    expect(targetAfter.todos).toHaveLength(3);
    expect(targetAfter.mutations).toHaveLength(3);
    expect(
      targetAfter.todos.find(
        (todo) => todo.id === targetBaseline.result.todo.id,
      ),
    ).toEqual(targetBefore.todos[0]);
    expect(
      targetAfter.mutations.find(
        (mutation) => mutation.mutationId === targetBaseline.mutationId,
      ),
    ).toEqual(targetBefore.mutations[0]);
    expect(
      targetAfter.todos.find((todo) => todo.id === parent.result.todo.id),
    ).toMatchObject({
      ...targetScope,
      id: parent.result.todo.id,
      roomId: targetRoomId,
      worldId: targetWorldId,
    });
    expect(
      targetAfter.todos.find((todo) => todo.id === child.result.todo.id),
    ).toMatchObject({
      ...targetScope,
      id: child.result.todo.id,
      parentTodoId: parent.result.todo.id,
      roomId: targetRoomId,
      worldId: targetWorldId,
    });

    const replay = await store.applyMutation({
      scope: targetScope,
      idempotencyKey: "source-parent",
      mutation: {
        action: "create",
        input: {
          roomId: targetRoomId,
          worldId: targetWorldId,
          parentTrajectoryStepId: "retry-after-identity-merge",
          content: "Preserve the parent",
        },
      },
    });
    expect(replay).toMatchObject({
      mutationId: parent.mutationId,
      replayed: true,
      committedAt: parent.committedAt,
      result: {
        action: "create",
        todo: {
          ...targetScope,
          id: parent.result.todo.id,
          roomId: targetRoomId,
          worldId: targetWorldId,
        },
      },
    });
    expect(
      await db.transaction((tx) => convergeTodoScopesInTransaction(tx, input)),
    ).toMatchObject({ sourceTodoCount: 0, sourceMutationCount: 0 });
    expect((await store.readCutoverState(targetScope)).todos).toHaveLength(3);
  }, 180_000);

  it("rolls back both scopes on any target idempotency-key conflict", async () => {
    const sourceScope = newScope();
    const targetScope = newScope();
    await store.applyMutation({
      scope: sourceScope,
      idempotencyKey: "identity-collision",
      mutation: {
        action: "create",
        input: { content: "Source meaning" },
      },
    });
    await store.applyMutation({
      scope: targetScope,
      idempotencyKey: "identity-collision",
      mutation: {
        action: "create",
        input: { content: "Target meaning" },
      },
    });
    const sourceBefore = await store.readCutoverState(sourceScope);
    const targetBefore = await store.readCutoverState(targetScope);

    await expect(
      db.transaction((tx) =>
        convergeTodoScopesInTransaction(tx, { sourceScope, targetScope }),
      ),
    ).rejects.toMatchObject({
      code: TODO_IDEMPOTENCY_CONFLICT_ERROR_CODE,
    });
    expect(await store.readCutoverState(sourceScope)).toEqual(sourceBefore);
    expect(await store.readCutoverState(targetScope)).toEqual(targetBefore);
  });

  it("does not touch scopes sharing only an agent or entity id", async () => {
    const sourceScope = newScope();
    const targetScope = newScope();
    const isolatedScopes: TodoScope[] = [
      { agentId: sourceScope.agentId, entityId: crypto.randomUUID() as UUID },
      { agentId: crypto.randomUUID() as UUID, entityId: sourceScope.entityId },
      newScope(),
    ];
    await store.applyMutation({
      scope: sourceScope,
      idempotencyKey: "move-only-this-scope",
      mutation: { action: "create", input: { content: "Move me" } },
    });
    await store.applyMutation({
      scope: targetScope,
      idempotencyKey: "target-existing",
      mutation: { action: "create", input: { content: "Keep target row" } },
    });
    for (const [index, isolatedScope] of isolatedScopes.entries()) {
      await store.applyMutation({
        scope: isolatedScope,
        idempotencyKey: `isolated-${index}`,
        mutation: {
          action: "create",
          input: { content: `Isolated ${index}` },
        },
      });
    }
    const isolatedBefore = await Promise.all(
      isolatedScopes.map((isolatedScope) =>
        store.readCutoverState(isolatedScope),
      ),
    );

    await db.transaction((tx) =>
      convergeTodoScopesInTransaction(tx, { sourceScope, targetScope }),
    );
    expect(await store.readCutoverState(sourceScope)).toEqual({
      todos: [],
      mutations: [],
    });
    expect((await store.readCutoverState(targetScope)).todos).toHaveLength(2);
    await Promise.all(
      isolatedScopes.map(async (isolatedScope, index) => {
        expect(await store.readCutoverState(isolatedScope)).toEqual(
          isolatedBefore[index],
        );
      }),
    );
  });

  it("fails closed when source state violates the Todo contract", async () => {
    const sourceScope = newScope();
    const targetScope = newScope();
    const created = await store.applyMutation({
      scope: sourceScope,
      idempotencyKey: "invalid-source-state",
      mutation: { action: "create", input: { content: "Do not move me" } },
    });
    if (created.result.action !== "create") {
      throw new Error("Expected invalid-state probe creation");
    }
    await db.execute(
      sql`UPDATE todos.todos SET metadata = '1'::jsonb WHERE id = ${created.result.todo.id}::uuid`,
    );

    await expect(
      db.transaction((tx) =>
        convergeTodoScopesInTransaction(tx, { sourceScope, targetScope }),
      ),
    ).rejects.toMatchObject({ code: TODO_SCOPE_CONVERGENCE_ERROR_CODE });
    expect(await store.get(sourceScope, created.result.todo.id)).not.toBeNull();
    expect(await store.readCutoverState(targetScope)).toEqual({
      todos: [],
      mutations: [],
    });
  });
});
