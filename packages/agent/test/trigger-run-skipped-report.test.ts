/**
 * "Run now" on a trigger whose run cap is already exhausted runs nothing:
 * the executor skips the run and deletes the trigger. The action must not
 * answer `Ran "..."` for that — the user would believe the reminder ran
 * while it was actually removed.
 *
 * The staged state is the one the real flow produces: the trigger ran five
 * times (runCount persisted by those runs), then the user capped it at
 * five total runs with an update, then asked for one more run now.
 */
import { randomUUID } from "node:crypto";
import type { Memory, UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { triggerAction } from "../src/actions/trigger.ts";

let harness: Awaited<ReturnType<typeof createTestRuntime>>;
const created: UUID[] = [];

beforeAll(async () => {
  harness = await createTestRuntime({ characterName: "TriggerRunSkipped" });
});
afterEach(async () => {
  for (const taskId of created.splice(0)) {
    await harness.runtime.deleteTask(taskId).catch(() => undefined);
  }
});
afterAll(async () => {
  await harness?.cleanup();
});

function messageFor(text: string): Memory {
  return {
    entityId: harness.runtime.agentId,
    agentId: harness.runtime.agentId,
    roomId: randomUUID() as UUID,
    content: { text },
  } as Memory;
}

async function createIntervalTrigger(displayName: string) {
  const result = await triggerAction.handler(
    harness.runtime,
    messageFor(`Remind me about ${displayName} on an interval.`),
    undefined,
    {
      parameters: {
        action: "create",
        displayName,
        instructions: `Send the ${displayName} reminder.`,
        intervalMs: 3_600_000,
      },
    },
  );
  if (!result?.success) throw new Error(result?.text ?? "create failed");
  const taskId = (result.data as { taskId: UUID }).taskId;
  created.push(taskId);
  return taskId;
}

/**
 * Stage the state prior runs leave behind: each executed run persists
 * runCount + 1, so five past runs leave runCount at 5 on the stored task.
 */
async function stageRunCount(taskId: UUID, runCount: number) {
  const task = await harness.runtime.getTask(taskId);
  if (!task?.metadata) throw new Error("task missing metadata");
  const metadata = structuredClone(task.metadata) as {
    trigger: Record<string, unknown>;
  };
  metadata.trigger.runCount = runCount;
  await harness.runtime.updateTask(taskId, { metadata });
}

it("does not report 'Ran' when the run is skipped at the run cap and the trigger is removed", async () => {
  const taskId = await createIntervalTrigger("Water plants");
  await stageRunCount(taskId, 5);
  const capped = await triggerAction.handler(
    harness.runtime,
    messageFor("Cap it at 5 runs total."),
    undefined,
    { parameters: { action: "update", taskId, maxRuns: 5 } },
  );
  expect(capped, capped?.text).toMatchObject({ success: true });

  const result = await triggerAction.handler(
    harness.runtime,
    messageFor("Run it once more now."),
    undefined,
    { parameters: { action: "run", taskId } },
  );

  // Nothing ran, and the executor removed the trigger: the answer must say
  // the run was skipped instead of claiming it ran.
  expect(result, result?.text).toMatchObject({
    success: false,
    error: "RUN_SKIPPED",
  });
  expect(result?.data).toMatchObject({
    status: "skipped",
    taskDeleted: true,
  });
  expect(Boolean(await harness.runtime.getTask(taskId))).toBe(false);
});
