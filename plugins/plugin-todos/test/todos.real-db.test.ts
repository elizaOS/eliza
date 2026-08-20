/**
 * Real-DB integration tests for the todos back-end.
 *
 * Unlike `src/actions/todo.test.ts` (which fakes the service), this suite boots
 * a REAL PGLite-backed AgentRuntime via {@link createRealTestRuntime},
 * registers `todosPlugin` so the SQL plugin materializes the `todos` schema
 * table from the plugin `schema` field, then drives `TodosService` against that
 * live database. Every assertion is a write-then-read-back round-trip, so
 * nothing about the drizzle query construction or row parsing is faked.
 *
 * The `CURRENT_TODOS` provider is also exercised against the live runtime so
 * the per-turn context injection is verified end-to-end (service → DB → provider
 * markdown).
 *
 * Hermetic: no network, no credentials, no LLM (todo CRUD is pure drizzle).
 */

import type {
  ActionResult,
  AgentRuntime,
  HandlerOptions,
  Memory,
  UUID,
} from "@elizaos/core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app-core/test/helpers/real-runtime.ts";
import { todoAction } from "../src/actions/todo.ts";
import { todosTable } from "../src/db/schema.ts";
import todosPlugin from "../src/index.ts";
import { currentTodosProvider } from "../src/providers/current-todos.ts";
import {
  deserializeTodoMutationRecord,
  importTodoMutationRecordsInTransaction,
  serializeTodoMutationRecord,
  TODO_DUPLICATE_ID_ERROR_CODE,
  TODO_IDEMPOTENCY_CONFLICT_ERROR_CODE,
  TODO_INVALID_PARENT_ERROR_CODE,
  TODO_PARENT_CYCLE_ERROR_CODE,
  TodosService,
} from "../src/service.ts";

// Stable per-user (entityId) UUID; agentId comes from the runtime.
const ENTITY_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const OTHER_ENTITY_ID = "66666666-6666-4666-8666-666666666666" as UUID;
const OTHER_AGENT_ID = "77777777-7777-4777-8777-777777777777" as UUID;

describe("TodosService + currentTodosProvider — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let service: TodosService;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "todos-real-db-tests",
      // Registering the plugin makes runtime.initialize() run the SQL plugin's
      // migration for the `todos` schema (the plugin `schema` field).
      plugins: [todosPlugin],
    });
    runtime = testResult.runtime;
    service = new TodosService(runtime);
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  function scope(entityId: UUID) {
    return { agentId: runtime.agentId, entityId };
  }

  async function invokeTodoAction(
    message: Memory,
    parameters: Record<string, unknown>,
  ): Promise<ActionResult> {
    const result = await todoAction.handler?.(runtime, message, undefined, {
      parameters,
    } as HandlerOptions);
    if (!result) throw new Error("TODO action returned no result");
    return result;
  }

  it("creates a todo and reads it back from the live DB via get / list", async () => {
    const created = await service.create({
      entityId: ENTITY_ID,
      agentId: runtime.agentId,
      content: "Write the real-db tests",
      activeForm: "Writing the real-db tests",
      status: "pending",
    });
    expect(created.id).toBeTruthy();
    expect(created.content).toBe("Write the real-db tests");
    expect(created.status).toBe("pending");
    expect(created.completedAt).toBeNull();

    // Round-trip: the row is really in the DB (raw select by id).
    const fetched = await service.get(scope(ENTITY_ID), created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.content).toBe("Write the real-db tests");
    expect(fetched?.activeForm).toBe("Writing the real-db tests");
    expect(fetched?.entityId).toBe(ENTITY_ID);
    expect(fetched?.agentId).toBe(runtime.agentId);

    const list = await service.list({
      entityId: ENTITY_ID,
      agentId: runtime.agentId,
    });
    expect(list.find((t) => t.id === created.id)).toBeTruthy();
  });

  it("updates and completes a todo, persisting status + completedAt", async () => {
    const created = await service.create({
      entityId: ENTITY_ID,
      agentId: runtime.agentId,
      content: "Ship the feature",
      status: "pending",
    });

    const started = await service.update(scope(ENTITY_ID), created.id, {
      status: "in_progress",
    });
    expect(started?.status).toBe("in_progress");
    expect(started?.completedAt).toBeNull();

    const completed = await service.update(scope(ENTITY_ID), created.id, {
      status: "completed",
    });
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAt).not.toBeNull();

    // Re-read straight from the DB to prove the UPDATE landed.
    const reread = await service.get(scope(ENTITY_ID), created.id);
    expect(reread?.status).toBe("completed");
    expect(reread?.completedAt).not.toBeNull();
  });

  it("filters the list by status against the real DB", async () => {
    const entityId = "22222222-2222-4222-8222-222222222222" as UUID;
    await service.create({
      entityId,
      agentId: runtime.agentId,
      content: "Active one",
      status: "pending",
    });
    const done = await service.create({
      entityId,
      agentId: runtime.agentId,
      content: "Done one",
      status: "pending",
    });
    await service.update(scope(entityId), done.id, { status: "completed" });

    // includeCompleted:false narrows to pending + in_progress at the SQL layer.
    const active = await service.list({
      entityId,
      agentId: runtime.agentId,
      includeCompleted: false,
    });
    const activeContents = active.map((t) => t.content);
    expect(activeContents).toContain("Active one");
    expect(activeContents).not.toContain("Done one");

    // Explicit status filter reads the completed row back.
    const completedOnly = await service.list({
      entityId,
      agentId: runtime.agentId,
      status: "completed",
    });
    expect(completedOnly.map((t) => t.content)).toContain("Done one");
  });

  it("writeList reconciles the full desired list against the real DB", async () => {
    const entityId = "33333333-3333-4333-8333-333333333333" as UUID;
    // Seed two existing todos.
    const keep = await service.create({
      entityId,
      agentId: runtime.agentId,
      content: "Keep me",
      status: "pending",
    });
    await service.create({
      entityId,
      agentId: runtime.agentId,
      content: "Drop me",
      status: "pending",
    });

    // writeList keeps `keep` (matched by id, status flipped), adds a new row,
    // and deletes the unreferenced "Drop me".
    const { after } = await service.writeList({
      entityId,
      agentId: runtime.agentId,
      roomId: null,
      worldId: null,
      parentTrajectoryStepId: null,
      todos: [
        { id: keep.id, content: "Keep me", status: "completed" },
        { content: "Brand new", status: "pending" },
      ],
    });
    expect(after.map((t) => t.content).sort()).toEqual([
      "Brand new",
      "Keep me",
    ]);

    // Re-read from the DB: exactly two rows, "Drop me" is gone, "Keep me" done.
    const remaining = await service.list({
      entityId,
      agentId: runtime.agentId,
    });
    expect(remaining).toHaveLength(2);
    expect(remaining.map((t) => t.content).sort()).toEqual([
      "Brand new",
      "Keep me",
    ]);
    expect(remaining.find((t) => t.content === "Keep me")?.status).toBe(
      "completed",
    );
  });

  it("reconciles a cross-room mark-complete by id instead of duplicating (regression #22124)", async () => {
    // Reads (CURRENT_TODOS provider, list()) are entity-scoped across rooms,
    // so writeList must reconcile against that same cross-room set. A todo
    // created in ROOM_A and marked complete by id from ROOM_B must be UPDATED
    // in place, not re-created as a new ROOM_B row while the ROOM_A original
    // survives untouched (the pre-fix duplicate + lost-update corruption).
    const entityId = "9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a" as UUID;
    const roomA = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1" as UUID;
    const roomB = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2" as UUID;
    const seeded = await service.create({
      entityId,
      agentId: runtime.agentId,
      roomId: roomA,
      content: "Cross-room todo",
      status: "pending",
    });

    const { before, after } = await service.writeList({
      entityId,
      agentId: runtime.agentId,
      roomId: roomB,
      worldId: null,
      parentTrajectoryStepId: null,
      todos: [
        { id: seeded.id, content: "Cross-room todo", status: "completed" },
      ],
    });
    // The reconciler saw the ROOM_A row (matched by id) and updated it in place.
    expect(before.map((t) => t.id)).toEqual([seeded.id]);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(seeded.id);
    expect(after[0]?.status).toBe("completed");

    const rows = await service.list({ entityId, agentId: runtime.agentId });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(seeded.id);
    expect(rows[0]?.status).toBe("completed");
    // The original room is preserved; no duplicate ROOM_B row was minted.
    expect(rows[0]?.roomId).toBe(roomA);
  });

  it("deletes a cross-room todo omitted from a writeList without duplicating the kept one (regression #22124)", async () => {
    const entityId = "7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c" as UUID;
    const roomA = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3" as UUID;
    const roomB = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4" as UUID;
    const keep = await service.create({
      entityId,
      agentId: runtime.agentId,
      roomId: roomA,
      content: "Keep across rooms",
      status: "pending",
    });
    const drop = await service.create({
      entityId,
      agentId: runtime.agentId,
      roomId: roomA,
      content: "Drop across rooms",
      status: "pending",
    });

    // From ROOM_B the planner submits only the kept todo by id; the omitted one
    // must be deleted from the shared cross-room set, not silently survive.
    const { after } = await service.writeList({
      entityId,
      agentId: runtime.agentId,
      roomId: roomB,
      worldId: null,
      parentTrajectoryStepId: null,
      todos: [{ id: keep.id, content: "Keep across rooms", status: "pending" }],
    });
    expect(after.map((t) => t.id)).toEqual([keep.id]);

    const rows = await service.list({ entityId, agentId: runtime.agentId });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(keep.id);
    expect(rows.some((t) => t.id === drop.id)).toBe(false);
    // Exactly one row, matched by id — no duplicate of the kept todo appeared.
    expect(rows.filter((t) => t.content === "Keep across rooms")).toHaveLength(
      1,
    );
  });

  it("rejects duplicate write ids without deleting rows or issuing a receipt", async () => {
    const entityId = "12345678-1234-4234-8234-123456789abc" as UUID;
    const roomId = "abcdefab-cdef-4def-8def-abcdefabcdef" as UUID;
    const first = await service.create({
      entityId,
      agentId: runtime.agentId,
      roomId,
      content: "First",
      status: "pending",
    });
    const second = await service.create({
      entityId,
      agentId: runtime.agentId,
      roomId,
      content: "Second",
      status: "pending",
    });
    const duplicateList = [
      { id: first.id, content: "First", status: "pending" as const },
      { id: first.id, content: "First again", status: "pending" as const },
    ];
    const expectedIds = [first.id, second.id].sort();

    const actionResult = await invokeTodoAction(
      {
        id: crypto.randomUUID() as UUID,
        entityId,
        roomId,
        content: { text: "replace my todos" },
      } as Memory,
      { action: "write", todos: duplicateList },
    );
    expect(actionResult.success).toBe(false);
    expect(actionResult.text).toContain("duplicate id");
    expect(actionResult.effectReceipts).toBeUndefined();
    expect(actionResult.userFacingEffectReceiptIds).toBeUndefined();
    expect(actionResult.verifiedUserFacing).toBeUndefined();
    expect(
      (await service.list({ entityId, agentId: runtime.agentId, roomId }))
        .map((todo) => todo.id)
        .sort(),
    ).toEqual(expectedIds);

    await expect(
      service.writeList({
        entityId,
        agentId: runtime.agentId,
        roomId,
        worldId: null,
        parentTrajectoryStepId: null,
        todos: duplicateList,
      }),
    ).rejects.toMatchObject({ code: TODO_DUPLICATE_ID_ERROR_CODE });
    expect(
      (await service.list({ entityId, agentId: runtime.agentId, roomId }))
        .map((todo) => todo.id)
        .sort(),
    ).toEqual(expectedIds);
  });

  it("rejects unscoped destructive actions without touching either room", async () => {
    const entityId = "23456789-2345-4345-8345-23456789abcd" as UUID;
    const roomA = "11111111-aaaa-4aaa-8aaa-111111111111" as UUID;
    const roomB = "22222222-bbbb-4bbb-8bbb-222222222222" as UUID;
    const first = await service.create({
      entityId,
      agentId: runtime.agentId,
      roomId: roomA,
      content: "Room A",
    });
    const second = await service.create({
      entityId,
      agentId: runtime.agentId,
      roomId: roomB,
      content: "Room B",
    });
    const expectedIds = [first.id, second.id].sort();
    const invalidMessages: Memory[] = [
      { entityId, content: { text: "missing room" } } as Memory,
      { entityId, roomId: "", content: { text: "blank room" } } as Memory,
      {
        entityId,
        roomId: "not-a-uuid",
        content: { text: "invalid room" },
      } as Memory,
    ];

    for (const message of invalidMessages) {
      for (const parameters of [
        { action: "write", todos: [] },
        { action: "clear" },
      ]) {
        const result = await invokeTodoAction(message, parameters);
        expect(result.success).toBe(false);
        expect(result.text).toContain("invalid_scope");
        expect(result.effectReceipts).toBeUndefined();
        expect(result.userFacingEffectReceiptIds).toBeUndefined();
        expect(result.verifiedUserFacing).toBeUndefined();
      }
      expect(
        (await service.list({ entityId, agentId: runtime.agentId }))
          .map((todo) => todo.id)
          .sort(),
      ).toEqual(expectedIds);
    }
  });

  it("deletes a todo and clear() removes the remaining rows for a scope", async () => {
    const entityId = "44444444-4444-4444-8444-444444444444" as UUID;
    const a = await service.create({
      entityId,
      agentId: runtime.agentId,
      content: "A",
      status: "pending",
    });
    await service.create({
      entityId,
      agentId: runtime.agentId,
      content: "B",
      status: "pending",
    });

    expect(await service.delete(scope(entityId), a.id)).toBe(true);
    expect(await service.get(scope(entityId), a.id)).toBeNull();

    const cleared = await service.clear({ entityId, agentId: runtime.agentId });
    expect(cleared).toBe(1);
    const empty = await service.list({ entityId, agentId: runtime.agentId });
    expect(empty).toHaveLength(0);
  });

  it("currentTodosProvider surfaces live DB rows as markdown", async () => {
    const entityId = "55555555-5555-4555-8555-555555555555" as UUID;
    await service.create({
      entityId,
      agentId: runtime.agentId,
      content: "Buy milk",
      status: "pending",
    });
    const inProgress = await service.create({
      entityId,
      agentId: runtime.agentId,
      content: "Read a book",
      status: "pending",
    });
    await service.update(scope(entityId), inProgress.id, {
      status: "in_progress",
    });
    // A completed todo must NOT appear in the provider output.
    const done = await service.create({
      entityId,
      agentId: runtime.agentId,
      content: "Old chore",
      status: "pending",
    });
    await service.update(scope(entityId), done.id, { status: "completed" });

    // todosPlugin registered TodosService, so runtime.initialize() already
    // started it; the provider resolves that started instance off the runtime.
    const message = { entityId } as Memory;
    const result = await currentTodosProvider.get(runtime, message);

    expect(result.text).toContain("# Current todos");
    expect(result.text).toContain("[ ] Buy milk");
    expect(result.text).toContain("[→] Read a book");
    expect(result.text).not.toContain("Old chore");
    const providerTodos = (result.data?.todos ?? []) as Array<{
      content: string;
    }>;
    expect(providerTodos.map((t) => t.content).sort()).toEqual([
      "Buy milk",
      "Read a book",
    ]);
  });

  it("requires the exact agent and entity scope for every read and mutation", async () => {
    const created = await service.create({
      entityId: OTHER_ENTITY_ID,
      agentId: runtime.agentId,
      content: "Private todo",
      status: "pending",
    });
    const wrongAgent = { agentId: OTHER_AGENT_ID, entityId: OTHER_ENTITY_ID };
    const wrongEntity = { agentId: runtime.agentId, entityId: ENTITY_ID };

    expect(await service.get(wrongAgent, created.id)).toBeNull();
    expect(await service.get(wrongEntity, created.id)).toBeNull();
    expect(
      await service.update(wrongAgent, created.id, { content: "stolen" }),
    ).toBeNull();
    expect(await service.delete(wrongEntity, created.id)).toBe(false);
    expect(await service.clear(wrongAgent)).toBe(0);
    expect(
      (await service.get(scope(OTHER_ENTITY_ID), created.id))?.content,
    ).toBe("Private todo");
  });

  it("sets completedAt when a completed todo is created directly", async () => {
    const created = await service.create({
      entityId: OTHER_ENTITY_ID,
      agentId: runtime.agentId,
      content: "Already done",
      status: "completed",
    });

    expect(created.completedAt).not.toBeNull();
    expect(
      (await service.get(scope(OTHER_ENTITY_ID), created.id))?.completedAt,
    ).not.toBeNull();
  });

  it("rejects cross-scope parents, self-parenting, and hierarchy cycles", async () => {
    const parent = await service.create({
      entityId: OTHER_ENTITY_ID,
      agentId: runtime.agentId,
      content: "Parent",
      status: "pending",
    });
    await expect(
      service.create({
        entityId: ENTITY_ID,
        agentId: runtime.agentId,
        content: "Cross-scope child",
        parentTodoId: parent.id,
      }),
    ).rejects.toMatchObject({ code: TODO_INVALID_PARENT_ERROR_CODE });
    await expect(
      service.update(scope(OTHER_ENTITY_ID), parent.id, {
        parentTodoId: parent.id,
      }),
    ).rejects.toMatchObject({ code: TODO_PARENT_CYCLE_ERROR_CODE });

    const child = await service.create({
      entityId: OTHER_ENTITY_ID,
      agentId: runtime.agentId,
      content: "Child",
      parentTodoId: parent.id,
    });
    await expect(
      service.update(scope(OTHER_ENTITY_ID), parent.id, {
        parentTodoId: child.id,
      }),
    ).rejects.toMatchObject({ code: TODO_PARENT_CYCLE_ERROR_CODE });
  });

  it("rolls back the entire writeList when the desired hierarchy is invalid", async () => {
    const entityId = "88888888-8888-4888-8888-888888888888" as UUID;
    const original = await service.create({
      entityId,
      agentId: runtime.agentId,
      content: "Original",
      status: "pending",
    });

    await expect(
      service.writeList({
        entityId,
        agentId: runtime.agentId,
        roomId: null,
        worldId: null,
        parentTrajectoryStepId: null,
        todos: [
          { id: original.id, content: "Mutated", status: "completed" },
          {
            content: "Invalid child",
            status: "pending",
            parentTodoId: "99999999-9999-4999-8999-999999999999",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: TODO_INVALID_PARENT_ERROR_CODE });

    const rows = await service.list({ entityId, agentId: runtime.agentId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: original.id,
      content: "Original",
      status: "pending",
      completedAt: null,
    });
  });

  it("promotes children to roots before deleting their parent", async () => {
    const entityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
    const parent = await service.create({
      entityId,
      agentId: runtime.agentId,
      content: "Parent",
    });
    const child = await service.create({
      entityId,
      agentId: runtime.agentId,
      content: "Child",
      parentTodoId: parent.id,
    });

    expect(await service.delete(scope(entityId), parent.id)).toBe(true);
    expect(
      (await service.get(scope(entityId), child.id))?.parentTodoId,
    ).toBeNull();
  });

  it("keeps completedAt stable while an already-completed todo changes", async () => {
    const entityId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
    const created = await service.create({
      entityId,
      agentId: runtime.agentId,
      content: "Complete once",
      status: "completed",
    });
    const firstCompletedAt = created.completedAt;

    const repeated = await service.update(scope(entityId), created.id, {
      status: "completed",
      content: "Still complete",
    });
    expect(repeated?.completedAt).toEqual(firstCompletedAt);
    const { after } = await service.writeList({
      entityId,
      agentId: runtime.agentId,
      roomId: null,
      worldId: null,
      parentTrajectoryStepId: null,
      todos: [{ id: created.id, content: "Edited again", status: "completed" }],
    });
    expect(after[0]?.completedAt).toEqual(firstCompletedAt);
  });

  it("detaches cross-room children when room-scoped clear removes their parent", async () => {
    const entityId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;
    const parent = await service.create({
      entityId,
      agentId: runtime.agentId,
      roomId: "11111111-2222-4333-8444-555555555555",
      content: "Room A parent",
    });
    const child = await service.create({
      entityId,
      agentId: runtime.agentId,
      roomId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      content: "Room B child",
      parentTodoId: parent.id,
    });

    expect(
      await service.clear({
        agentId: runtime.agentId,
        entityId,
        roomId: "11111111-2222-4333-8444-555555555555",
      }),
    ).toBe(1);
    expect(
      (await service.get(scope(entityId), child.id))?.parentTodoId,
    ).toBeNull();
  });

  it("detaches a cross-room child when writeList omits (deletes) its parent", async () => {
    // writeList reconciles against the user's whole cross-room set, so a child
    // kept by id while its parent is omitted must be detached, not orphaned or
    // deleted, even though the two rows live in different rooms.
    const entityId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as UUID;
    const parent = await service.create({
      entityId,
      agentId: runtime.agentId,
      roomId: "11111111-2222-4333-8444-555555555555",
      content: "Room A parent",
    });
    const child = await service.create({
      entityId,
      agentId: runtime.agentId,
      roomId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      content: "Room B child",
      parentTodoId: parent.id,
    });

    // Called from a THIRD room; the desired list keeps only the child by id.
    await service.writeList({
      entityId,
      agentId: runtime.agentId,
      roomId: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
      worldId: null,
      parentTrajectoryStepId: null,
      todos: [{ id: child.id, content: "Room B child", status: "pending" }],
    });
    // Parent (omitted) is deleted; child (kept) survives with a null parent.
    expect(await service.get(scope(entityId), parent.id)).toBeNull();
    const survivingChild = await service.get(scope(entityId), child.id);
    expect(survivingChild).not.toBeNull();
    expect(survivingChild?.parentTodoId).toBeNull();
  });

  it("serializes a parent clear against concurrent child creation", async () => {
    const entityId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as UUID;
    const parent = await service.create({
      entityId,
      agentId: runtime.agentId,
      roomId: "11111111-2222-4333-8444-555555555555",
      content: "Concurrent parent",
    });

    const [clearResult, createResult] = await Promise.allSettled([
      service.clear({
        agentId: runtime.agentId,
        entityId,
        roomId: "11111111-2222-4333-8444-555555555555",
      }),
      service.create({
        entityId,
        agentId: runtime.agentId,
        roomId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
        content: "Concurrent child",
        parentTodoId: parent.id,
      }),
    ]);

    expect(clearResult.status).toBe("fulfilled");
    if (createResult.status === "fulfilled") {
      expect(
        (await service.get(scope(entityId), createResult.value.id))
          ?.parentTodoId,
      ).toBeNull();
    } else {
      expect(createResult.reason).toMatchObject({
        code: TODO_INVALID_PARENT_ERROR_CODE,
      });
    }
  });

  it("never treats an invalid empty room id as an unscoped clear", async () => {
    const entityId = "ffffffff-ffff-4fff-8fff-ffffffffffff" as UUID;
    const todo = await service.create({
      entityId,
      agentId: runtime.agentId,
      content: "Keep this todo",
    });

    await expect(
      service.clear({ agentId: runtime.agentId, entityId, roomId: "" }),
    ).rejects.toThrow();
    expect(await service.get(scope(entityId), todo.id)).not.toBeNull();
  });

  it("replays semantic mutations across host routing changes", async () => {
    const entityId = crypto.randomUUID() as UUID;
    const roomA = crypto.randomUUID() as UUID;
    const roomB = crypto.randomUUID() as UUID;
    const worldA = crypto.randomUUID() as UUID;
    const worldB = crypto.randomUUID() as UUID;
    const targetScope = scope(entityId);

    const firstCreate = await service.applyMutation({
      scope: targetScope,
      idempotencyKey: "semantic-create",
      mutation: {
        action: "create",
        input: {
          roomId: roomA,
          worldId: worldA,
          parentTrajectoryStepId: "shared-step",
          content: "Route-independent create",
        },
      },
    });
    const replayedCreate = await service.applyMutation({
      scope: targetScope,
      idempotencyKey: "semantic-create",
      mutation: {
        action: "create",
        input: {
          roomId: roomB,
          worldId: worldB,
          parentTrajectoryStepId: "dedicated-step",
          content: "Route-independent create",
        },
      },
    });
    expect(replayedCreate).toMatchObject({
      mutationId: firstCreate.mutationId,
      replayed: true,
      result: firstCreate.result,
    });
    await expect(
      service.applyMutation({
        scope: targetScope,
        idempotencyKey: "semantic-create",
        mutation: {
          action: "create",
          input: { roomId: roomB, worldId: worldB, content: "Changed payload" },
        },
      }),
    ).rejects.toMatchObject({ code: TODO_IDEMPOTENCY_CONFLICT_ERROR_CODE });

    const firstWrite = await service.applyMutation({
      scope: targetScope,
      idempotencyKey: "semantic-write",
      mutation: {
        action: "write",
        input: {
          roomId: roomA,
          worldId: worldA,
          parentTrajectoryStepId: "shared-write",
          todos: [{ content: "Written once", status: "pending" }],
        },
      },
    });
    const replayedWrite = await service.applyMutation({
      scope: targetScope,
      idempotencyKey: "semantic-write",
      mutation: {
        action: "write",
        input: {
          roomId: roomB,
          worldId: worldB,
          parentTrajectoryStepId: "dedicated-write",
          todos: [{ content: "Written once", status: "pending" }],
        },
      },
    });
    expect(replayedWrite).toMatchObject({
      mutationId: firstWrite.mutationId,
      replayed: true,
      result: firstWrite.result,
    });
    await expect(
      service.applyMutation({
        scope: targetScope,
        idempotencyKey: "semantic-write",
        mutation: {
          action: "write",
          input: {
            roomId: roomB,
            worldId: worldB,
            parentTrajectoryStepId: null,
            todos: [{ content: "Changed written payload", status: "pending" }],
          },
        },
      }),
    ).rejects.toMatchObject({ code: TODO_IDEMPOTENCY_CONFLICT_ERROR_CODE });

    const clearRoomA = await service.create({
      ...targetScope,
      roomId: roomA,
      content: "Clear only once",
    });
    const preserveRoomB = await service.create({
      ...targetScope,
      roomId: roomB,
      content: "Preserve on replay",
    });
    const firstClear = await service.applyMutation({
      scope: targetScope,
      idempotencyKey: "semantic-clear",
      mutation: { action: "clear", roomId: roomA },
    });
    const replayedClear = await service.applyMutation({
      scope: targetScope,
      idempotencyKey: "semantic-clear",
      mutation: { action: "clear", roomId: roomB },
    });
    expect(replayedClear).toMatchObject({
      mutationId: firstClear.mutationId,
      replayed: true,
      result: firstClear.result,
    });
    expect(await service.get(targetScope, clearRoomA.id)).toBeNull();
    expect(await service.get(targetScope, preserveRoomB.id)).not.toBeNull();
  });

  it("applies every mutator once under retries and concurrency", async () => {
    const entityId = crypto.randomUUID() as UUID;
    const targetScope = scope(entityId);
    const createInput = {
      scope: targetScope,
      idempotencyKey: "concurrent-create",
      mutation: {
        action: "create" as const,
        input: { content: "Concurrent once" },
      },
    };
    const concurrent = await Promise.all([
      service.applyMutation(createInput),
      service.applyMutation(createInput),
    ]);
    expect(concurrent.map((entry) => entry.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(concurrent[0]?.mutationId).toBe(concurrent[1]?.mutationId);
    expect(
      (await service.list({ ...targetScope })).filter(
        (todo) => todo.content === "Concurrent once",
      ),
    ).toHaveLength(1);
    const created = concurrent[0]?.result;
    if (created?.action !== "create") throw new Error("Expected create result");

    for (const input of [
      {
        scope: targetScope,
        idempotencyKey: "update-once",
        mutation: {
          action: "update" as const,
          id: created.todo.id,
          patch: { content: "Updated once" },
        },
      },
      {
        scope: targetScope,
        idempotencyKey: "complete-once",
        mutation: { action: "complete" as const, id: created.todo.id },
      },
      {
        scope: targetScope,
        idempotencyKey: "cancel-once",
        mutation: { action: "cancel" as const, id: created.todo.id },
      },
    ]) {
      const first = await service.applyMutation(input);
      const replayed = await service.applyMutation(input);
      expect(replayed).toMatchObject({
        mutationId: first.mutationId,
        replayed: true,
        result: first.result,
      });
    }

    const deleteTarget = await service.create({
      ...targetScope,
      content: "Delete once",
    });
    const deleteInput = {
      scope: targetScope,
      idempotencyKey: "delete-once",
      mutation: { action: "delete" as const, id: deleteTarget.id },
    };
    const deleted = await service.applyMutation(deleteInput);
    const intervening = await service.create({
      ...targetScope,
      content: "Created after delete",
    });
    const replayedDelete = await service.applyMutation(deleteInput);
    expect(replayedDelete).toMatchObject({
      mutationId: deleted.mutationId,
      replayed: true,
      result: deleted.result,
    });
    expect(await service.get(targetScope, intervening.id)).not.toBeNull();

    const otherEntityId = crypto.randomUUID() as UUID;
    const tenantKey = "same-key-different-tenant";
    const [tenantA, tenantB] = await Promise.all([
      service.applyMutation({
        scope: targetScope,
        idempotencyKey: tenantKey,
        mutation: { action: "create", input: { content: "Tenant A" } },
      }),
      service.applyMutation({
        scope: scope(otherEntityId),
        idempotencyKey: tenantKey,
        mutation: { action: "create", input: { content: "Tenant B" } },
      }),
    ]);
    expect(tenantA.replayed).toBe(false);
    expect(tenantB.replayed).toBe(false);
    expect(tenantA.mutationId).not.toBe(tenantB.mutationId);
  });

  it("ledgers zero-effect write and clear retries before later state appears", async () => {
    const entityId = crypto.randomUUID() as UUID;
    const roomId = crypto.randomUUID() as UUID;
    const targetScope = scope(entityId);
    const emptyWrite = {
      scope: targetScope,
      idempotencyKey: "empty-write",
      mutation: {
        action: "write" as const,
        input: {
          roomId,
          worldId: null,
          parentTrajectoryStepId: null,
          todos: [],
        },
      },
    };
    expect((await service.applyMutation(emptyWrite)).applied).toBe(false);
    const afterWrite = await service.create({
      ...targetScope,
      roomId,
      content: "Appeared after empty write",
    });
    expect((await service.applyMutation(emptyWrite)).replayed).toBe(true);
    expect(await service.get(targetScope, afterWrite.id)).not.toBeNull();

    const emptyClear = {
      scope: targetScope,
      idempotencyKey: "empty-clear",
      mutation: { action: "clear" as const, roomId: crypto.randomUUID() },
    };
    expect((await service.applyMutation(emptyClear)).applied).toBe(false);
    const afterClear = await service.create({
      ...targetScope,
      roomId: emptyClear.mutation.roomId,
      content: "Appeared after empty clear",
    });
    expect((await service.applyMutation(emptyClear)).replayed).toBe(true);
    expect(await service.get(targetScope, afterClear.id)).not.toBeNull();
  });

  it("imports Todo rows and replay authority atomically with stable ids", async () => {
    const sourceEntityId = crypto.randomUUID() as UUID;
    const sourceRoomId = crypto.randomUUID() as UUID;
    const sourceWorldId = crypto.randomUUID() as UUID;
    const sourceScope = scope(sourceEntityId);
    await service.applyMutation({
      scope: sourceScope,
      idempotencyKey: "cutover-create",
      mutation: {
        action: "create",
        input: {
          roomId: sourceRoomId,
          worldId: sourceWorldId,
          content: "Cut over atomically",
        },
      },
    });
    const sourceSnapshot = await service.readCutoverState(sourceScope);
    expect(sourceSnapshot.todos).toHaveLength(1);
    expect(sourceSnapshot.mutations).toHaveLength(1);
    const sourceTodo = sourceSnapshot.todos[0];
    if (!sourceTodo) throw new Error("Expected source Todo");
    const records = sourceSnapshot.mutations.map((entry) =>
      deserializeTodoMutationRecord(
        serializeTodoMutationRecord(entry),
        entry.scope,
      ),
    );

    const targetResult = await createRealTestRuntime({
      characterName: "todos-cutover-target",
      plugins: [todosPlugin],
    });
    try {
      const targetRuntime = targetResult.runtime;
      const targetService = new TodosService(targetRuntime);
      const targetScope = {
        agentId: targetRuntime.agentId,
        entityId: crypto.randomUUID() as UUID,
      };
      const targetRoomId = crypto.randomUUID() as UUID;
      const targetDb = targetRuntime.db as NodePgDatabase;
      const insertTodo = async (
        tx: Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0],
      ) => {
        await tx.insert(todosTable).values({
          id: sourceTodo.id as UUID,
          agentId: targetScope.agentId,
          entityId: targetScope.entityId,
          roomId: targetRoomId,
          worldId: null,
          content: sourceTodo.content,
          activeForm: sourceTodo.activeForm,
          status: sourceTodo.status,
          parentTodoId: sourceTodo.parentTodoId as UUID | null,
          parentTrajectoryStepId: sourceTodo.parentTrajectoryStepId,
          metadata: sourceTodo.metadata,
          createdAt: sourceTodo.createdAt,
          updatedAt: sourceTodo.updatedAt,
          completedAt: sourceTodo.completedAt,
        });
      };
      const importInput = {
        targetScope,
        records,
        roomIdMap: { [sourceRoomId]: targetRoomId },
        worldIdMap: { [sourceWorldId]: null },
      };

      await expect(
        targetDb.transaction(async (tx) => {
          await insertTodo(tx);
          expect(
            await importTodoMutationRecordsInTransaction(tx, importInput),
          ).toEqual({ imported: 1, skipped: 0 });
          throw new Error("force combined rollback");
        }),
      ).rejects.toThrow("force combined rollback");
      expect(await targetService.list({ ...targetScope })).toHaveLength(0);
      expect(await targetService.listMutationRecords(targetScope)).toHaveLength(
        0,
      );

      const imported = await targetDb.transaction(async (tx) => {
        await insertTodo(tx);
        return importTodoMutationRecordsInTransaction(tx, importInput);
      });
      expect(imported).toEqual({ imported: 1, skipped: 0 });
      expect(await targetService.importMutationRecords(importInput)).toEqual({
        imported: 0,
        skipped: 1,
      });
      const originalCommittedAt = records[0]?.committedAt;
      if (!originalCommittedAt) throw new Error("Expected mutation timestamp");
      const conflictProbeId = crypto.randomUUID() as UUID;
      await expect(
        targetDb.transaction(async (tx) => {
          await tx.insert(todosTable).values({
            id: conflictProbeId,
            agentId: targetScope.agentId,
            entityId: targetScope.entityId,
            roomId: null,
            worldId: null,
            content: "Must roll back with ledger conflict",
            activeForm: "Rolling back with ledger conflict",
            status: "pending",
            parentTodoId: null,
            parentTrajectoryStepId: null,
            metadata: {},
          });
          await importTodoMutationRecordsInTransaction(tx, {
            ...importInput,
            records: records.map((record) => ({
              ...record,
              committedAt: new Date(originalCommittedAt.getTime() + 1_000),
            })),
          });
        }),
      ).rejects.toMatchObject({
        code: TODO_IDEMPOTENCY_CONFLICT_ERROR_CODE,
      });
      expect(await targetService.get(targetScope, conflictProbeId)).toBeNull();
      const targetSnapshot = await targetService.readCutoverState(targetScope);
      expect(targetSnapshot.todos[0]).toMatchObject({
        id: sourceTodo.id,
        worldId: null,
      });
      expect(targetSnapshot.mutations[0]).toMatchObject({
        mutationId: sourceSnapshot.mutations[0]?.mutationId,
        scope: targetScope,
        committedAt: originalCommittedAt,
      });
      const result = targetSnapshot.mutations[0]?.result;
      if (result?.action !== "create") {
        throw new Error("Expected imported create result");
      }
      expect(result.todo).toMatchObject({
        id: sourceTodo.id,
        agentId: targetScope.agentId,
        entityId: targetScope.entityId,
        roomId: targetRoomId,
        worldId: null,
      });
      const importedMutation = targetSnapshot.mutations[0];
      if (!importedMutation) throw new Error("Expected imported mutation");
      const todoIdsBeforeRetry = targetSnapshot.todos.map((todo) => todo.id);
      const replayedAfterCutover = await targetService.applyMutation({
        scope: targetScope,
        idempotencyKey: importedMutation.idempotencyKey,
        mutation: {
          action: "create",
          input: {
            roomId: targetRoomId,
            worldId: null,
            parentTrajectoryStepId: "dedicated-retry",
            content: sourceTodo.content,
          },
        },
      });
      expect(replayedAfterCutover).toMatchObject({
        mutationId: importedMutation.mutationId,
        replayed: true,
        committedAt: importedMutation.committedAt,
        result: importedMutation.result,
      });
      expect(
        (await targetService.list({ ...targetScope })).map((todo) => todo.id),
      ).toEqual(todoIdsBeforeRetry);
    } finally {
      await targetResult.cleanup();
    }
  }, 180_000);

  it("snapshots Todo rows and mutation records at one scope boundary", async () => {
    const entityId = crypto.randomUUID() as UUID;
    const targetScope = scope(entityId);
    for (let index = 0; index < 8; index += 1) {
      const content = `Atomic snapshot ${index}`;
      const idempotencyKey = `atomic-snapshot-${index}`;
      const [, snapshot] = await Promise.all([
        service.applyMutation({
          scope: targetScope,
          idempotencyKey,
          mutation: { action: "create", input: { content } },
        }),
        service.readCutoverState(targetScope),
      ]);
      expect(snapshot.todos.some((todo) => todo.content === content)).toBe(
        snapshot.mutations.some(
          (mutation) => mutation.idempotencyKey === idempotencyKey,
        ),
      );
    }
  });
});
