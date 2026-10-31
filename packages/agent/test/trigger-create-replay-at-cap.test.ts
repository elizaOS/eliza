/**
 * Re-asking for a reminder that already exists is an idempotent replay and
 * answers "Already set — you're covered.". That must stay true at the
 * per-creator trigger cap: the existing reminder counts toward the cap, so
 * a limit check that runs before the replay match answers LIMIT_REACHED
 * for a reminder that exists and will fire.
 */
import { randomUUID } from "node:crypto";
import type { Memory, UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { triggerAction } from "../src/actions/trigger.ts";
import { TRIGGER_TASK_TAGS } from "../src/triggers/runtime.ts";

let harness: Awaited<ReturnType<typeof createTestRuntime>>;
const created: UUID[] = [];
/** One room for every message: the delivery room is part of a trigger's
 * dedupe identity, so the re-ask must come from the same room to replay. */
const roomId = randomUUID() as UUID;

beforeAll(async () => {
  harness = await createTestRuntime({
    characterName: "TriggerCreateReplayAtCap",
  });
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
    roomId,
    content: { text },
  } as Memory;
}

async function createTrigger(parameters: Record<string, unknown>) {
  const result = await triggerAction.handler(
    harness.runtime,
    messageFor("Set that reminder."),
    undefined,
    { parameters: { action: "create", ...parameters } },
  );
  if (!result?.success) throw new Error(result?.text ?? "create failed");
  const taskId = (result.data as { taskId: UUID }).taskId;
  created.push(taskId);
  return taskId;
}

async function triggerTaskCount() {
  const tasks = await harness.runtime.getTasks({
    tags: [...TRIGGER_TASK_TAGS],
    agentIds: [harness.runtime.agentId],
  });
  return tasks.length;
}

it("replays the existing reminder at the trigger cap instead of failing with the limit", async () => {
  const targetTaskId = await createTrigger({
    displayName: "Water plants",
    instructions: "Water the plants.",
    delayMinutes: 60,
  });
  // Fill the creator's remaining slots with unrelated interval reminders
  // so the target plus fillers reach the 100-trigger cap.
  for (let i = 1; i < 100; i += 1) {
    await createTrigger({
      displayName: `Filler ${i}`,
      instructions: `Filler reminder number ${i}.`,
      intervalMs: 3_600_000,
    });
  }
  expect(await triggerTaskCount()).toBe(100);

  const replay = await triggerAction.handler(
    harness.runtime,
    messageFor("Remind me to water the plants in an hour."),
    undefined,
    {
      parameters: {
        action: "create",
        displayName: "Water plants",
        instructions: "Water the plants.",
        delayMinutes: 60,
      },
    },
  );

  // The reminder already exists and will fire, so the answer is the
  // replayed "already set" success, not a limit failure — and the re-ask
  // creates nothing new.
  expect(replay, replay?.text).toMatchObject({
    success: true,
    text: "Already set — you're covered.",
  });
  expect(replay?.data).toMatchObject({ duplicateTaskId: targetTaskId });
  expect(await triggerTaskCount()).toBe(100);
}, 300_000);
