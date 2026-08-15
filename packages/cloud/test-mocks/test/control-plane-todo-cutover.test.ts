/**
 * Production-faithful mock proof for the digest-bound Todo snapshot carried
 * by an exact Shared-to-Dedicated conversation import.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSharedTodoCutoverSnapshot } from "@elizaos/shared/todo-cutover";
import {
  type RunningControlPlaneMock,
  startControlPlaneMock,
} from "../src/control-plane";
import { type RunningHetznerMock, startHetznerMock } from "../src/hetzner";

const TOKEN = "todo-cutover-token";
const CONVERSATION_ID = "personal:todo-cutover-source";
const SANDBOX_ID = "dedicated-todo-target";

let controlPlane: RunningControlPlaneMock;
let hetzner: RunningHetznerMock;

beforeAll(async () => {
  hetzner = await startHetznerMock({ actionMs: 5 });
  controlPlane = await startControlPlaneMock({
    token: TOKEN,
    expectedAuxToken: "",
    hetznerUrl: hetzner.url,
    hetznerToken: "test-token",
  });
});

afterAll(async () => {
  await controlPlane.stop();
  await hetzner.stop();
});

async function postImport(body: Record<string, unknown>): Promise<Response> {
  return fetch(
    `${controlPlane.url}/api/compat/agents/${SANDBOX_ID}/api/conversations/${encodeURIComponent(CONVERSATION_ID)}/import`,
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
    const snapshot = await createSharedTodoCutoverSnapshot({
      sourceAgentId: CONVERSATION_ID,
      todos: [
        {
          sourceId: "shared-todo-1",
          roomId: "shared-room-1",
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
      sourceTodoDigest: snapshot.digest,
      targetTodoDigest: snapshot.digest,
    });
    expect(controlPlane.store.getTodos(SANDBOX_ID, CONVERSATION_ID)).toEqual(
      snapshot.todos,
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
      targetTodoDigest: snapshot.digest,
    });
  });
});
