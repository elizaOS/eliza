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

import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app-core/test/helpers/real-runtime.ts";
import todosPlugin from "../src/index.ts";
import { currentTodosProvider } from "../src/providers/current-todos.ts";
import {
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
});
