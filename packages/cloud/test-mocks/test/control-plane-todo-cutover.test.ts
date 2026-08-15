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

describe("control-plane Todo cutover import", () => {
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
      messages: [],
      cutoverToken: "personal-cutover-token",
      todoSnapshot: conflictingSnapshot,
    });
    expect(conflictingReplay.status).toBe(500);
    expect(controlPlane.store.getTodos(sandboxId, CONVERSATION_ID)).toEqual(
      snapshot.todos,
    );
    expect(
      controlPlane.store.getTodoMutations(sandboxId, CONVERSATION_ID),
    ).toEqual(snapshot.mutations);
  });
});
