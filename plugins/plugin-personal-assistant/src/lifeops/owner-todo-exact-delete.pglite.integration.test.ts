/** Exercises exact delete targets within a multi-operation owner request through canonical dispatch and real PGlite. */
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

it.each([
  "owned",
  "title",
  "missing",
  "foreign",
  "bulk",
  "protected",
  "missing-title",
  "empty-target",
  "alias",
  "protected-substring",
])(
  "constrains a multi-step delete to its durable target: %s",
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
        text: "Create a todo named Guardian chain first without any deadline. Create a second todo named Guardian chain second, also without any deadline. Update and read both, then delete only the first by its returned ID. Check that the second remains.",
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
        title: "Guardian chain first",
        intent: "Create Guardian chain first without any deadline.",
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
      const secondTitle =
        mode === "protected-substring"
          ? "Guardian chain first sequel"
          : "Guardian chain second";
      const second = await dispatch({
        action: "create",
        title: secondTitle,
        intent: `Create ${secondTitle} without any deadline.`,
        idempotencyKey: "second",
        details: {
          kind: "task",
          cadence: { kind: "unscheduled" },
          timeZone: "UTC",
        },
      });
      expect(second.success).toBe(true);
      const secondId = second.effectReceipts?.[0].resource.id;
      let targetId = mode === "title" ? "Guardian chain first" : id;
      if (mode === "protected-substring") {
        targetId = "Guardian chain first";
        message.content.text =
          "Keep Guardian chain first. Read Guardian chain first sequel.";
      }
      if (mode === "protected" || mode === "empty-target")
        targetId = "Guardian chain first";
      if (mode === "missing-title") targetId = "Nonexistent exact target";
      if (mode === "alias") targetId = "chain first";
      if (mode === "protected")
        message.content.text =
          "Keep Guardian chain first. Read Guardian chain second. Do not change the second.";
      if (mode === "missing-title")
        message.content.text =
          "Read Guardian chain second. Delete Nonexistent exact target.";
      let foreignService: LifeOpsService | undefined;
      if (mode === "missing") targetId = crypto.randomUUID();
      if (mode === "foreign") {
        const foreignOwner = crypto.randomUUID() as UUID;
        foreignService = new LifeOpsService(runtime, {
          ownerEntityId: foreignOwner,
        });
        const foreignRecord = await foreignService.createDefinition({
          title: "Foreign record",
          kind: "task",
          cadence: { kind: "unscheduled" },
          timezone: "UTC",
          reminderPlan: null,
        });
        targetId = foreignRecord.definition.id;
      }
      if (mode === "bulk")
        message.content.text =
          "Delete these todos: Guardian chain first and Guardian chain second.";
      const deleted = await dispatch(
        mode === "bulk"
          ? {
              action: "delete",
              intent: message.content.text ?? "",
            }
          : {
              action: "delete",
              target: mode === "empty-target" ? "" : targetId,
              title: "Guardian chain first",
              intent: "Delete the first todo by its returned ID.",
            },
      );
      const rows = await service.listDefinitions();
      if (mode === "bulk") {
        expect(deleted.success).toBe(true);
        expect(rows).toEqual([]);
      } else if (
        mode === "owned" ||
        mode === "title" ||
        mode === "empty-target" ||
        mode === "alias"
      ) {
        expect(deleted.success).toBe(true);
        expect(rows.map((row) => row.definition.id)).toEqual([secondId]);
        expect(
          deleted.effectReceipts?.map((receipt) => receipt.resource.id),
        ).toEqual([id]);
      } else {
        expect(deleted.success).toBe(false);
        expect(new Set(rows.map((row) => row.definition.id))).toEqual(
          new Set([id, secondId]),
        );
        expect(
          deleted.effectReceipts?.some(
            (receipt) => receipt.outcome === "applied",
          ) ?? false,
        ).toBe(false);
        if (foreignService)
          expect(
            (await foreignService.listDefinitions()).map(
              (row) => row.definition.id,
            ),
          ).toEqual([targetId]);
      }
    } finally {
      await host.cleanup();
    }
  },
  120000,
);
