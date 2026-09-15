/** Exercises optional creation identity omission through canonical owner dispatch and real PGlite. */
import {
  ChannelType,
  executePlannedToolCall,
  type JsonValue,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { ownerTodosAction } from "../actions/owner-surfaces.js";
import { LifeOpsService } from "./service.js";

it("accepts the declared empty tool sentinel as absent identity without weakening keyed creation validation", async () => {
  const host = await createLifeOpsTestRuntime();
  const runtime = host.runtime;
  const ownerId = crypto.randomUUID() as UUID;
  const service = new LifeOpsService(runtime, { ownerEntityId: ownerId });
  const worldId = crypto.randomUUID() as UUID;
  const message: Memory = {
    id: crypto.randomUUID() as UUID,
    agentId: runtime.agentId,
    entityId: ownerId,
    roomId: crypto.randomUUID() as UUID,
    worldId,
    content: {
      source: "dashboard",
      text: "Create Wire owner record with no deadline. Update its description, review it, and delete it. Then create Unkeyed owner record without a deadline.",
    },
  };
  try {
    runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", ownerId);
    await runtime.ensureConnection({
      entityId: ownerId,
      roomId: message.roomId,
      worldId,
      worldName: "Wire owner world",
      userName: "wire-owner",
      name: "Wire owner",
      source: "dashboard",
      type: ChannelType.DM,
      channelId: message.roomId,
    });
    const create = {
      action: "create",
      title: "Wire owner record",
      intent: "Create Wire owner record with no deadline.",
      idempotencyKey: "wire-owner",
      details: {
        cadence: { kind: "unscheduled" },
        kind: "task",
        timeZone: "UTC",
      },
    };
    const dispatch = (params: Record<string, JsonValue>) =>
      executePlannedToolCall(
        runtime,
        { message, activeContexts: ["tasks"] },
        { name: "OWNER_TODOS", params },
        { actions: [ownerTodosAction] },
      );
    const first = await dispatch(create);
    expect(first.success).toBe(true);
    const id = first.effectReceipts?.[0].resource.id;
    if (!id) throw new Error("Creation omitted resource identity");
    const replay = await dispatch(create);
    expect(replay.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      resource: { id },
      idempotency: { replayed: true },
    });
    const updated = await dispatch({
      action: "update",
      target: id,
      idempotencyKey: "",
      details: {
        description: "verified through canonical omitted-key dispatch",
      },
    });
    expect(updated.success).toBe(true);
    expect(
      (await service.listDefinitions()).find((row) => row.definition.id === id)
        ?.definition.description,
    ).toBe("verified through canonical omitted-key dispatch");
    const reviewed = await dispatch({
      action: "review",
      target: id,
      idempotencyKey: "",
    });
    expect(reviewed.success).toBe(true);
    const deleted = await dispatch({
      action: "delete",
      target: id,
      idempotencyKey: "",
    });
    expect(deleted.success).toBe(true);
    expect(
      (await service.listDefinitions()).some((row) => row.definition.id === id),
    ).toBe(false);
    const unkeyed = await dispatch({
      ...create,
      title: "Unkeyed owner record",
      intent: "Create Unkeyed owner record without a deadline.",
      idempotencyKey: "",
    });
    expect(unkeyed.success).toBe(true);
    expect(unkeyed.data).toMatchObject({
      idempotency: { key: null, replayed: false },
    });
    const before = await service.listDefinitions();
    for (const key of ["x".repeat(257), "invalid\0key"]) {
      const invalid = await dispatch({
        ...create,
        title: "Invalid key record",
        idempotencyKey: key,
      });
      expect(invalid.success).toBe(false);
    }
    expect(await service.listDefinitions()).toEqual(before);
    await expect(
      service.createDefinition({
        title: "Direct invalid key",
        kind: "task",
        cadence: { kind: "unscheduled" },
        timezone: "UTC",
        reminderPlan: null,
        idempotencyKey: "",
      }),
    ).rejects.toMatchObject({
      code: "LIFEOPS_DEFINITION_IDEMPOTENCY_KEY_INVALID",
    });
    const whitespace = await dispatch({
      action: "review",
      idempotencyKey: "   ",
    });
    expect(whitespace.success).toBe(true);
    expect(await service.listDefinitions()).toEqual(before);
  } finally {
    await host.cleanup();
  }
}, 180000);
