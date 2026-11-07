import { randomUUID } from "node:crypto";
import type { Memory, UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { triggerAction } from "../src/actions/trigger.ts";

let harness: Awaited<ReturnType<typeof createTestRuntime>>;
const created: UUID[] = [];

beforeAll(async () => {
  harness = await createTestRuntime({ characterName: "TriggerNameResolution" });
});
afterEach(async () => {
  for (const taskId of created.splice(0)) {
    await harness.runtime.deleteTask(taskId);
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

async function createTrigger(displayName: string, hour: number) {
  const result = await triggerAction.handler(
    harness.runtime,
    messageFor(`Remind me every day about ${displayName}.`),
    undefined,
    {
      parameters: {
        action: "create",
        displayName,
        instructions: `Send the daily reminder (${hour}).`,
        cronExpression: `0 ${hour} * * *`,
      },
    },
  );
  if (!result?.success) throw new Error(result?.text ?? "create failed");
  const taskId = (result.data as { taskId: UUID }).taskId;
  created.push(taskId);
  return taskId;
}

function deleteTrigger(parameters: Record<string, unknown>) {
  return triggerAction.handler(
    harness.runtime,
    messageFor("Delete that reminder."),
    undefined,
    { parameters: { action: "delete", ...parameters } },
  );
}

async function exists(taskId: UUID) {
  return Boolean(await harness.runtime.getTask(taskId));
}

it("deletes the trigger whose name is exactly the target when a longer name also contains it", async () => {
  const standup = await createTrigger("Standup", 9);
  const standupNotes = await createTrigger("Standup notes", 10);
  const result = await deleteTrigger({ displayName: "Standup" });
  expect(result, result?.text).toMatchObject({ success: true });
  expect(await exists(standup)).toBe(false);
  expect(await exists(standupNotes)).toBe(true);
});

it("resolves a whole word of a longer name", async () => {
  const standup = await createTrigger("Standup", 9);
  const standupNotes = await createTrigger("Standup notes", 10);
  const result = await deleteTrigger({ displayName: "notes" });
  expect(result, result?.text).toMatchObject({ success: true });
  expect(await exists(standupNotes)).toBe(false);
  expect(await exists(standup)).toBe(true);
});

it("does not resolve a trigger whose name is only part of a word in the target", async () => {
  const gym = await createTrigger("Gym", 7);
  const result = await deleteTrigger({ displayName: "Gymnastics class" });
  expect(result).toMatchObject({ success: false, error: "TRIGGER_NOT_FOUND" });
  expect(await exists(gym)).toBe(true);
});

it("refuses a taskId whose name is only part of a word in the stated name", async () => {
  const gym = await createTrigger("Gym", 7);
  const result = await deleteTrigger({
    taskId: gym,
    displayName: "Gymnastics class",
  });
  expect(result).toMatchObject({
    success: false,
    error: "TRIGGER_REF_MISMATCH",
  });
  expect(await exists(gym)).toBe(true);
});

it("resolves a Korean trigger name followed by a particle", async () => {
  const workout = await createTrigger("운동", 6);
  const result = await deleteTrigger({ displayName: "운동을" });
  expect(result, result?.text).toMatchObject({ success: true });
  expect(await exists(workout)).toBe(false);
});
