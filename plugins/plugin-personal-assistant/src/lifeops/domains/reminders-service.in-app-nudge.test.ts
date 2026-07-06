import { ServiceType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { type RemindersDeps, RemindersDomain } from "./reminders-service.js";

class TestRemindersDomain extends RemindersDomain {
  emitTestNudge(
    args: Parameters<RemindersDomain["emitInAppReminderNudge"]>[0],
  ) {
    this.emitInAppReminderNudge(args);
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
  it("emits a chat-visible reminder with choice chips while keeping the interrupt notification deep-linked to chat", () => {
    const emitAssistantEvent = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const domain = new TestRemindersDomain(
      {
        emitAssistantEvent,
        runtime: {
          getService(serviceType: unknown) {
            return serviceType === ServiceType.NOTIFICATION ? { notify } : null;
          },
        },
      } as never,
      makeDeps(),
    );

    domain.emitTestNudge({
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
        title: "Reminder",
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
