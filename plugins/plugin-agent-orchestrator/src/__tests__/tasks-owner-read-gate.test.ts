/**
 * Owner-privacy gate on the TASKS read surfaces (history, list_agents):
 * non-owner requesters in shared rooms must receive the owner-private denial
 * instead of the owner's task inventory, while the canonical owner and
 * agent-internal turns keep the full listing. Deterministic runtime stand-ins
 * drive the REAL handler and the REAL core role machinery (configured
 * canonical owner + unresolved-sender GUEST floor); only the task/ACP services
 * are recording stubs. Pins the live 2026-08-24 leak (tj-d1df35675bf5ad):
 * a guest's "show me logs of whats goin on" returned the owner's 32-task
 * orchestrator queue through TASKS history.
 */
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { tasksAction } from "../actions/tasks.ts";
import {
  OWNER_PRIVATE_TASK_READ_DENIAL,
  requireOwnerTaskReadAccess,
} from "../services/task-policy.js";

const AGENT_ID = stringToUuid("tasks-read-gate-agent");
const OWNER_ID = stringToUuid("tasks-read-gate-owner");
const GUEST_ID = stringToUuid("tasks-read-gate-guest");
const ROOM_ID = stringToUuid("tasks-read-gate-room");

const OWNER_TASK_TITLE = "star-chart app";

function makeRuntime(): {
  runtime: IAgentRuntime;
  listTasks: ReturnType<typeof vi.fn>;
} {
  const listTasks = vi.fn(async () => [
    {
      id: stringToUuid("tasks-read-gate-task"),
      title: OWNER_TASK_TITLE,
      status: "waiting_on_user",
      latestActivityAt: Date.now(),
      latestSessionLabel: "star-chart",
      latestSessionId: "sess-1",
      latestWorkdir: "/tmp/star-chart",
      summary: undefined,
    },
  ]);
  const acp = {
    listSessions: vi.fn(() => [
      {
        id: "sess-1",
        sessionId: "sess-1",
        agentType: "codex",
        name: "star-chart",
        workdir: "/tmp/star-chart",
        status: "ready",
        createdAt: new Date(0),
        lastActivityAt: new Date(0),
        metadata: { label: "star-chart" },
      },
    ]),
    getSession: vi.fn(async () => undefined),
  };
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Read gate test" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // Configured canonical owner: OWNER_ID resolves as owner from any room;
    // GUEST_ID falls through checkSenderRole (no world) to the GUEST floor.
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? String(OWNER_ID) : undefined,
    getRoom: vi.fn(async () => null),
    getService: (type: string) => {
      if (type === "ORCHESTRATOR_TASK_SERVICE") return { listTasks };
      if (type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE") {
        return acp;
      }
      return undefined;
    },
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  return { runtime, listTasks };
}

function makeMessage(entityId: UUID, text: string): Memory {
  return {
    id: stringToUuid(`tasks-read-gate-msg-${text.slice(0, 24)}`),
    entityId,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    // Non-local connector source: the unresolved-sender role floor is GUEST.
    content: { text, source: "webhook" },
    createdAt: Date.now(),
  } as Memory;
}

async function run(
  runtime: IAgentRuntime,
  entityId: UUID,
  action: string,
  text: string,
) {
  const result = await tasksAction.handler(
    runtime,
    makeMessage(entityId, text),
    undefined as unknown as State,
    { parameters: { action } },
    async () => [],
  );
  if (!result) throw new Error("expected a result");
  return result;
}

describe("TASKS owner-read gate — guests are denied the owner's inventory", () => {
  it("denies a guest on history (live leak shape) before any store read", async () => {
    const { runtime, listTasks } = makeRuntime();
    const result = await run(
      runtime,
      GUEST_ID,
      "history",
      "show me logs of whats goin on, I wanna see progress of anything happening",
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("FORBIDDEN");
    expect(String(result.text)).toBe(OWNER_PRIVATE_TASK_READ_DENIAL);
    expect(String(result.text)).not.toContain(OWNER_TASK_TITLE);
    expect(result.data).toMatchObject({ reason: "owner_private" });
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("denies a guest on list_agents (previously ungated)", async () => {
    const { runtime } = makeRuntime();
    const result = await run(
      runtime,
      GUEST_ID,
      "list_agents",
      "what agents are running",
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("FORBIDDEN");
    expect(String(result.text)).toBe(OWNER_PRIVATE_TASK_READ_DENIAL);
    expect(String(result.text)).not.toContain("star-chart");
  });

  it("fails closed on a message without a sender identity", async () => {
    const { runtime } = makeRuntime();
    const access = await requireOwnerTaskReadAccess(runtime, {
      id: stringToUuid("tasks-read-gate-anon"),
      roomId: ROOM_ID,
      content: { text: "history please" },
    } as Memory);
    expect(access.allowed).toBe(false);
  });
});

describe("TASKS owner-read gate — owner and agent-self keep the listing", () => {
  it("returns the owner's task history to the owner", async () => {
    const { runtime, listTasks } = makeRuntime();
    const result = await run(
      runtime,
      OWNER_ID,
      "history",
      "show me my task history",
    );
    expect(result.success).toBe(true);
    expect(String(result.text)).toContain(OWNER_TASK_TITLE);
    expect(listTasks).toHaveBeenCalled();
  });

  it("returns active sessions to the owner via list_agents", async () => {
    const { runtime } = makeRuntime();
    const result = await run(
      runtime,
      OWNER_ID,
      "list_agents",
      "what agents are running",
    );
    expect(result.success).toBe(true);
    expect(String(result.text)).toContain("star-chart");
  });

  it("agent-internal turns (orchestration loop) pass the gate", async () => {
    const { runtime } = makeRuntime();
    const result = await run(
      runtime,
      AGENT_ID,
      "list_agents",
      "internal sweep",
    );
    expect(result.success).toBe(true);
    expect(String(result.text)).toContain("star-chart");
  });
});
