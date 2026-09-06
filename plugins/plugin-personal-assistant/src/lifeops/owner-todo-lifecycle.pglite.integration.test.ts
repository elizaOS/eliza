/** Exercises undated owner todo creation, completion and reopening through canonical dispatch and real PGlite. */
import {
  ChannelType,
  type JsonValue,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { executePlannedToolCall } from "../../../../packages/core/src/runtime/execute-planned-tool-call.ts";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { ownerTodosAction } from "../actions/owner-surfaces.js";
import { LifeOpsService } from "./service.js";

it.each(["sequential", "interleaved"])(
  "preserves matching owner lifecycle receipts: %s",
  async (mode) => {
    const host = await createLifeOpsTestRuntime();
    const runtime = host.runtime;
    const owner = crypto.randomUUID() as UUID;
    const worldId = crypto.randomUUID() as UUID;
    const message: Memory = {
      id: crypto.randomUUID() as UUID,
      agentId: runtime.agentId,
      entityId: owner,
      roomId: crypto.randomUUID() as UUID,
      worldId,
      content: {
        source: "dashboard",
        text: "Create a todo named Lifecycle owner item without any deadline. Mark it done, then reopen it.",
      },
    };
    try {
      runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", owner);
      await runtime.ensureConnection({
        entityId: owner,
        roomId: message.roomId,
        worldId,
        worldName: "Lifecycle owner world",
        userName: "lifecycle-owner",
        name: "Lifecycle owner",
        source: "dashboard",
        type: ChannelType.DM,
        channelId: message.roomId,
      });
      const dispatch = (params: Record<string, JsonValue>) =>
        executePlannedToolCall(
          runtime,
          { message, activeContexts: ["tasks"] },
          { name: "OWNER_TODOS", params },
          { actions: [ownerTodosAction] },
        );
      const created = await dispatch({
        action: "create",
        title: "Lifecycle owner item",
        intent: "Create Lifecycle owner item without any deadline.",
        idempotencyKey: "lifecycle-a",
        details: {
          kind: "task",
          cadence: { kind: "unscheduled" },
          timeZone: "UTC",
        },
      });
      expect(created.success).toBe(true);
      const id = created.effectReceipts?.[0].resource.id;
      if (!id) throw new Error("Creation omitted durable ID");
      const service = new LifeOpsService(runtime, { ownerEntityId: owner });
      const originalComplete = LifeOpsService.prototype.completeTodo;
      let interleaved = false;
      let initialTransition:
        | Awaited<ReturnType<LifeOpsService["completeTodo"]>>
        | undefined;
      if (mode === "interleaved") {
        LifeOpsService.prototype.completeTodo = async function (targetId) {
          const first = await originalComplete.call(this, targetId);
          if (!interleaved) {
            interleaved = true;
            initialTransition = first;
            await this.reopenTodo(targetId);
            await originalComplete.call(this, targetId);
          }
          return first;
        };
      }
      let completed: Awaited<ReturnType<typeof dispatch>>;
      try {
        completed = await dispatch({ action: "complete", target: id });
      } finally {
        LifeOpsService.prototype.completeTodo = originalComplete;
      }
      if (initialTransition) {
        expect(completed.effectReceipts?.[0]).toMatchObject({
          commit: { id: initialTransition.auditId },
          resource: { version: initialTransition.definition.updatedAt },
        });
        expect((await service.getDefinition(id)).definition.updatedAt).not.toBe(
          initialTransition.definition.updatedAt,
        );
      }
      expect(completed.success).toBe(true);
      expect(completed.effectReceipts?.[0]).toMatchObject({
        outcome: "applied",
        operation: "lifeops.definition.complete",
        resource: { id },
      });
      expect((await service.getDefinition(id)).definition.status).toBe(
        "completed",
      );
      const repeated = await dispatch({ action: "complete", target: id });
      expect(repeated.effectReceipts?.[0]).toMatchObject({
        outcome: "noop",
        operation: "lifeops.definition.complete",
        resource: { id },
        idempotency: { replayed: true },
      });
      if (mode === "sequential")
        expect(repeated.effectReceipts?.[0].receiptId).toBe(
          completed.effectReceipts?.[0].receiptId,
        );
      const reopened = await dispatch({ action: "reopen", target: id });
      expect(reopened.success).toBe(true);
      expect(reopened.effectReceipts?.[0]).toMatchObject({
        outcome: "applied",
        operation: "lifeops.definition.reopen",
        resource: { id },
      });
      expect((await service.getDefinition(id)).definition).toMatchObject({
        status: "active",
        cadence: { kind: "unscheduled" },
      });
      expect(
        await service.repository.listOccurrencesForDefinition(
          runtime.agentId,
          id,
        ),
      ).toHaveLength(0);
      expect(await service.getTodos()).toEqual([
        expect.objectContaining({
          id,
          targetKind: "definition",
          dueDate: null,
          status: "pending",
        }),
      ]);
      const secondComplete = await dispatch({ action: "complete", target: id });
      expect(secondComplete.effectReceipts?.[0].receiptId).not.toBe(
        completed.effectReceipts?.[0].receiptId,
      );
      await service.reopenTodo(id);
      const replay = await dispatch({ action: "reopen", target: id });
      expect(replay.effectReceipts?.[0].outcome).toBe("noop");
      const wrongTarget = await dispatch({
        action: "complete",
        target: crypto.randomUUID(),
      });
      expect(wrongTarget.success).toBe(false);
      expect((await service.getDefinition(id)).definition.status).toBe(
        "active",
      );
      message.content.text =
        "Create Contradictory owner item without any deadline, but actually schedule it tomorrow at 9.";
      const denied = await dispatch({
        action: "create",
        title: "Contradictory owner item",
        intent: message.content.text,
        idempotencyKey: "lifecycle-b",
        details: {
          kind: "task",
          cadence: { kind: "unscheduled" },
          timeZone: "UTC",
        },
      });
      expect(denied.effectReceipts?.[0].outcome).not.toBe("applied");
      expect(
        (await service.listDefinitions()).map((row) => row.definition.id),
      ).toEqual([id]);
    } finally {
      await host.cleanup();
    }
  },
  180000,
);
