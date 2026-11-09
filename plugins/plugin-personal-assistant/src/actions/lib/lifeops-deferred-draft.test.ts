import { describe, expect, it } from "vitest";
import {
  coerceDeferredLifeDraft,
  type DeferredLifeDefinitionDraft,
  isLifeSaveRetraction,
} from "./lifeops-deferred-draft.js";

describe("coerceDeferredLifeDraft", () => {
  it("keeps every declared definition request field, checkInPolicy included", () => {
    // Every declared field set, so a field the coercer forgets shows up here.
    const request = {
      idempotencyKey: "draft-key",
      cadence: {
        kind: "times_per_day",
        slots: [
          {
            key: "morning",
            label: "Morning",
            minuteOfDay: 480,
            durationMinutes: 30,
          },
        ],
      },
      description: "8 glasses",
      goalRef: "goal-1",
      kind: "habit",
      priority: 2,
      progressionRule: { kind: "none" },
      checkInPolicy: {
        kind: "quota_progress",
        target: 8,
        unit: "glasses",
        windows: ["morning", "evening"],
      },
      reminderPlan: {
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "Nudge" }],
      },
      timezone: "UTC",
      title: "Drink water",
      metadata: { ownerSurface: "OWNER_REMINDERS" },
      windowPolicy: {
        timezone: "UTC",
        windows: [],
      },
      websiteAccess: { blockedSites: ["example.com"] },
    } as unknown as Required<DeferredLifeDefinitionDraft["request"]>;
    const draft: DeferredLifeDefinitionDraft = {
      intent: "drink 8 glasses a day, check in morning and evening",
      operation: "create_definition",
      createdAt: 1,
      sourceMessageId: "msg-1",
      request,
    };
    const coerced = coerceDeferredLifeDraft(
      JSON.parse(JSON.stringify(draft)),
    ) as DeferredLifeDefinitionDraft | null;
    expect(coerced).not.toBeNull();
    for (const key of Object.keys(request) as Array<keyof typeof request>) {
      expect(coerced?.request[key], key).toEqual(request[key]);
    }
  });

  it("drops a checkInPolicy that is not an object", () => {
    const coerced = coerceDeferredLifeDraft({
      intent: "water",
      operation: "create_definition",
      request: {
        kind: "habit",
        title: "Water",
        cadence: { kind: "daily", windows: ["morning"] },
        checkInPolicy: "quota_progress",
      },
    }) as DeferredLifeDefinitionDraft | null;
    expect(coerced?.request.checkInPolicy).toBeUndefined();
  });
});

describe("isLifeSaveRetraction", () => {
  it.each([
    "never mind",
    "Never mind.",
    "delete it",
    "actually don't save that one",
    "oh wait, cancel that",
    "no, don't keep it",
    "undo the last one",
    "get rid of it",
  ])("treats %j as a retraction", (text) => {
    expect(isLifeSaveRetraction(text)).toBe(true);
  });

  it.each([
    "don't forget to set it for 9",
    "don't set it for 9, set it for 10",
    "the dentist reminder, delete it",
    "remind me to call mom, never mind the time",
    "please don't forget to schedule it",
  ])("does not treat %j as a retraction", (text) => {
    expect(isLifeSaveRetraction(text)).toBe(false);
  });
});
