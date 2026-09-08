/**
 * Production-faithful mock proof for the digest-bound Todo snapshot carried
 * by an exact Shared-to-Dedicated conversation import.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createSharedTodoCutoverSnapshot,
  type SharedTodoMutationCutoverRecord,
} from "@elizaos/shared/todo-cutover";
import {
  type RunningControlPlaneMock,
  startControlPlaneMock,
} from "../src/control-plane";
import { type RunningHetznerMock, startHetznerMock } from "../src/hetzner";

const TOKEN = "todo-cutover-token";
const RUNTIME_TOKEN = "dedicated-runtime-token";
const CONVERSATION_ID = "personal:todo-cutover-source";
const DEDICATED_AGENT_ID = "dedicated-todo-target";
const TODO_ID = "11111111-1111-4111-8111-111111111111";
const ROOM_ID = "22222222-2222-4222-8222-222222222222";
const SHARED_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const MUTATION_ID = "55555555-5555-4555-8555-555555555555";

let controlPlane: RunningControlPlaneMock;
let hetzner: RunningHetznerMock;
let sandboxId: string;

beforeAll(async () => {
  hetzner = await startHetznerMock({ actionMs: 5 });
  controlPlane = await startControlPlaneMock({
    token: TOKEN,
    expectedAuxToken: "",
    hetznerUrl: hetzner.url,
    hetznerToken: "test-token",
  });
  sandboxId = controlPlane.store.createSandbox({
    organizationId: "org-1",
    userId: "user-1",
    agentId: DEDICATED_AGENT_ID,
  }).id;
  controlPlane.store.updateSandbox(sandboxId, { status: "running" });
  controlPlane.store.bindSandboxRuntimeToken(sandboxId, RUNTIME_TOKEN);
});

afterAll(async () => {
  await controlPlane.stop();
  await hetzner.stop();
});

async function postImport(body: Record<string, unknown>): Promise<Response> {
  return fetch(
    `${controlPlane.url}/api/compat/agents/${sandboxId}/api/conversations/${encodeURIComponent(CONVERSATION_ID)}/import`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "X-Eliza-Organization-Id": "org-1",
        "X-Eliza-User-Id": "user-1",
      },
      body: JSON.stringify(body),
    },
  );
}

async function postDirectRuntimeImport(
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(
    `${controlPlane.url}/api/conversations/${encodeURIComponent(CONVERSATION_ID)}/import`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RUNTIME_TOKEN}`,
        "Content-Type": "application/json",
        "X-API-Key": RUNTIME_TOKEN,
      },
      body: JSON.stringify(body),
    },
  );
}

describe("control-plane Todo cutover import", () => {
  test("routes the health-origin runtime surface by exact agent token", async () => {
    const sandboxHealth = await fetch(
      `${controlPlane.url}/api/compat/agents/${sandboxId}/api/health`,
    );
    expect(sandboxHealth.status).toBe(200);

    const snapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: CONVERSATION_ID,
      todos: [],
      mutations: [],
    });
    const imported = await postDirectRuntimeImport({
      messages: [{ role: "user", text: "direct runtime import" }],
      cutoverToken: "direct-runtime-cutover",
      todoSnapshot: snapshot,
    });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({
      complete: true,
      sourceMessageCount: 1,
      sourceTodoDigest: snapshot.digest,
    });

    const denied = await fetch(
      `${controlPlane.url}/api/conversations/${encodeURIComponent(CONVERSATION_ID)}/messages`,
      { headers: { Authorization: "Bearer wrong-runtime-token" } },
    );
    expect(denied.status).toBe(401);
  });

  test("requires, verifies, stores, and replays the exact digest-bound snapshot", async () => {
    const mutation = {
      version: 1,
      mutationId: MUTATION_ID,
      idempotencyKey: "shared-turn-1:todo:0",
      requestDigest: "a".repeat(64),
      operation: "create",
      applied: true,
      resultJson: {
        version: 1,
        result: {
          action: "create",
          todo: {
            id: TODO_ID,
            agentId: SHARED_AGENT_ID,
            entityId: USER_ID,
            roomId: ROOM_ID,
            worldId: null,
            content: "Call mom",
            activeForm: "Calling mom",
            status: "pending",
            parentTodoId: null,
            parentTrajectoryStepId: null,
            metadata: { delivery: "telegram" },
            createdAt: "2026-08-15T01:00:00.000Z",
            updatedAt: "2026-08-15T01:00:00.000Z",
            completedAt: null,
          },
        },
      },
      committedAt: "2026-08-15T01:00:00.000Z",
    } satisfies SharedTodoMutationCutoverRecord;
    const snapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: CONVERSATION_ID,
      todos: [
        {
          sourceId: TODO_ID,
          roomId: ROOM_ID,
          worldId: null,
          content: "Call mom",
          activeForm: "Calling mom",
          status: "pending",
          parentSourceId: null,
          parentTrajectoryStepId: null,
          metadata: { delivery: "telegram" },
          createdAt: "2026-08-15T01:00:00.000Z",
          updatedAt: "2026-08-15T01:00:00.000Z",
          completedAt: null,
        },
      ],
      mutations: [mutation],
    });

    const missing = await postImport({
      messages: [],
      cutoverToken: "personal-cutover-token",
    });
    expect(missing.status).toBe(400);

    const blankToken = await postImport({
      messages: [],
      cutoverToken: "   ",
      todoSnapshot: snapshot,
    });
    expect(blankToken.status).toBe(400);

    const first = await postImport({
      messages: [],
      scheduledTasks: [{ taskId: "baseline-reminder", active: false }],
      cutoverToken: "personal-cutover-token",
      todoSnapshot: snapshot,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      sourceTodoCount: 1,
      importedTodos: 1,
      repairedTodos: 0,
      skippedTodos: 0,
      removedStaleTodos: 0,
      sourceTodoMutationCount: 1,
      importedTodoMutations: 1,
      skippedTodoMutations: 0,
      sourceTodoDigest: snapshot.digest,
      targetTodoDigest: snapshot.digest,
    });
    expect(controlPlane.store.getTodos(sandboxId, CONVERSATION_ID)).toEqual(
      snapshot.todos,
    );
    expect(
      controlPlane.store.getTodoMutations(sandboxId, CONVERSATION_ID),
    ).toEqual(snapshot.mutations);
    expect(
      controlPlane.store.getTodoMutationsByAgent(
        DEDICATED_AGENT_ID,
        CONVERSATION_ID,
      ),
    ).toEqual(snapshot.mutations);
    const baselineMessages = structuredClone(
      controlPlane.store.getConversation(sandboxId, CONVERSATION_ID),
    );
    const baselineTasks = structuredClone(
      controlPlane.store.getScheduledTasks(sandboxId, CONVERSATION_ID),
    );
    const baselineTodos = controlPlane.store.getTodos(
      sandboxId,
      CONVERSATION_ID,
    );
    const baselineMutations = controlPlane.store.getTodoMutations(
      sandboxId,
      CONVERSATION_ID,
    );

    const replay = await postImport({
      messages: [],
      cutoverToken: "personal-cutover-token",
      todoSnapshot: snapshot,
      activateScheduledTasks: true,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      importedTodos: 0,
      repairedTodos: 0,
      skippedTodos: 1,
      sourceTodoMutationCount: 1,
      importedTodoMutations: 0,
      skippedTodoMutations: 1,
      targetTodoDigest: snapshot.digest,
    });

    const conflictingSnapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: CONVERSATION_ID,
      todos: snapshot.todos,
      mutations: [{ ...mutation, requestDigest: "b".repeat(64) }],
    });
    const conflictingReplay = await postImport({
      messages: [{ role: "user", text: "must not partially import" }],
      scheduledTasks: [{ taskId: "must-not-partially-import" }],
      cutoverToken: "personal-cutover-token",
      todoSnapshot: conflictingSnapshot,
    });
    expect(conflictingReplay.status).toBe(500);
    expect(
      controlPlane.store.getConversation(sandboxId, CONVERSATION_ID),
    ).toEqual(baselineMessages);
    expect(
      controlPlane.store.getScheduledTasks(sandboxId, CONVERSATION_ID),
    ).toEqual(baselineTasks);
    expect(controlPlane.store.getTodos(sandboxId, CONVERSATION_ID)).toEqual(
      baselineTodos,
    );
    expect(
      controlPlane.store.getTodoMutations(sandboxId, CONVERSATION_ID),
    ).toEqual(baselineMutations);

    const smallerSnapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: CONVERSATION_ID,
      todos: snapshot.todos,
      mutations: [],
    });
    const smallerImport = await postImport({
      messages: [],
      cutoverToken: "personal-cutover-token",
      todoSnapshot: smallerSnapshot,
    });
    expect(smallerImport.status).toBe(200);
    expect(await smallerImport.json()).toMatchObject({
      sourceTodoMutationCount: 0,
      importedTodoMutations: 0,
      skippedTodoMutations: 0,
      sourceTodoDigest: smallerSnapshot.digest,
      targetTodoDigest: smallerSnapshot.digest,
    });
    expect(
      controlPlane.store.getTodoMutations(sandboxId, CONVERSATION_ID),
      "a smaller retry cannot erase Dedicated replay authority",
    ).toEqual(baselineMutations);
  });
});
