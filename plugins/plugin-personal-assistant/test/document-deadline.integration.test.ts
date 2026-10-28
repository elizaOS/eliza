import type { ActionResult, Memory, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { ownerDocumentsAction } from "../src/actions/document.ts";
import { getScheduledTaskRunner } from "../src/lifeops/scheduled-task/service.ts";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.ts";

function ownerMessage(agentId: UUID, text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: agentId,
    roomId: agentId,
    agentId,
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

function taskId(result: ActionResult | undefined): string {
  const value = (
    result?.data as { scheduledTaskId?: string | null } | undefined
  )?.scheduledTaskId;
  if (!value) throw new Error("document action returned no scheduled task");
  return value;
}

describe("OWNER_DOCUMENTS deadline tracking", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("replaces the active watcher when the owner changes a deadline", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const message = ownerMessage(
      runtime.agentId,
      "Track the contract deadline",
    );

    const created = await ownerDocumentsAction.handler?.(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "request_approval",
          documentTitle: "Vendor contract",
          deadline: "2026-11-01T17:00:00.000Z",
        },
      },
      undefined,
      [],
    );
    expect(created?.success).toBe(true);
    const oldTaskId = taskId(created);
    const documentRequestId = (
      created?.data as { documentRequestId?: string } | undefined
    )?.documentRequestId;
    if (!documentRequestId) {
      throw new Error("document action returned no document request");
    }

    const updated = await ownerDocumentsAction.handler?.(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "track_deadline",
          documentRequestId,
          deadline: "2026-11-08T17:00:00.000Z",
        },
      },
      undefined,
      [],
    );
    expect(updated?.success).toBe(true);
    const newTaskId = taskId(updated);
    expect(newTaskId).toBe(oldTaskId);

    const tasks = await getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    }).list();
    const documentTasks = tasks.filter(
      (task) => task.metadata?.documentRequestId === documentRequestId,
    );
    expect(documentTasks).toHaveLength(1);
    expect(documentTasks[0]?.state.status).toBe("scheduled");
    expect(documentTasks[0]?.trigger).toEqual({
      kind: "once",
      atIso: "2026-11-08T17:00:00.000Z",
    });
  });

  it.each([
    // New York is on EST (-05:00) in November.
    ["an offset-free time", "2030-11-06T17:00:00", "2030-11-06T22:00:00.000Z"],
    [
      "a bare day (start of that day)",
      "2030-11-06",
      "2030-11-06T05:00:00.000Z",
    ],
  ])("reads %s in the owner's time zone", async (_case, deadline, atIso) => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const message = ownerMessage(runtime.agentId, "Track the lease deadline");
    message.content.metadata = { uiTimeZone: "America/New_York" };

    const created = await ownerDocumentsAction.handler?.(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "request_approval",
          documentTitle: "Lease renewal",
          deadline,
        },
      },
      undefined,
      [],
    );
    expect(created?.success).toBe(true);

    const task = (
      await getScheduledTaskRunner(runtime, { agentId: runtime.agentId }).list()
    ).find((candidate) => candidate.taskId === taskId(created));
    expect(task?.trigger).toEqual({ kind: "once", atIso });
  });
});
