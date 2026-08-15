/**
 * Real-PGlite proof for the Dedicated Todo cutover transaction: deterministic
 * identities, parent remapping, repair, stale cleanup, and native-row
 * preservation all run against the plugin's actual schema.
 */

import { stringToUuid, type UUID } from "@elizaos/core";
import todosRuntimePlugin from "@elizaos/plugin-todos/plugin";
import { getTodosService } from "@elizaos/plugin-todos/service";
import { createSharedTodoCutoverSnapshot } from "@elizaos/shared/todo-cutover";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../app-core/test/helpers/real-runtime.ts";
import { importSharedTodoCutover } from "./todo-cutover-import.ts";

const ENTITY_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const SECOND_ENTITY_ID = "11111111-1111-4111-8111-111111111112" as UUID;
const ROOM_ID = "22222222-2222-4222-8222-222222222222" as UUID;
const SOURCE_AGENT_ID = "personal:shared-source";
const CUTOVER_TOKEN = "personal-cutover:shared-source:dedicated-target";

function sourceTodo(sourceId: string, parentSourceId: string | null = null) {
  return {
    sourceId,
    roomId: "33333333-3333-4333-8333-333333333333",
    worldId: null,
    content: `Todo ${sourceId}`,
    activeForm: `Doing ${sourceId}`,
    status: "pending" as const,
    parentSourceId,
    parentTrajectoryStepId: null,
    metadata: { source: "shared" },
    createdAt: "2026-08-14T10:00:00.000Z",
    updatedAt: "2026-08-14T11:00:00.000Z",
    completedAt: null,
  };
}

describe("Dedicated Shared Todo cutover import", () => {
  let testRuntime: RealTestRuntimeResult;

  beforeAll(async () => {
    testRuntime = await createRealTestRuntime({
      characterName: "todo-cutover-import",
      plugins: [todosRuntimePlugin],
    });
  }, 180_000);

  afterAll(async () => {
    await testRuntime?.cleanup();
  });

  it("imports, verifies, repairs, and exact-syncs without touching native Todos", async () => {
    const { runtime } = testRuntime;
    const service = getTodosService(runtime);
    const native = await service.create({
      agentId: runtime.agentId,
      entityId: ENTITY_ID,
      roomId: ROOM_ID,
      content: "Native Dedicated Todo",
      status: "pending",
    });
    const firstSnapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: SOURCE_AGENT_ID,
      todos: [sourceTodo("child", "parent"), sourceTodo("parent")],
    });
    const first = await importSharedTodoCutover({
      runtime,
      entityId: ENTITY_ID,
      targetRoomId: ROOM_ID,
      cutoverToken: CUTOVER_TOKEN,
      snapshot: firstSnapshot,
    });
    expect(first).toMatchObject({
      sourceTodoCount: 2,
      importedTodos: 2,
      repairedTodos: 0,
      skippedTodos: 0,
      removedStaleTodos: 0,
      sourceTodoDigest: firstSnapshot.digest,
      targetTodoDigest: firstSnapshot.digest,
    });

    const imported = await service.list({
      agentId: runtime.agentId,
      entityId: ENTITY_ID,
    });
    expect(imported).toHaveLength(3);
    const parentId = stringToUuid(
      `shared-todo-cutover:${runtime.agentId}:${ENTITY_ID}:${SOURCE_AGENT_ID}:parent`,
    );
    const childId = stringToUuid(
      `shared-todo-cutover:${runtime.agentId}:${ENTITY_ID}:${SOURCE_AGENT_ID}:child`,
    );
    expect(imported.find((todo) => todo.id === childId)?.parentTodoId).toBe(
      parentId,
    );
    expect(imported.find((todo) => todo.id === parentId)?.roomId).toBe(ROOM_ID);
    expect(imported.find((todo) => todo.id === native.id)?.content).toBe(
      "Native Dedicated Todo",
    );

    const replay = await importSharedTodoCutover({
      runtime,
      entityId: ENTITY_ID,
      targetRoomId: ROOM_ID,
      cutoverToken: CUTOVER_TOKEN,
      snapshot: firstSnapshot,
    });
    expect(replay).toMatchObject({
      importedTodos: 0,
      repairedTodos: 0,
      skippedTodos: 2,
      removedStaleTodos: 0,
    });

    const tamperedSnapshot = {
      ...firstSnapshot,
      todos: firstSnapshot.todos.map((todo) =>
        todo.sourceId === "parent"
          ? { ...todo, content: "tampered after digest" }
          : todo,
      ),
    };
    await expect(
      importSharedTodoCutover({
        runtime,
        entityId: ENTITY_ID,
        targetRoomId: ROOM_ID,
        cutoverToken: CUTOVER_TOKEN,
        snapshot: tamperedSnapshot,
      }),
    ).rejects.toMatchObject({ code: "TODO_CUTOVER_TARGET_DIGEST_MISMATCH" });
    expect(
      (
        await service.get(
          { agentId: runtime.agentId, entityId: ENTITY_ID },
          parentId,
        )
      )?.content,
      "digest mismatch must roll back the attempted repair",
    ).toBe("Todo parent");

    await service.update(
      { agentId: runtime.agentId, entityId: ENTITY_ID },
      parentId,
      { content: "corrupted target" },
    );
    const repaired = await importSharedTodoCutover({
      runtime,
      entityId: ENTITY_ID,
      targetRoomId: ROOM_ID,
      cutoverToken: CUTOVER_TOKEN,
      snapshot: firstSnapshot,
    });
    expect(repaired).toMatchObject({ repairedTodos: 1, skippedTodos: 1 });

    const finalSnapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: SOURCE_AGENT_ID,
      todos: [sourceTodo("parent")],
    });
    const exactSync = await importSharedTodoCutover({
      runtime,
      entityId: ENTITY_ID,
      targetRoomId: ROOM_ID,
      cutoverToken: CUTOVER_TOKEN,
      snapshot: finalSnapshot,
    });
    expect(exactSync).toMatchObject({
      sourceTodoCount: 1,
      removedStaleTodos: 1,
      targetTodoDigest: finalSnapshot.digest,
    });
    const finalRows = await service.list({
      agentId: runtime.agentId,
      entityId: ENTITY_ID,
    });
    expect(finalRows.map((todo) => todo.content).sort()).toEqual([
      "Native Dedicated Todo",
      "Todo parent",
    ]);

    const secondTenant = await importSharedTodoCutover({
      runtime,
      entityId: SECOND_ENTITY_ID,
      targetRoomId: ROOM_ID,
      cutoverToken: CUTOVER_TOKEN,
      snapshot: finalSnapshot,
    });
    expect(secondTenant).toMatchObject({
      importedTodos: 1,
      targetTodoDigest: finalSnapshot.digest,
    });
    const secondTenantRows = await service.list({
      agentId: runtime.agentId,
      entityId: SECOND_ENTITY_ID,
    });
    expect(secondTenantRows).toHaveLength(1);
    expect(secondTenantRows[0]?.id).not.toBe(parentId);

    await service.update(
      { agentId: runtime.agentId, entityId: ENTITY_ID },
      native.id,
      { parentTodoId: parentId },
    );
    const emptySnapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: SOURCE_AGENT_ID,
      todos: [],
    });
    const emptied = await importSharedTodoCutover({
      runtime,
      entityId: ENTITY_ID,
      targetRoomId: ROOM_ID,
      cutoverToken: CUTOVER_TOKEN,
      snapshot: emptySnapshot,
    });
    expect(emptied).toMatchObject({
      sourceTodoCount: 0,
      removedStaleTodos: 1,
      targetTodoDigest: emptySnapshot.digest,
    });
    const firstTenantAfterEmpty = await service.list({
      agentId: runtime.agentId,
      entityId: ENTITY_ID,
    });
    expect(firstTenantAfterEmpty).toMatchObject([
      { id: native.id, parentTodoId: null, content: "Native Dedicated Todo" },
    ]);
    expect(
      await service.list({
        agentId: runtime.agentId,
        entityId: SECOND_ENTITY_ID,
      }),
      "emptying one target tenant must not delete another tenant's import",
    ).toHaveLength(1);
  });
});
