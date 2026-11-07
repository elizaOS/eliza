import { randomUUID } from "node:crypto";
import type { Memory, UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import { triggerAction } from "../src/actions/trigger.ts";
import { zonedIsoTimestamp } from "../src/triggers/humanize.ts";
import { readTriggerConfig } from "../src/triggers/runtime.ts";

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
  fixture = await createTestRuntime({ characterName: "TriggerResultZone" });
});
afterAll(async () => {
  await fixture?.cleanup();
});

it("writes an instant with the zone's own offset", () => {
  const live = "2026-10-30T12:57:29.656Z";
  expect(zonedIsoTimestamp(live, "America/Los_Angeles")).toBe(
    "2026-10-30T05:57:29.656-07:00",
  );
  expect(zonedIsoTimestamp(live, "Asia/Kolkata")).toBe(
    "2026-10-30T18:27:29.656+05:30",
  );
  expect(zonedIsoTimestamp(live, "UTC")).toBe("2026-10-30T12:57:29.656+00:00");
  expect(zonedIsoTimestamp("not a time", "UTC")).toBe("not a time");
});

// Live tj-751d37123e42ae: "remind me to take out the trash in 2 hours" at
// 3:57am PDT. The tool text said "today at 5:57am", but the result data carried
// scheduledAtIso "2026-10-30T12:57:29.656Z" and the reply said "12:57pm today".
it("returns create and update fire times in the sender's zone and stores the instant unchanged", async () => {
  const message = {
    entityId: fixture.runtime.agentId,
    agentId: fixture.runtime.agentId,
    roomId: randomUUID() as UUID,
    content: {
      text: "remind me to take out the trash in 2 hours",
      metadata: { uiTimeZone: "Asia/Kolkata" },
    },
  } as Memory;
  const created = await triggerAction.handler(
    fixture.runtime,
    message,
    undefined,
    {
      parameters: {
        action: "create",
        instructions: `Remind the user to take out the trash ${randomUUID()}`,
        delayMinutes: 120,
      },
    },
  );
  if (!created?.success) throw new Error(created?.text ?? "create failed");
  const { taskId, scheduledAtIso } = created.data as {
    taskId: UUID;
    scheduledAtIso: string;
  };
  try {
    expect(scheduledAtIso).toMatch(/\+05:30$/);
    const task = await fixture.runtime.getTask(taskId);
    const stored = task ? readTriggerConfig(task) : null;
    expect(stored?.scheduledAtIso).toMatch(/Z$/);
    expect(Date.parse(scheduledAtIso)).toBe(
      Date.parse(stored?.scheduledAtIso ?? ""),
    );

    const moved = await triggerAction.handler(
      fixture.runtime,
      message,
      undefined,
      {
        parameters: {
          action: "update",
          taskId,
          scheduledAtIso: "2099-01-17T09:00:00-08:00",
        },
      },
    );
    expect(moved, moved?.text).toMatchObject({
      success: true,
      data: { scheduledAtIso: "2099-01-17T22:30:00.000+05:30" },
    });
  } finally {
    await fixture.runtime.deleteTask(taskId);
  }
});
