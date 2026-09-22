/** Exercises SQL list-to-manual-trigger admission and persisted repair with a recording workflow sink. */
import {
  type Memory,
  Service,
  type ServiceTypeName,
  stringToUuid,
} from "@elizaos/core";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { createIsolatedTestDatabase } from "../../../../plugins/plugin-sql/src/__tests__/test-helpers";
import { taskTable } from "../../../../plugins/plugin-sql/src/schema";
import type { DrizzleDatabase } from "../../../../plugins/plugin-sql/src/types";
import { triggerAction } from "../actions/trigger";
import { TRIGGER_TASK_NAME, TRIGGER_TASK_TAGS } from "./runtime";
import { buildTriggerConfig } from "./scheduling";

it("blocks corrupt schedules resolved by name or trigger ID before dispatch, then executes repaired rows", async () => {
  const f = await createIsolatedTestDatabase("trigger-schedule-admission");
  class WorkflowSink extends Service {
    capabilityDescription = "Record dispatch without external effects";
    calls: string[] = [];
    async stop() {}
    async execute(workflowId: string) {
      this.calls.push(workflowId);
      return { ok: true, executionId: "recorded" };
    }
  }
  const sink = new WorkflowSink(f.runtime);
  // The workflow plugin registers this closure-owned service outside the core registry.
  const workflowServiceType = "WORKFLOW_DISPATCH" as ServiceTypeName;
  f.runtime.services.set(workflowServiceType, [sink]);
  try {
    const create = async (displayName: string) => {
      const trigger = buildTriggerConfig({
        triggerId: stringToUuid(displayName),
        draft: {
          displayName,
          instructions: "Run workflow",
          triggerType: "interval",
          wakeMode: "inject_now",
          enabled: false,
          createdBy: "test",
          intervalMs: 60000,
          kind: "workflow",
          workflowId: displayName,
          workflowName: displayName,
        },
      });
      const metadata = {
        trigger,
        scheduledAt: "2026-09-21T09:00:00Z",
        updateInterval: 60000,
      };
      const id = await f.adapter.createTask({
        name: TRIGGER_TASK_NAME,
        tags: [...TRIGGER_TASK_TAGS],
        metadata,
      });
      return { id, metadata, trigger };
    };
    await create("healthy workflow");
    const damaged = await create("damaged workflow");
    const db = f.adapter.getDatabase() as DrizzleDatabase;
    await db
      .update(taskTable)
      .set({
        metadata: { ...damaged.metadata, scheduledAt: "2026-02-30T00:00:00Z" },
      })
      .where(eq(taskTable.id, damaged.id));
    const message: Memory = {
      agentId: f.testAgentId,
      entityId: f.testAgentId,
      roomId: stringToUuid("trigger-room"),
      content: { text: "run workflow" },
    };
    const run = (parameters: { displayName?: string; taskId?: string }) =>
      triggerAction.handler(f.runtime, message, undefined, {
        parameters: { action: "run", ...parameters },
      });
    expect(await run({ displayName: "healthy workflow" })).toMatchObject({
      success: true,
    });
    expect(sink.calls).toEqual(["healthy workflow"]);
    for (const parameters of [
      { displayName: "damaged workflow" },
      { taskId: damaged.trigger.triggerId },
    ]) {
      const result = await run(parameters).then(
        (value) => value,
        (error: Error) => error,
      );
      expect(sink.calls).toEqual(["healthy workflow"]);
      expect(result).toMatchObject({ code: "TASK_SCHEDULE_INVALID" });
    }
    const [stored] = await db
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, damaged.id));
    expect(stored?.metadata).toEqual({
      ...damaged.metadata,
      scheduledAt: "2026-02-30T00:00:00Z",
    });
    await f.adapter.patchTaskMetadata(damaged.id, {
      set: { scheduledAt: damaged.metadata.scheduledAt },
    });
    expect(await run({ taskId: damaged.trigger.triggerId })).toMatchObject({
      success: true,
    });
    expect(sink.calls).toEqual(["healthy workflow", "damaged workflow"]);
  } finally {
    f.runtime.services.delete(workflowServiceType);
    await f.cleanup();
  }
});
