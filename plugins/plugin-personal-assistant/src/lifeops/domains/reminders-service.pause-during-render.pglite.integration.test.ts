/**
 * A reminder body is rendered by a model call before it is sent. When the
 * owner pauses the reminder during that call, nothing is sent.
 */
import { TaskService } from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createLifeOpsTestRuntime,
  getRecordedTestNotifications,
} from "../../../test/helpers/runtime.ts";
import { LifeOpsService } from "../service.ts";

beforeEach(() => {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(12, 0, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
});
afterEach(() => vi.useRealTimers());

it("does not send a reminder the owner paused while its text was generated", async () => {
  const fixture = await createLifeOpsTestRuntime();
  await TaskService.stop(fixture.runtime);
  try {
    vi.setSystemTime(Date.now() + 1);
    const service = new LifeOpsService(fixture.runtime);
    await service.captureManualOverride({
      kind: "just_woke_up",
      occurredAt: new Date().toISOString(),
    });
    const dueAt = Date.now() + 1000;
    const record = await service.createDefinition({
      title: "Take vitamins",
      kind: "habit",
      cadence: {
        kind: "once",
        dueAt: new Date(dueAt).toISOString(),
        visibilityLeadMinutes: 0,
      },
      timezone: "UTC",
      priority: 3,
      metadata: {},
      reminderPlan: {
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
      },
    });
    let paused = false;
    vi.spyOn(fixture.runtime, "useModel").mockImplementation(
      async (_type: unknown, params: unknown) => {
        const prompt = String((params as { prompt?: unknown })?.prompt ?? "");
        if (!paused && /remind/i.test(prompt)) {
          paused = true;
          await service.updateDefinition(record.definition.id, {
            status: "paused",
          } as never);
        }
        return "Time to take your vitamins.";
      },
    );

    await service.processReminders({
      now: new Date(dueAt).toISOString(),
      scope: "definitions",
    });

    expect(paused).toBe(true);
    const attempts = await service.repository.listReminderAttempts(
      fixture.runtime.agentId,
    );
    expect(
      attempts.map((attempt) => [
        attempt.outcome,
        attempt.deliveryMetadata.reason ?? null,
      ]),
    ).toEqual([["blocked_policy", "definition_inactive"]]);
    expect(getRecordedTestNotifications(fixture.runtime)).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
}, 180_000);
