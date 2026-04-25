import type {
  LifeOpsOccurrenceView,
  LifeOpsOverview,
} from "@elizaos/app-lifeops/contracts";
import { describe, expect, it } from "vitest";
import {
  formatOverview,
  formatOverviewForQuery,
} from "../src/actions/lifeops-google-helpers.js";

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

  it("includes schedule context in the overview summary", () => {
    const overview = buildOverview([]);
    overview.schedule = {
      effectiveDayKey: "2026-04-19",
      localDate: "2026-04-19",
      timezone: "UTC",
      inferredAt: "2026-04-19T13:00:00.000Z",
      circadianState: "awake",
      stateConfidence: 0.81,
      uncertaintyReason: null,
      relativeTime: {
        computedAt: "2026-04-19T13:00:00.000Z",
        localNowAt: "2026-04-19T13:00:00+00:00",
        circadianState: "awake",
        stateConfidence: 0.81,
        uncertaintyReason: null,
        awakeProbability: {
          pAwake: 0.81,
          pAsleep: 0.04,
          pUnknown: 0.15,
          contributingSources: [],
          computedAt: "2026-04-19T13:00:00.000Z",
        },
        wakeAnchorAt: "2026-04-19T07:30:00.000Z",
        wakeAnchorSource: "sleep_cycle",
        minutesSinceWake: 330,
        minutesAwake: 330,
        bedtimeTargetAt: "2026-04-19T23:30:00.000Z",
        bedtimeTargetSource: "typical_sleep",
        minutesUntilBedtimeTarget: 630,
        minutesSinceBedtimeTarget: null,
        dayBoundaryStartAt: "2026-04-19T00:00:00.000Z",
        dayBoundaryEndAt: "2026-04-20T00:00:00.000Z",
        minutesSinceDayBoundaryStart: 780,
        minutesUntilDayBoundaryEnd: 660,
        confidence: 0.81,
      },
      awakeProbability: {
        pAwake: 0.81,
        pAsleep: 0.04,
        pUnknown: 0.15,
        contributingSources: [],
        computedAt: "2026-04-19T13:00:00.000Z",
      },
      regularity: {
        sri: 78,
        bedtimeStddevMin: 30,
        wakeStddevMin: 28,
        midSleepStddevMin: 22,
        regularityClass: "regular",
        sampleCount: 8,
        windowDays: 28,
      },
      baseline: {
        medianWakeLocalHour: 7.5,
        medianBedtimeLocalHour: 23.5,
        medianSleepDurationMin: 480,
        bedtimeStddevMin: 30,
        wakeStddevMin: 28,
        sampleCount: 8,
        windowDays: 28,
      },
      sleepStatus: "slept",
      sleepConfidence: 0.81,
      currentSleepStartedAt: null,
      lastSleepStartedAt: "2026-04-18T23:30:00.000Z",
      lastSleepEndedAt: "2026-04-19T07:30:00.000Z",
      lastSleepDurationMinutes: 480,
      wakeAt: "2026-04-19T07:30:00.000Z",
      firstActiveAt: "2026-04-19T07:35:00.000Z",
      lastActiveAt: "2026-04-19T12:15:00.000Z",
      meals: [],
      lastMealAt: null,
      nextMealLabel: "lunch",
      nextMealWindowStartAt: "2026-04-19T13:00:00.000Z",
      nextMealWindowEndAt: "2026-04-19T15:00:00.000Z",
      nextMealConfidence: 0.55,
    };

    const text = formatOverview(overview);

    expect(text).toContain("Circadian state: awake");
    expect(text).toContain("Last wake 2026-04-19T07:30:00.000Z");
    expect(text).toContain("Next lunch window starts 2026-04-19T13:00:00.000Z");
  });
});
