/** Real saved plans, delivered/read receipts and >120 minutes of processing.
 * Reading never acknowledges/completes the occurrence. No live model calls. */
import { randomUUID } from "node:crypto";
import { ChannelType, TaskService, type UUID } from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createLifeOpsTestRuntime as createBaseLifeOpsTestRuntime,
  getRecordedTestNotifications,
} from "../../test/helpers/runtime.js";
import { createLifeOpsReminderAttempt } from "./repository.js";
import { LifeOpsService } from "./service.js";
import {
  hasExplicitReminderEscalationProfile,
  resolveReminderEscalationDelayMinutes,
} from "./service-helpers-reminder.js";

beforeEach(() => {
  const daytime = new Date();
  daytime.setDate(daytime.getDate() + 1);
  daytime.setHours(12, 0, 0, 0);
  // Keep schedule state captured at boot aligned with the virtual delivery day.
  // Only Date is frozen; database I/O and timeout timers remain real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(daytime);
});
afterEach(() => vi.useRealTimers());

async function createLifeOpsTestRuntime() {
  const fixture = await createBaseLifeOpsTestRuntime();
  // Each case drives processReminders explicitly, without competing real ticks.
  await TaskService.stop(fixture.runtime);
  // A clock alone is not evidence of wakefulness. Persist the owner's awake
  // signal through the real admission path for this delivery scenario.
  vi.setSystemTime(Date.now() + 1);
  const awake = await new LifeOpsService(fixture.runtime).captureManualOverride(
    {
      kind: "just_woke_up",
      occurredAt: new Date().toISOString(),
    },
  );
  expect(awake.circadianState).toBe("awake");
  return fixture;
}

it.each([
  undefined,
  {},
  { unknown: true },
  { activeWindowOnly: "true", delayCompression: { factor: "fast" } },
])(
  "default one-shot has exactly one attempt through120minutes without acknowledgement: %j",
  async (profile) => {
    const f = await createLifeOpsTestRuntime();
    const model = vi
      .spyOn(f.runtime, "useModel")
      .mockRejectedValue(Error("No inference expected"));
    try {
      const service = new LifeOpsService(f.runtime);
      const due = Date.now() + 1000;
      const record = await service.createDefinition({
        title: "Check the in-app notification",
        kind: "habit",
        cadence: {
          kind: "once",
          dueAt: new Date(due).toISOString(),
          visibilityLeadMinutes: 0,
        },
        timezone: "UTC",
        priority: 3,
        metadata: {
          ownerSurface: "OWNER_REMINDERS",
          nativeProjection: "in_app_only",
          ...(profile !== undefined
            ? { reminderEscalationProfile: profile }
            : {}),
        },
        reminderPlan: {
          steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
        },
      });
      const preference = await service.getReminderPreference(
        record.definition.id,
      );
      expect(preference.effective).toMatchObject({
        intensity: "normal",
        source: "default",
      });
      await service.processReminders({
        now: new Date(due).toISOString(),
        scope: "definitions",
      });
      let attempts = await service.repository.listReminderAttempts(
        f.runtime.agentId,
      );
      expect(attempts).toHaveLength(1);
      await service.remindersDomain.scanReadReceipts(
        attempts,
        { lastSeenAt: due + 1 } as never,
        new Date(due + 1),
      );
      expect(attempts[0].outcome).toBe("delivered_read");
      const occurrenceId = attempts[0].ownerId;
      const before = await service.repository.getOccurrence(
        f.runtime.agentId,
        occurrenceId,
      );
      const body = getRecordedTestNotifications(f.runtime)[0].body;
      expect(body).toBe("Check the in-app notification");
      expect(getRecordedTestNotifications(f.runtime)[0].title).toBe("Reminder");
      expect(attempts[0].deliveryMetadata.message).toBe(body);
      expect(before?.dueAt).toBe(new Date(due).toISOString());
      expect(attempts[0].scheduledFor).toBe(new Date(due).toISOString());
      expect(
        (await service.listReminders()).find(
          (item) => item.definition.id === record.definition.id,
        )?.occurrence?.dueAt,
      ).toBe(before?.dueAt);
      expect(body).not.toContain("Monday");
      for (const minutes of [30, 54, 55, 90, 121])
        await service.processReminders({
          now: new Date(due + minutes * 60000).toISOString(),
          scope: "definitions",
        });
      attempts = await service.repository.listReminderAttempts(
        f.runtime.agentId,
      );
      expect(attempts).toHaveLength(1);
      expect(getRecordedTestNotifications(f.runtime)).toHaveLength(1);
      expect(getRecordedTestNotifications(f.runtime)[0].body).toBe(body);
      const after = await service.repository.getOccurrence(
        f.runtime.agentId,
        occurrenceId,
      );
      expect(after?.state).toBe(before?.state);
      expect(after?.metadata.reminderAcknowledgedAt).toBeUndefined();
      expect(after?.state).not.toBe("completed");
      expect(model).not.toHaveBeenCalled();
      expect(
        resolveReminderEscalationDelayMinutes(
          "medium",
          "delivered_read",
          false,
        ),
      ).toBe(54);
    } finally {
      model.mockRestore();
      await f.cleanup();
    }
  },
  120000,
);

it("explicit post-fire snooze crosses the original window and preserves its saved deadline without default escalation", async () => {
  const f = await createLifeOpsTestRuntime();
  const model = vi
    .spyOn(f.runtime, "useModel")
    .mockRejectedValue(Error("No inference"));
  try {
    let service = new LifeOpsService(f.runtime);
    const due = Date.now() + 1000;
    const record = await service.createDefinition({
      title: "Explicit snooze deadline",
      kind: "habit",
      cadence: {
        kind: "once",
        dueAt: new Date(due).toISOString(),
        visibilityLeadMinutes: 0,
        visibilityLagMinutes: 1,
      },
      timezone: "UTC",
      priority: 3,
      metadata: {
        ownerSurface: "OWNER_REMINDERS",
        nativeProjection: "in_app_only",
      },
      reminderPlan: {
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
      },
    });
    if (!record.reminderPlan) throw Error("Missing saved reminder plan");
    await service.processReminders({
      now: new Date(due).toISOString(),
      scope: "definitions",
    });
    const firstAttempts = await service.repository.listReminderAttempts(
      f.runtime.agentId,
    );
    expect(firstAttempts).toHaveLength(1);
    await service.remindersDomain.scanReadReceipts(
      firstAttempts,
      { lastSeenAt: due + 1 } as never,
      new Date(due + 1),
    );
    const [firstReceipt] = await service.repository.listReminderAttempts(
      f.runtime.agentId,
    );
    const firstSnapshot = structuredClone(firstReceipt);
    expect(firstReceipt.outcome).toBe("delivered_read");
    const original = await service.repository.getOccurrence(
      f.runtime.agentId,
      firstReceipt.ownerId,
    );
    if (!original) throw Error("Missing original occurrence");
    const firstBody = getRecordedTestNotifications(f.runtime)[0].body;
    expect(firstBody).toBe("Explicit snooze deadline");
    const snoozed = await service.snoozeOccurrence(
      original.id,
      { minutes: 10 },
      new Date(due + 2000),
    );
    if (!snoozed.snoozedUntil) throw Error("Missing committed snooze deadline");
    const newDue = Date.parse(snoozed.snoozedUntil);
    expect(newDue).toBe(due + 602000);
    expect(snoozed).toMatchObject({
      id: original.id,
      definitionId: record.definition.id,
      occurrenceKey: original.occurrenceKey,
      dueAt: original.dueAt,
    });
    expect(snoozed.metadata.reminderAcknowledgedAt).toBeUndefined();
    service = new LifeOpsService(f.runtime);
    await service.processReminders({
      now: new Date(newDue - 1).toISOString(),
      scope: "definitions",
    });
    expect(getRecordedTestNotifications(f.runtime)).toHaveLength(1);
    await service.processReminders({
      now: new Date(newDue).toISOString(),
      scope: "definitions",
    });
    const notifications = getRecordedTestNotifications(f.runtime);
    expect(notifications).toHaveLength(2);
    expect(notifications[1].body).toBe("Explicit snooze deadline");
    expect(notifications[1].body).toBe(firstBody);
    expect(notifications[1].title).toBe("Reminder");
    const atDeadline = await service.repository.getOccurrence(
      f.runtime.agentId,
      original.id,
    );
    expect(atDeadline).toMatchObject({
      id: original.id,
      occurrenceKey: original.occurrenceKey,
      dueAt: original.dueAt,
      relevanceStartAt: original.relevanceStartAt,
      relevanceEndAt: new Date(newDue + 60000).toISOString(),
      state: "visible",
    });
    for (const minutes of [0, 30, 54, 55, 90, 121])
      await service.processReminders({
        now: new Date(newDue + minutes * 60000).toISOString(),
        scope: "definitions",
      });
    const attempts = await service.repository.listReminderAttempts(
      f.runtime.agentId,
    );
    expect(attempts).toHaveLength(2);
    expect(attempts.find((a) => a.id === firstReceipt.id)).toEqual(
      firstSnapshot,
    );
    expect(attempts[1]).toMatchObject({
      planId: record.reminderPlan.id,
      ownerId: original.id,
      scheduledFor: snoozed.snoozedUntil,
    });
    expect(attempts[1].scheduledFor).not.toBe(firstReceipt.scheduledFor);
    expect(attempts.every((a) => a.deliveryMetadata.lifecycle === "plan")).toBe(
      true,
    );
    expect(getRecordedTestNotifications(f.runtime)).toHaveLength(2);
    expect(
      await service.repository.listOccurrencesForDefinition(
        f.runtime.agentId,
        record.definition.id,
      ),
    ).toHaveLength(1);
    expect(
      (await service.repository.getOccurrence(f.runtime.agentId, original.id))
        ?.metadata.reminderAcknowledgedAt,
    ).toBeUndefined();
    await expect(
      service.snoozeOccurrence(
        original.id,
        { minutes: 10 },
        new Date(newDue + 121 * 60000),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(model).not.toHaveBeenCalled();
    process.stdout.write(
      `INDEPENDENT_POST_FIRE_SNOOZE_EVIDENCE ${JSON.stringify({ definitionId: record.definition.id, planId: record.reminderPlan.id, occurrenceId: original.id, originalDue: original.dueAt, snoozedUntil: snoozed.snoozedUntil, firstBody, secondBody: notifications[1].body, attempts: attempts.map((a) => ({ id: a.id, scheduledFor: a.scheduledFor, outcome: a.outcome, lifecycle: a.deliveryMetadata.lifecycle })), notifications: notifications.length, throughMinutes: 121, modelCalls: model.mock.calls.length })}\n`,
    );
  } finally {
    model.mockRestore();
    await f.cleanup();
  }
}, 120000);

it.each(["planned", "definition-persistent", "global-persistent"])(
  "preserves explicit follow-up plan %s without converting read to completion",
  async (mode) => {
    const f = await createLifeOpsTestRuntime();
    const model = vi
      .spyOn(f.runtime, "useModel")
      .mockRejectedValue(Error("Planned in-app delivery needs no inference"));
    try {
      const service = new LifeOpsService(f.runtime);
      const due = Date.now() + 1000;
      const record = await service.createDefinition({
        title: "Configured follow-up",
        kind: "habit",
        cadence: {
          kind: "once",
          dueAt: new Date(due).toISOString(),
          visibilityLeadMinutes: 0,
        },
        timezone: "UTC",
        metadata: {
          ownerSurface: "OWNER_REMINDERS",
          nativeProjection: "in_app_only",
        },
        reminderPlan: {
          steps: [
            { channel: "in_app", offsetMinutes: 0, label: "First" },
            ...(mode === "planned"
              ? [
                  {
                    channel: "in_app" as const,
                    offsetMinutes: 60,
                    label: "Explicit follow-up",
                  },
                ]
              : []),
          ],
        },
      });
      if (mode !== "planned")
        await service.setReminderPreference({
          intensity: "persistent",
          ...(mode === "definition-persistent"
            ? { definitionId: record.definition.id }
            : {}),
        });
      await service.processReminders({
        now: new Date(due).toISOString(),
        scope: "definitions",
      });
      await service.processReminders({
        now: new Date(due + 60 * 60000).toISOString(),
        scope: "definitions",
      });
      const attempts = await service.repository.listReminderAttempts(
        f.runtime.agentId,
      );
      expect(
        attempts.filter((a) => a.deliveryMetadata.lifecycle === "plan"),
      ).toHaveLength(2);
      expect(getRecordedTestNotifications(f.runtime)).toHaveLength(2);
      if (mode === "planned") {
        await service.processReminders({
          now: new Date(due + 181 * 60000).toISOString(),
          scope: "definitions",
        });
        expect(
          await service.repository.listReminderAttempts(f.runtime.agentId),
        ).toHaveLength(2);
      }
      expect(model).not.toHaveBeenCalled();
    } finally {
      model.mockRestore();
      await f.cleanup();
    }
  },
  120000,
);

it("preserves a valid explicit escalation profile after the one-shot plan", async () => {
  const f = await createLifeOpsTestRuntime();
  const model = vi
    .spyOn(f.runtime, "useModel")
    .mockResolvedValue("Configured reminder follow-up.");
  try {
    const service = new LifeOpsService(f.runtime);
    const due = Date.now() + 1000;
    const profile = {
      activeWindowOnly: false,
      requireRoutineDefinition: false,
      delayCompression: null,
      forceChannel: null,
    };
    const record = await service.createDefinition({
      title: "Explicit escalation",
      kind: "habit",
      cadence: {
        kind: "once",
        dueAt: new Date(due).toISOString(),
        visibilityLeadMinutes: 0,
      },
      timezone: "UTC",
      metadata: {
        ownerSurface: "OWNER_REMINDERS",
        nativeProjection: "in_app_only",
        reminderEscalationProfile: profile,
      },
      reminderPlan: {
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
      },
    });
    expect(hasExplicitReminderEscalationProfile(record.definition)).toBe(true);
    await service.processReminders({
      now: new Date(due).toISOString(),
      scope: "definitions",
    });
    await service.processReminders({
      now: new Date(due + 91 * 60000).toISOString(),
      scope: "definitions",
    });
    const attempts = await service.repository.listReminderAttempts(
      f.runtime.agentId,
    );
    expect(
      attempts.some((a) => a.deliveryMetadata.lifecycle === "escalation"),
    ).toBe(true);
    expect(model).toHaveBeenCalled();
  } finally {
    model.mockRestore();
    await f.cleanup();
  }
}, 120000);

it.each(["non-reminder", "recurring"])(
  "keeps existing automatic escalation outside the one-shot owner-reminder scope: %s",
  async (mode) => {
    const f = await createLifeOpsTestRuntime();
    const model = vi
      .spyOn(f.runtime, "useModel")
      .mockResolvedValue("Existing follow-up behavior.");
    try {
      const service = new LifeOpsService(f.runtime);
      const due = Date.now() + 1000;
      await service.createDefinition({
        title: "Existing behavior",
        kind: "habit",
        cadence:
          mode === "recurring"
            ? { kind: "daily", windows: ["morning"] }
            : {
                kind: "once",
                dueAt: new Date(due).toISOString(),
                visibilityLeadMinutes: 0,
              },
        timezone: "UTC",
        ...(mode === "recurring"
          ? {
              windowPolicy: {
                timezone: "UTC",
                windows: [
                  {
                    name: "morning" as const,
                    label: "All-day fixture",
                    startMinute: 0,
                    endMinute: 1440,
                  },
                ],
              },
            }
          : {}),
        metadata: {
          ownerSurface:
            mode === "non-reminder" ? "OWNER_TODOS" : "OWNER_REMINDERS",
          nativeProjection: "in_app_only",
        },
        reminderPlan: {
          steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
        },
      });
      await service.processReminders({
        now: new Date(due).toISOString(),
        scope: "definitions",
      });
      await service.processReminders({
        now: new Date(due + 91 * 60000).toISOString(),
        scope: "definitions",
      });
      const attempts = await service.repository.listReminderAttempts(
        f.runtime.agentId,
      );
      expect(
        attempts.some((a) => a.deliveryMetadata.lifecycle === "escalation"),
      ).toBe(true);
    } finally {
      model.mockRestore();
      await f.cleanup();
    }
  },
  120000,
);

it.each(["retry", "escalation-impostor", "wrong-plan-impostor"])(
  "failed planned delivery remains eligible and cannot be satisfied by unrelated receipt: %s",
  async (mode) => {
    const f = await createLifeOpsTestRuntime();
    const model = vi
      .spyOn(f.runtime, "useModel")
      .mockResolvedValue("Existing retry path.");
    try {
      const service = new LifeOpsService(f.runtime),
        due = Date.now() + 1000;
      const record = await service.createDefinition({
        title: "Failed planned delivery",
        kind: "habit",
        cadence: {
          kind: "once",
          dueAt: new Date(due).toISOString(),
          visibilityLeadMinutes: 0,
        },
        timezone: "UTC",
        metadata: {
          ownerSurface: "OWNER_REMINDERS",
          nativeProjection: "in_app_only",
        },
        reminderPlan: {
          steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
        },
      });
      if (!record.reminderPlan) throw Error("Missing saved plan");
      const occurrence = (
        await service.repository.listOccurrencesForDefinition(
          f.runtime.agentId,
          record.definition.id,
        )
      )[0];
      const args = {
        plan: record.reminderPlan,
        ownerType: "occurrence" as const,
        ownerId: occurrence.id,
        occurrenceId: occurrence.id,
        subjectType: "owner" as const,
        title: record.definition.title,
        channel: "in_app" as const,
        stepIndex: 0,
        scheduledFor: new Date(due).toISOString(),
        dueAt: new Date(due).toISOString(),
        urgency: "medium" as const,
        quietHours: {},
        acknowledged: false,
        attemptedAt: new Date(due).toISOString(),
        timezone: "UTC",
        definition: record.definition,
      };
      const failed = await service.remindersDomain.dispatchReminderAttempt({
        ...args,
        activityProfile: {
          circadianState: "sleeping",
          stateConfidence: 1,
        } as never,
      });
      expect(failed.outcome).toBe("blocked_quiet_hours");
      if (mode === "retry") {
        await service.processReminders({
          now: new Date(due + 30000).toISOString(),
          scope: "definitions",
        });
        const attempts = await service.repository.listReminderAttempts(
          f.runtime.agentId,
        );
        expect(attempts).toHaveLength(2);
        expect(
          attempts.some(
            (a) =>
              a.deliveryMetadata.lifecycle === "plan" &&
              a.outcome.startsWith("delivered"),
          ),
        ).toBe(true);
        expect(getRecordedTestNotifications(f.runtime)).toHaveLength(1);
        expect(model).not.toHaveBeenCalled();
      } else {
        const impostor = createLifeOpsReminderAttempt({
          ...failed,
          planId:
            mode === "wrong-plan-impostor" ? "unrelated-plan" : failed.planId,
          outcome: "delivered_read",
          deliveryMetadata: {
            ...failed.deliveryMetadata,
            lifecycle: mode === "escalation-impostor" ? "escalation" : "plan",
          },
        });
        const channels = vi.spyOn(
          service.remindersDomain,
          "resolveReminderEscalationChannels",
        );
        await service.remindersDomain.dispatchDueReminderEscalation({
          ...args,
          now: new Date(due + 241 * 60000),
          attemptedAt: new Date(due + 241 * 60000).toISOString(),
          intensity: "normal",
          intensitySource: "default",
          attempts: [failed, impostor],
          occurrence,
          policies: [],
          activityProfile: null,
        });
        expect(channels).toHaveBeenCalledOnce();
        channels.mockRestore();
      }
    } finally {
      model.mockRestore();
      await f.cleanup();
    }
  },
  120000,
);

it.each([1, 2])(
  "closes a priority %s one-shot review without acknowledging the occurrence",
  async (priority) => {
    const f = await createLifeOpsTestRuntime();
    const model = vi
      .spyOn(f.runtime, "useModel")
      .mockRejectedValue(Error("No inference expected"));
    try {
      const service = new LifeOpsService(f.runtime);
      const due = Date.now() + 1000;
      await service.createDefinition({
        title: "One-shot review lifecycle",
        kind: "habit",
        priority,
        cadence: {
          kind: "once",
          dueAt: new Date(due).toISOString(),
          visibilityLeadMinutes: 0,
        },
        timezone: "UTC",
        metadata: {
          ownerSurface: "OWNER_REMINDERS",
          nativeProjection: "in_app_only",
        },
        reminderPlan: {
          steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
        },
      });
      await service.processReminders({
        now: new Date(due).toISOString(),
        scope: "definitions",
      });
      const [delivered] = await service.repository.listReminderAttempts(
        f.runtime.agentId,
      );
      expect(delivered.outcome).toBe("delivered");
      expect(delivered.reviewAt).toBeTruthy();
      if (!delivered.reviewAt) throw Error("Missing persisted review deadline");
      const reviewTime = Date.parse(delivered.reviewAt);
      await service.processReminders({
        now: new Date(reviewTime).toISOString(),
        scope: "definitions",
      });
      const [reviewed] = await service.repository.listReminderAttempts(
        f.runtime.agentId,
      );
      expect(reviewed.reviewStatus).toBe("resolved");
      expect(reviewed.deliveryMetadata.reminderReviewDecision).toBe(
        "no_response",
      );
      expect(
        await service.repository.claimDueReminderReviewAttempts(
          f.runtime.agentId,
          new Date(reviewTime + 6 * 60000).toISOString(),
          10,
        ),
      ).toEqual([]);
      const occurrence = await service.repository.getOccurrence(
        f.runtime.agentId,
        delivered.ownerId,
      );
      expect(occurrence?.metadata.reminderAcknowledgedAt).toBeUndefined();
      expect(occurrence?.state).not.toBe("completed");
      expect(getRecordedTestNotifications(f.runtime)).toHaveLength(1);
      expect(model).not.toHaveBeenCalled();
    } finally {
      model.mockRestore();
      await f.cleanup();
    }
  },
  120000,
);

it("processes a persisted owner snooze reply after the one-shot delivery", async () => {
  const f = await createLifeOpsTestRuntime();
  const model = vi
    .spyOn(f.runtime, "useModel")
    .mockRejectedValue(Error("Explicit snooze needs no inference"));
  try {
    const ownerId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    f.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", ownerId, false);
    await f.runtime.ensureConnection({
      entityId: ownerId,
      roomId,
      worldId: randomUUID() as UUID,
      worldName: "Reminder review",
      userName: "Owner",
      name: "Owner",
      source: "test",
      type: ChannelType.DM,
      channelId: roomId,
    });
    await f.runtime.ensureParticipantInRoom(f.runtime.agentId, roomId);
    await f.runtime.ensureParticipantInRoom(ownerId, roomId);
    const service = new LifeOpsService(f.runtime, { ownerEntityId: ownerId });
    const due = Date.now() + 1000;
    await service.createDefinition({
      title: "Review notebook",
      kind: "habit",
      priority: 2,
      cadence: {
        kind: "once",
        dueAt: new Date(due).toISOString(),
        visibilityLeadMinutes: 0,
        visibilityLagMinutes: 120,
      },
      timezone: "UTC",
      metadata: {
        ownerSurface: "OWNER_REMINDERS",
        nativeProjection: "in_app_only",
      },
      reminderPlan: {
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
      },
    });
    await service.processReminders({
      now: new Date(due).toISOString(),
      scope: "definitions",
    });
    const [delivered] = await service.repository.listReminderAttempts(
      f.runtime.agentId,
    );
    expect(delivered.outcome).toBe("delivered");
    // Bind the transport receipt to the conversation where the owner replies.
    await service.repository.updateReminderAttemptOutcome(
      delivered.id,
      delivered.outcome,
      { deliveryRoomId: roomId },
    );
    delivered.deliveryMetadata.deliveryRoomId = roomId;
    const repliedAt = due + 6 * 60000;
    await f.runtime.createMemory(
      {
        id: randomUUID() as UUID,
        agentId: f.runtime.agentId,
        entityId: ownerId,
        roomId,
        createdAt: repliedAt,
        content: { text: "30 minutes" },
      },
      "messages",
    );
    expect(
      await service.reviewOwnerResponseAfterReminderAttempt({
        subjectType: "owner",
        attempt: delivered,
        competingAttempts: [delivered],
        now: new Date(due + 7 * 60000),
      }),
    ).toMatchObject({ decision: "explicit_resolution", resolution: "snoozed" });
    await service.processReminders({
      now: new Date(due + 7 * 60000).toISOString(),
      scope: "definitions",
    });
    const occurrence = await service.repository.getOccurrence(
      f.runtime.agentId,
      delivered.ownerId,
    );
    expect(
      occurrence?.snoozedUntil,
      JSON.stringify(
        await service.repository.listReminderAttempts(f.runtime.agentId),
      ),
    ).toBe(new Date(repliedAt + 30 * 60000).toISOString());
    const [reviewed] = await service.repository.listReminderAttempts(
      f.runtime.agentId,
    );
    expect(reviewed.reviewStatus).toBe("resolved");
    expect(reviewed.deliveryMetadata.reminderReviewDecision).toBe("snoozed");
    expect(getRecordedTestNotifications(f.runtime)).toHaveLength(1);
    expect(model).not.toHaveBeenCalled();
  } finally {
    model.mockRestore();
    await f.cleanup();
  }
}, 120000);
