import type {
  LifeOpsOccurrenceView,
  LifeOpsOverview,
} from "@elizaos/shared/contracts/lifeops";
import { describe, expect, it } from "vitest";
import { formatOverviewForQuery } from "../src/actions/lifeops-google-helpers.js";

function buildOccurrence(args: {
  id: string;
  definitionId: string;
  title: string;
  windowName?: string | null;
  scheduledAt: string;
}): LifeOpsOccurrenceView {
  return {
    id: args.id,
    agentId: "agent-1",
    domain: "user_lifeops",
    definitionId: args.definitionId,
    occurrenceKey: `${args.definitionId}:${args.scheduledAt}`,
    subjectType: "owner",
    subjectId: "owner-1",
    visibilityScope: "owner_only",
    contextPolicy: "allowed_in_private_chat",
    state: "visible",
    scheduledAt: args.scheduledAt,
    dueAt: null,
    relevanceStartAt: args.scheduledAt,
    relevanceEndAt: args.scheduledAt,
    windowName: args.windowName ?? null,
    snoozedUntil: null,
    completionPayload: null,
    derivedTarget: null,
    metadata: {},
    createdAt: args.scheduledAt,
    updatedAt: args.scheduledAt,
    definitionKind: "habit",
    definitionStatus: "active",
    cadence: { kind: "daily", windows: ["morning"] },
    title: args.title,
    description: "",
    priority: 0,
    timezone: "America/Denver",
    source: "chat",
    goalId: null,
  };
}

function buildOverview(occurrences: LifeOpsOccurrenceView[]): LifeOpsOverview {
  const summary = {
    activeOccurrenceCount: occurrences.length,
    overdueOccurrenceCount: 0,
    snoozedOccurrenceCount: 0,
    activeReminderCount: 0,
    activeGoalCount: 0,
  };

  return {
    occurrences,
    goals: [],
    reminders: [],
    summary,
    schedule: null,
    owner: {
      occurrences,
      goals: [],
      reminders: [],
      summary,
    },
    agentOps: {
      occurrences: [],
      goals: [],
      reminders: [],
      summary: {
        activeOccurrenceCount: 0,
        overdueOccurrenceCount: 0,
        snoozedOccurrenceCount: 0,
        activeReminderCount: 0,
        activeGoalCount: 0,
      },
    },
  };
}

describe("formatOverviewForQuery", () => {
  it("groups repeated daily tasks instead of listing duplicate titles", () => {
    const overview = buildOverview([
      buildOccurrence({
        id: "occ-1",
        definitionId: "brush",
        title: "Brush teeth",
        windowName: "Morning",
        scheduledAt: "2026-04-12T08:00:00-06:00",
      }),
      buildOccurrence({
        id: "occ-2",
        definitionId: "brush",
        title: "Brush teeth",
        windowName: "Night",
        scheduledAt: "2026-04-12T21:00:00-06:00",
      }),
      buildOccurrence({
        id: "occ-3",
        definitionId: "rent",
        title: "Pay rent",
        scheduledAt: "2026-04-12T10:00:00-06:00",
      }),
    ]);

    const text = formatOverviewForQuery(
      overview,
      "what do i still need to do today in life ops?",
    );

    expect(text).toContain("You have 2 LifeOps tasks left for today");
    expect(text).toContain("Brush teeth (morning and night)");
    expect(text).toContain("Pay rent");
    expect(text).not.toContain("Brush teeth, Brush teeth");
  });
});
