/**
 * Contract tests for the owner-activation boundary: exactly-once durable
 * activation turn per owner+agent+contract version, established-owner
 * exemptions, crash/restart reconciliation, failed-write retry semantics, and
 * the HTTP route translation. Deterministic harness: a minimal runtime stub
 * with a real in-memory message store standing in for the adapter.
 */

import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  activationMemoryId,
  OWNER_ACTIVATION_CONTRACT_VERSION,
  OWNER_ACTIVATION_MESSAGE,
  OwnerActivationService,
} from "../src/lifeops/first-run/activation.js";
import { createOwnerFactStore } from "../src/lifeops/first-run/state.js";
import { handleOwnerActivationRoutes } from "../src/routes/first-run-activation-routes.js";
import type { LifeOpsRouteContext } from "../src/routes/lifeops-routes.js";
import { createMinimalRuntimeStub } from "./first-run-helpers.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const ROOM_ID = "22222222-2222-4222-8222-222222222222" as UUID;

interface MessageStoreHarness {
  runtime: IAgentRuntime;
  messages: Memory[];
  failNextCreate: { value: boolean };
}

function createActivationRuntime(): MessageStoreHarness {
  const messages: Memory[] = [];
  const failNextCreate = { value: false };
  const runtime = createMinimalRuntimeStub({
    getMemoryById: (async (id: UUID) =>
      messages.find((m) => m.id === id) ?? null) as never,
    getMemories: (async (params: { roomId?: UUID }) =>
      messages.filter(
        (m) => !params.roomId || m.roomId === params.roomId,
      )) as never,
    createMemory: (async (memory: Memory) => {
      if (failNextCreate.value) {
        failNextCreate.value = false;
        throw new Error("simulated adapter outage");
      }
      if (messages.some((item) => item.id === memory.id)) {
        throw new Error("duplicate memory id");
      }
      messages.push(memory);
      return memory.id;
    }) as never,
    getRoom: (async (roomId: UUID) =>
      roomId === ROOM_ID
        ? {
            id: ROOM_ID,
            agentId: runtime?.agentId,
            source: "client_chat",
            type: ChannelType.DM,
          }
        : null) as never,
    getParticipantsForRoom: (async (roomId: UUID) =>
      roomId === ROOM_ID ? [OWNER_ID, runtime?.agentId] : []) as never,
    getRoomsForParticipant: (async (entityId: UUID) =>
      entityId === OWNER_ID ? [ROOM_ID] : []) as never,
  });
  return { runtime, messages, failNextCreate };
}

describe("OwnerActivationService", () => {
  it("persists exactly one durable activation turn and is idempotent across calls and restarts", async () => {
    const { runtime, messages } = createActivationRuntime();
    const service = new OwnerActivationService(runtime);

    const first = await service.ensureActivated({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
    });
    expect(first.outcome).toBe("activated");
    expect(first.entry.status).toBe("complete");
    expect(first.entry.memoryId).toBe(
      activationMemoryId(
        OWNER_ID,
        runtime.agentId,
        OWNER_ACTIVATION_CONTRACT_VERSION,
      ),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content.text).toBe(OWNER_ACTIVATION_MESSAGE);
    expect(messages[0].roomId).toBe(ROOM_ID);
    expect(messages[0].metadata).toMatchObject({
      scope: "owner-private",
      scopedToEntityId: OWNER_ID,
    });
    expect(await runtime.getCache("eliza:lifeops:first-run:v1")).toMatchObject({
      status: "complete",
      completionCount: 1,
    });

    const second = await service.ensureActivated({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
    });
    expect(second.outcome).toBe("already_complete");
    expect(messages).toHaveLength(1);

    // Restart: a fresh service over the same runtime state stays idempotent.
    const restarted = new OwnerActivationService(runtime);
    const third = await restarted.ensureActivated({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
    });
    expect(third.outcome).toBe("already_complete");
    expect(messages).toHaveLength(1);
  });

  it("reconciles a crash between the durable write and the completion marker without a second turn", async () => {
    const { runtime, messages } = createActivationRuntime();
    await new OwnerActivationService(runtime).ensureActivated({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
    });
    // Simulate the marker write being lost.
    await runtime.deleteCache("eliza:lifeops:owner-activation:v1");

    const result = await new OwnerActivationService(runtime).ensureActivated({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
    });
    expect(result.outcome).toBe("already_complete");
    expect(result.entry.memoryId).toBe(messages[0].id);
    expect(messages).toHaveLength(1);
  });

  it("exempts an owner with an existing primary goal (negative control)", async () => {
    const { runtime, messages } = createActivationRuntime();
    await createOwnerFactStore(runtime).update(
      { primaryGoal: "ship the iOS app" },
      { source: "agent_inferred", recordedAt: new Date().toISOString() },
    );
    const result = await new OwnerActivationService(runtime).ensureActivated({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
    });
    expect(result.outcome).toBe("exempt");
    expect(result.entry.exemptReason).toBe("existing_primary_goal");
    expect(messages).toHaveLength(0);
  });

  it("exempts an owner whose room already has real conversation history", async () => {
    const { runtime, messages } = createActivationRuntime();
    messages.push({
      id: "33333333-3333-4333-8333-333333333333" as UUID,
      entityId: OWNER_ID,
      agentId: runtime.agentId,
      roomId: ROOM_ID,
      content: { text: "hey, what can you do?", source: "client_chat" },
      createdAt: Date.now(),
    });
    const result = await new OwnerActivationService(runtime).ensureActivated({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
    });
    expect(result.outcome).toBe("exempt");
    expect(result.entry.exemptReason).toBe("existing_history");
    expect(messages).toHaveLength(1);
  });

  it("checks the owner's other private rooms before activating a new empty room", async () => {
    const { runtime, messages } = createActivationRuntime();
    const OTHER_ROOM = "44444444-4444-4444-8444-444444444444" as UUID;
    messages.push({
      id: "55555555-5555-4555-8555-555555555555" as UUID,
      entityId: OWNER_ID,
      agentId: runtime.agentId,
      roomId: OTHER_ROOM,
      content: { text: "existing owner turn", source: "client_chat" },
      createdAt: Date.now(),
    });
    runtime.getRoomsForParticipant = (async () => [
      ROOM_ID,
      OTHER_ROOM,
    ]) as never;
    const result = await new OwnerActivationService(runtime).ensureActivated({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
    });
    expect(result.outcome).toBe("exempt");
    expect(result.entry.exemptReason).toBe("existing_history");
    expect(messages).toHaveLength(1);
  });

  it("does not mark activation complete when the durable write fails, and retries succeed", async () => {
    const { runtime, messages, failNextCreate } = createActivationRuntime();
    const service = new OwnerActivationService(runtime);
    failNextCreate.value = true;

    await expect(
      service.ensureActivated({ ownerEntityId: OWNER_ID, roomId: ROOM_ID }),
    ).rejects.toMatchObject({ code: "OWNER_ACTIVATION_WRITE_FAILED" });
    expect(await service.readEntry(OWNER_ID)).toBeNull();
    expect(messages).toHaveLength(0);

    const retry = await service.ensureActivated({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
    });
    expect(retry.outcome).toBe("activated");
    expect(messages).toHaveLength(1);
  });

  it("shares one durable write across concurrent activation calls", async () => {
    const { runtime, messages } = createActivationRuntime();
    const service = new OwnerActivationService(runtime);
    const [a, b, c] = await Promise.all([
      service.ensureActivated({ ownerEntityId: OWNER_ID, roomId: ROOM_ID }),
      service.ensureActivated({ ownerEntityId: OWNER_ID, roomId: ROOM_ID }),
      service.ensureActivated({ ownerEntityId: OWNER_ID, roomId: ROOM_ID }),
    ]);
    expect(messages).toHaveLength(1);
    expect([a, b, c].filter((r) => r.outcome === "activated")).toHaveLength(3);
    // All three resolved from the same in-flight promise, so all report the
    // single durable write; the storage state is the exactly-once proof.
    expect(
      new Set([a.entry.memoryId, b.entry.memoryId, c.entry.memoryId]).size,
    ).toBe(1);
  });

  it("shares the route service across concurrent HTTP callbacks", async () => {
    const { runtime, messages } = createActivationRuntime();
    const posts = Array.from({ length: 3 }, () =>
      makeRouteContextForConcurrency(runtime),
    );
    await Promise.all(posts.map(({ ctx }) => handleOwnerActivationRoutes(ctx)));
    expect(messages).toHaveLength(1);
    expect(posts.every(({ sent }) => sent[0]?.status === 200)).toBe(true);
  });

  it("requires an explicit reactivate opt-in after a contract-version bump", async () => {
    const { runtime, messages } = createActivationRuntime();
    const priorKey = `${OWNER_ID}:${runtime.agentId}:v0`;
    await runtime.setCache("eliza:lifeops:owner-activation:v1", {
      entries: {
        [priorKey]: {
          status: "complete",
          ownerEntityId: OWNER_ID,
          agentId: runtime.agentId,
          contractVersion: 0,
          recordedAt: new Date().toISOString(),
        },
      },
    });
    const service = new OwnerActivationService(runtime);
    const implicit = await service.ensureActivated({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
    });
    expect(implicit.outcome).toBe("exempt");
    expect(implicit.entry.exemptReason).toBe("prior_contract_activation");
    expect(messages).toHaveLength(0);

    // Clear the implicit exempt entry, then reactivate explicitly.
    await runtime.setCache("eliza:lifeops:owner-activation:v1", {
      entries: {
        [priorKey]: {
          status: "complete",
          ownerEntityId: OWNER_ID,
          agentId: runtime.agentId,
          contractVersion: 0,
          recordedAt: new Date().toISOString(),
        },
      },
    });
    const explicit = await service.ensureActivated({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
      reactivate: true,
    });
    expect(explicit.outcome).toBe("activated");
    expect(messages).toHaveLength(1);
  });
});

function makeRouteContextForConcurrency(runtime: IAgentRuntime): {
  ctx: LifeOpsRouteContext;
  sent: Array<{ data: unknown; status: number }>;
} {
  const sent: Array<{ data: unknown; status: number }> = [];
  return {
    sent,
    ctx: {
      req: {},
      res: {},
      method: "POST",
      pathname: "/api/lifeops/first-run/activate",
      url: new URL("http://localhost/api/lifeops/first-run/activate"),
      state: { runtime, adminEntityId: OWNER_ID },
      json: (_res: unknown, data: unknown, status = 200) =>
        sent.push({ data, status }),
      error: () => undefined,
      readJsonBody: async () => ({ roomId: ROOM_ID }),
      decodePathComponent: (value: string) => value,
    } as unknown as LifeOpsRouteContext,
  };
}

describe("handleOwnerActivationRoutes", () => {
  function makeCtx(args: {
    runtime: IAgentRuntime | null;
    method: string;
    pathname: string;
    body?: Record<string, unknown> | null;
    adminEntityId?: UUID | null;
  }): {
    ctx: LifeOpsRouteContext;
    sent: Array<{ data: unknown; status: number }>;
    errors: Array<{ message: string; status: number }>;
  } {
    const sent: Array<{ data: unknown; status: number }> = [];
    const errors: Array<{ message: string; status: number }> = [];
    const ctx = {
      req: {},
      res: {},
      method: args.method,
      pathname: args.pathname,
      url: new URL(`http://localhost${args.pathname}`),
      state: {
        runtime: args.runtime,
        adminEntityId:
          args.adminEntityId === undefined ? OWNER_ID : args.adminEntityId,
      },
      json: (_res: unknown, data: unknown, status = 200) => {
        sent.push({ data, status });
      },
      error: (_res: unknown, message: string, status = 400) => {
        errors.push({ message, status });
      },
      readJsonBody: async () => args.body ?? null,
      decodePathComponent: (value: string) => value,
    } as unknown as LifeOpsRouteContext;
    return { ctx, sent, errors };
  }

  it("activates through POST and reads the entry through GET", async () => {
    const { runtime, messages } = createActivationRuntime();
    const post = makeCtx({
      runtime,
      method: "POST",
      pathname: "/api/lifeops/first-run/activate",
      body: { roomId: ROOM_ID },
    });
    expect(await handleOwnerActivationRoutes(post.ctx)).toBe(true);
    expect(post.sent[0].data).toMatchObject({ outcome: "activated" });
    expect(messages).toHaveLength(1);

    const get = makeCtx({
      runtime,
      method: "GET",
      pathname: "/api/lifeops/first-run/activation",
    });
    expect(await handleOwnerActivationRoutes(get.ctx)).toBe(true);
    expect(get.sent[0].data).toMatchObject({
      entry: { status: "complete" },
    });
  });

  it("rejects a malformed roomId and ignores unrelated paths", async () => {
    const { runtime } = createActivationRuntime();
    const bad = makeCtx({
      runtime,
      method: "POST",
      pathname: "/api/lifeops/first-run/activate",
      body: { roomId: "not-a-uuid" },
    });
    expect(await handleOwnerActivationRoutes(bad.ctx)).toBe(true);
    expect(bad.errors[0]).toMatchObject({ status: 400 });

    const other = makeCtx({
      runtime,
      method: "GET",
      pathname: "/api/lifeops/goals",
    });
    expect(await handleOwnerActivationRoutes(other.ctx)).toBe(false);
  });

  it("rejects a group or non-owner target without retrying", async () => {
    const { runtime } = createActivationRuntime();
    runtime.getRoom = (async () => ({
      id: ROOM_ID,
      agentId: runtime.agentId,
      source: "discord",
      type: ChannelType.GROUP,
    })) as never;
    const { ctx, sent } = makeCtx({
      runtime,
      method: "POST",
      pathname: "/api/lifeops/first-run/activate",
      body: { roomId: ROOM_ID },
    });
    expect(await handleOwnerActivationRoutes(ctx)).toBe(true);
    expect(sent[0]).toMatchObject({
      status: 400,
      data: { code: "OWNER_ACTIVATION_PRIVATE_ROOM_REQUIRED" },
    });
  });

  it("translates a failed durable write into a retryable 503", async () => {
    const { runtime, failNextCreate } = createActivationRuntime();
    failNextCreate.value = true;
    const { ctx, sent } = makeCtx({
      runtime,
      method: "POST",
      pathname: "/api/lifeops/first-run/activate",
      body: { roomId: ROOM_ID },
    });
    expect(await handleOwnerActivationRoutes(ctx)).toBe(true);
    expect(sent[0].status).toBe(503);
    expect(sent[0].data).toMatchObject({
      code: "OWNER_ACTIVATION_WRITE_FAILED",
      retryable: true,
    });
  });

  it("returns 503 when the runtime is unavailable", async () => {
    const { ctx, errors } = makeCtx({
      runtime: null,
      method: "POST",
      pathname: "/api/lifeops/first-run/activate",
      body: { roomId: ROOM_ID },
    });
    expect(await handleOwnerActivationRoutes(ctx)).toBe(true);
    expect(errors[0]).toMatchObject({ status: 503 });
  });
});
