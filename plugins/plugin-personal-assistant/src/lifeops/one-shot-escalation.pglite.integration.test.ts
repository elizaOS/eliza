/** Real saved plans, delivered/read receipts and >120 minutes of processing.
 * Reading never acknowledges/completes the occurrence. No live model calls. */
import { expect, it, vi } from "vitest";
import {
  createLifeOpsTestRuntime,
  getRecordedTestNotifications,
} from "../../test/helpers/runtime.js";
import { createLifeOpsReminderAttempt } from "./repository.js";
import { LifeOpsService } from "./service.js";
import {
  hasExplicitReminderEscalationProfile,
  resolveReminderEscalationDelayMinutes,
} from "./service-helpers-reminder.js";

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
      expect(body).toContain("Check the in-app notification");
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
