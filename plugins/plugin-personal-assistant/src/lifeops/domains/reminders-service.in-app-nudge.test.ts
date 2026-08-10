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
