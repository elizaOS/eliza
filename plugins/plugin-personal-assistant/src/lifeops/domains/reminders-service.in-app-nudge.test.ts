import { ServiceType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { type RemindersDeps, RemindersDomain } from "./reminders-service.js";

class TestRemindersDomain extends RemindersDomain {
  async emitTestNudge(
    args: Parameters<RemindersDomain["emitInAppReminderNudge"]>[0],
  ) {
    await this.emitInAppReminderNudge(args);
  }
}

function makeDeps(): RemindersDeps {
  return {
    runDueWorkflows: vi.fn(),
    runDueEventWorkflows: vi.fn(),
    snoozeOccurrence: vi.fn(),
    checkinSource: {} as RemindersDeps["checkinSource"],
  };
}

describe("RemindersDomain.emitInAppReminderNudge", () => {
  it("voices the notification title while keeping the interrupt deep-linked to chat", async () => {
    const emitAssistantEvent = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const domain = new TestRemindersDomain(
      {
        emitAssistantEvent,
        runtime: {
          agentId: "agent-test",
          useModel: vi.fn(async () => "Medication time"),
          reportError: vi.fn(),
          getService(serviceType: unknown) {
            return serviceType === ServiceType.NOTIFICATION ? { notify } : null;
          },
        },
      } as never,
      makeDeps(),
    );

    await domain.emitTestNudge({
      text: "Take your meds.",
      ownerType: "occurrence",
      ownerId: "occurrence-1",
      subjectType: "owner",
      scheduledFor: "2026-07-06T12:00:00.000Z",
      dueAt: "2026-07-06T12:00:00.000Z",
    });

    expect(emitAssistantEvent).toHaveBeenCalledWith(
      expect.stringContaining("Take your meds.\n\n[CHOICE:lifeops-reminder"),
      "reminder",
      expect.objectContaining({
        ownerType: "occurrence",
        ownerId: "occurrence-1",
        subjectType: "owner",
        scheduledFor: "2026-07-06T12:00:00.000Z",
        dueAt: "2026-07-06T12:00:00.000Z",
      }),
    );
    const chatText = emitAssistantEvent.mock.calls[0]?.[0] as string;
    expect(chatText).toContain("done=Done");
    expect(chatText).toContain("10 minutes=Snooze 10m");
    expect(chatText).toContain("skip=Skip");

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Medication time",
        body: "Take your meds.",
        category: "reminder",
        source: "lifeops",
        deepLink: "/chat",
        groupKey: "reminder:occurrence:occurrence-1",
        data: expect.objectContaining({
          ownerType: "occurrence",
          ownerId: "occurrence-1",
          subjectType: "owner",
        }),
      }),
    );
    expect(notify.mock.calls[0]?.[0].body).not.toContain("[CHOICE");
  });
});

it.each([true, false])(
  "renders only an admitted in-app reminder (sleeping=%s)",
  async (sleeping) => {
    const createReminderAttempt = vi.fn(async () => undefined);
    const runtime = {
      sendMessageToTarget: vi.fn(async () => {
        throw new Error("No external dispatch expected");
      }),
      useModel: vi.fn(async () => "Reminder body"),
      reportError: vi.fn(),
    };
    const domain = new RemindersDomain(
      {
        agentId: () => "agent",
        runtime,
        repository: { createReminderAttempt },
      } as never,
      makeDeps(),
    );
    const audit = vi
      .spyOn(domain, "recordReminderAudit")
      .mockResolvedValue(undefined);
    vi.spyOn(domain, "renderReminderBody").mockImplementation(async () =>
      runtime.useModel(),
    );
    const emit = vi
      .spyOn(domain, "emitInAppReminderNudge")
      .mockResolvedValue(undefined);
    const attempt = await domain.dispatchReminderAttempt({
      plan: { id: "plan" } as never,
      ownerType: "occurrence",
      ownerId: "occurrence",
      occurrenceId: "occurrence",
      subjectType: "owner",
      title: "Reminder",
      channel: "in_app",
      stepIndex: 0,
      scheduledFor: "2026-09-28T19:04:00Z",
      dueAt: "2026-09-28T19:04:00Z",
      urgency: "medium",
      quietHours: {},
      acknowledged: false,
      attemptedAt: "2026-09-28T19:04:01Z",
      activityProfile: {
        circadianState: sleeping ? "sleeping" : "awake",
        stateConfidence: 0.99,
      } as never,
      timezone: "UTC",
      definition: null,
    });
    expect(attempt.outcome).toBe(
      sleeping ? "blocked_quiet_hours" : "delivered",
    );
    expect(runtime.useModel).toHaveBeenCalledTimes(sleeping ? 0 : 1);
    expect(createReminderAttempt).toHaveBeenCalledWith(attempt);
    expect(audit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledTimes(sleeping ? 0 : 1);
    expect(runtime.sendMessageToTarget).not.toHaveBeenCalled();
  },
);

it("keeps Calendar reminder choices on the generic legacy acknowledgment path", async () => {
  const emitAssistantEvent = vi.fn();
  const domain = new TestRemindersDomain(
    {
      emitAssistantEvent,
      runtime: { getService: () => null },
    } as never,
    makeDeps(),
  );
  await domain.emitTestNudge({
    text: "Meeting soon.",
    ownerType: "calendar_event",
    ownerId: "event-1",
    subjectType: "owner",
    scheduledFor: "2026-10-03T02:00:00Z",
    dueAt: "2026-10-03T02:10:00Z",
  });
  const text = emitAssistantEvent.mock.calls[0]?.[0] as string;
  expect(text).toContain("[CHOICE:lifeops-calendar-reminder id=reminder-");
  expect(text).not.toContain("[CHOICE:lifeops-reminder ");
  expect(text).toContain("done=Done");
  expect(text).toContain("skip=Skip");
});
