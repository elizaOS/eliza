/**
 * Unit tests for the agent-owned trigger-create preflight
 * (`interceptTriggerCreate`): prompt-kind POST /api/triggers creates are bound
 * to a resolvable delivery conversation or rejected typed, while workflow-kind
 * creates and every other route fall through to the workflow plugin delegate
 * (with the consumed JSON body replayed). Deterministic mocked runtime; no
 * HTTP server or database.
 */
import type http from "node:http";
import type { IAgentRuntime, Memory, Room, Task, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { TRIGGER_TASK_NAME } from "../triggers/runtime.ts";
import type { TriggerTaskMetadata } from "../triggers/types.ts";
import {
  interceptTriggerCreate,
  type TriggerCreatePreflightContext,
} from "./trigger-routes.ts";

const AGENT_NAME = "trigger-route-test-agent";
const WORLD_ID = stringToUuid(`${AGENT_NAME}-web-chat-world`);

interface RuntimeHandle {
  runtime: IAgentRuntime;
  createdTasks: Array<{
    name: string;
    roomId?: UUID;
    metadata?: TriggerTaskMetadata;
  }>;
}

function makeRuntime(options: {
  conversationRooms?: Array<{ id: UUID; latestMessageAt?: number }>;
  explicitRooms?: UUID[];
  existingTasks?: Task[];
}): RuntimeHandle {
  const createdTasks: RuntimeHandle["createdTasks"] = [];
  const conversationRooms = options.conversationRooms ?? [];
  const explicitRooms = new Set(options.explicitRooms ?? []);
  let tasks: Task[] = [...(options.existingTasks ?? [])];

  const runtime = {
    agentId: stringToUuid("trigger-route-agent"),
    character: { name: AGENT_NAME },
    getSetting: () => undefined,
    getTasks: async () => tasks,
    getTask: async (id: UUID) => tasks.find((task) => task.id === id) ?? null,
    createTask: async (task: {
      name: string;
      description?: string;
      roomId?: UUID;
      tags?: string[];
      metadata?: TriggerTaskMetadata;
    }) => {
      createdTasks.push({
        name: task.name,
        roomId: task.roomId,
        metadata: task.metadata,
      });
      const id = stringToUuid(`created-${createdTasks.length}`);
      tasks = [...tasks, { ...task, id } as unknown as Task];
      return id;
    },
    getRoom: async (roomId: UUID) =>
      explicitRooms.has(roomId) ? ({ id: roomId } as Room) : null,
    getRoomsByWorlds: async (worldIds: UUID[]) =>
      worldIds.includes(WORLD_ID)
        ? conversationRooms.map(
            (room, index) =>
              ({ id: room.id, channelId: `web-conv-${index}` }) as Room,
          )
        : [],
    getMemories: async (params: { roomId: UUID }) => {
      const room = conversationRooms.find((seed) => seed.id === params.roomId);
      return room?.latestMessageAt
        ? ([{ createdAt: room.latestMessageAt }] as Memory[])
        : [];
    },
  } as unknown as IAgentRuntime;

  return { runtime, createdTasks };
}

interface PreflightHarness {
  ctx: TriggerCreatePreflightContext;
  jsonCalls: Array<{ data: unknown; status?: number }>;
  errorCalls: Array<{ message: string; status?: number }>;
  bodyReads: number;
}

function makeCtx(params: {
  runtime: IAgentRuntime | null;
  method?: string;
  pathname?: string;
  body?: Record<string, unknown> | null;
}): PreflightHarness {
  const jsonCalls: PreflightHarness["jsonCalls"] = [];
  const errorCalls: PreflightHarness["errorCalls"] = [];
  const harness: PreflightHarness = {
    jsonCalls,
    errorCalls,
    bodyReads: 0,
    ctx: {
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: params.method ?? "POST",
      pathname: params.pathname ?? "/api/triggers",
      runtime: params.runtime,
      readJsonBody: async <T extends object>() => {
        harness.bodyReads += 1;
        return (params.body ?? null) as T | null;
      },
      json: (_res, data, status) => {
        jsonCalls.push({ data, status });
      },
      error: (_res, message, status) => {
        errorCalls.push({ message, status });
      },
    },
  };
  return harness;
}

describe("interceptTriggerCreate", () => {
  it("ignores non-create trigger routes without reading the body", async () => {
    const { runtime } = makeRuntime({});
    const harness = makeCtx({
      runtime,
      method: "GET",
      pathname: "/api/triggers",
    });
    const result = await interceptTriggerCreate(harness.ctx);
    expect(result).toEqual({ handled: false });
    expect(harness.bodyReads).toBe(0);
  });

  it("defers missing-runtime and other-route handling to the delegate", async () => {
    const harness = makeCtx({ runtime: null, body: { kind: "prompt" } });
    const result = await interceptTriggerCreate(harness.ctx);
    expect(result).toEqual({ handled: false });
    expect(harness.bodyReads).toBe(0);
  });

  it("passes workflow-kind creates through with a body replay for the delegate", async () => {
    const { runtime, createdTasks } = makeRuntime({});
    const body = { kind: "workflow", workflowId: "wf-1" };
    const harness = makeCtx({ runtime, body });
    const result = await interceptTriggerCreate(harness.ctx);
    expect(result.handled).toBe(false);
    expect(createdTasks).toHaveLength(0);
    // The consumed body is replayed so the plugin's create sees it unchanged.
    const replayed = await result.replayJsonBody?.(
      harness.ctx.req,
      harness.ctx.res,
    );
    expect(replayed).toBe(body);
  });

  it("rejects a roomless prompt create typed and actionable when no conversation exists", async () => {
    const { runtime, createdTasks } = makeRuntime({});
    const harness = makeCtx({
      runtime,
      body: {
        kind: "prompt",
        createdBy: "api",
        instructions: "time to stretch",
        triggerType: "interval",
        intervalMs: 60_000,
      },
    });

    const result = await interceptTriggerCreate(harness.ctx);

    expect(result.handled).toBe(true);
    expect(createdTasks).toHaveLength(0);
    expect(harness.errorCalls).toHaveLength(1);
    expect(harness.errorCalls[0]?.status).toBe(400);
    expect(harness.errorCalls[0]?.message).toContain(
      "no delivery conversation available",
    );
    expect(harness.errorCalls[0]?.message).toContain("roomId");
  });

  it("binds a roomless prompt create to the owner's most recently active conversation", async () => {
    const older = stringToUuid("conv-older");
    const newer = stringToUuid("conv-newer");
    const { runtime, createdTasks } = makeRuntime({
      conversationRooms: [
        { id: older, latestMessageAt: 1_000 },
        { id: newer, latestMessageAt: 2_000 },
      ],
    });
    const harness = makeCtx({
      runtime,
      body: {
        kind: "prompt",
        createdBy: "api",
        displayName: "Daily Stretch",
        instructions: "time to stretch",
        triggerType: "interval",
        intervalMs: 60_000,
      },
    });

    const result = await interceptTriggerCreate(harness.ctx);

    expect(result.handled).toBe(true);
    expect(harness.errorCalls).toHaveLength(0);
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0]?.name).toBe(TRIGGER_TASK_NAME);
    expect(createdTasks[0]?.roomId).toBe(newer);
    expect(createdTasks[0]?.metadata?.trigger?.kind).toBe("prompt");
    expect(harness.jsonCalls).toHaveLength(1);
    expect(harness.jsonCalls[0]?.status).toBe(201);
    const payload = harness.jsonCalls[0]?.data as {
      trigger?: { displayName?: string; createdBy?: string };
    };
    expect(payload.trigger?.displayName).toBe("Daily Stretch");
    expect(payload.trigger?.createdBy).toBe("api");
  });

  it("binds to an explicitly supplied roomId after verifying the room exists", async () => {
    const explicitRoomId = stringToUuid("explicit-room");
    const { runtime, createdTasks } = makeRuntime({
      explicitRooms: [explicitRoomId],
    });
    const harness = makeCtx({
      runtime,
      body: {
        kind: "prompt",
        instructions: "check in",
        triggerType: "interval",
        intervalMs: 60_000,
        roomId: explicitRoomId,
      },
    });

    const result = await interceptTriggerCreate(harness.ctx);

    expect(result.handled).toBe(true);
    expect(harness.errorCalls).toHaveLength(0);
    expect(createdTasks[0]?.roomId).toBe(explicitRoomId);
  });

  it("rejects an explicit roomId that names no existing room", async () => {
    const { runtime, createdTasks } = makeRuntime({});
    const harness = makeCtx({
      runtime,
      body: {
        kind: "prompt",
        instructions: "check in",
        triggerType: "interval",
        intervalMs: 60_000,
        roomId: stringToUuid("missing-room"),
      },
    });

    const result = await interceptTriggerCreate(harness.ctx);

    expect(result.handled).toBe(true);
    expect(createdTasks).toHaveLength(0);
    expect(harness.errorCalls[0]?.status).toBe(400);
    expect(harness.errorCalls[0]?.message).toContain(
      "does not name an existing room",
    );
  });

  it("rejects a malformed roomId before resolving any binding", async () => {
    const { runtime, createdTasks } = makeRuntime({});
    const harness = makeCtx({
      runtime,
      body: {
        kind: "prompt",
        instructions: "check in",
        triggerType: "interval",
        intervalMs: 60_000,
        roomId: "not-a-uuid",
      },
    });

    const result = await interceptTriggerCreate(harness.ctx);

    expect(result.handled).toBe(true);
    expect(createdTasks).toHaveLength(0);
    expect(harness.errorCalls[0]?.status).toBe(400);
    expect(harness.errorCalls[0]?.message).toContain(
      "roomId must be a valid UUID",
    );
  });

  it("keeps the plugin's prompt-create validation semantics (missing instructions)", async () => {
    const { runtime, createdTasks } = makeRuntime({
      conversationRooms: [{ id: stringToUuid("conv"), latestMessageAt: 1 }],
    });
    const harness = makeCtx({
      runtime,
      body: { kind: "prompt", triggerType: "interval", intervalMs: 60_000 },
    });

    const result = await interceptTriggerCreate(harness.ctx);

    expect(result.handled).toBe(true);
    expect(createdTasks).toHaveLength(0);
    expect(harness.errorCalls[0]?.status).toBe(400);
    expect(harness.errorCalls[0]?.message).toBe(
      "instructions is required when kind is 'prompt'",
    );
  });
});
