import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LifeOpsGoalDefinition,
  LifeOpsOverview,
  LifeOpsOverviewSection,
} from "../contracts/index.js";
import type { LifeOpsOwnerProfile } from "../lifeops/owner-profile.js";

const {
  getOverviewMock,
  getGoogleConnectorAccountsMock,
  hasLifeOpsAccessMock,
  readLifeOpsOwnerProfileMock,
} = vi.hoisted(() => ({
  getOverviewMock: vi.fn(),
  getGoogleConnectorAccountsMock: vi.fn(),
  hasLifeOpsAccessMock: vi.fn(),
  readLifeOpsOwnerProfileMock: vi.fn(),
}));

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../actions/lifeops-google-helpers.js", () => ({
  hasLifeOpsAccess: hasLifeOpsAccessMock,
}));

vi.mock("../lifeops/service.js", () => ({
  LifeOpsService: class {
    getOverview = getOverviewMock;
    getGoogleConnectorAccounts = getGoogleConnectorAccountsMock;
    getNextCalendarEventContext = vi.fn();
    getGmailTriage = vi.fn();
  },
}));

vi.mock("../lifeops/owner-profile.js", () => ({
  readLifeOpsOwnerProfile: readLifeOpsOwnerProfileMock,
}));

import { lifeOpsProvider } from "./lifeops.js";

function ownerProfile(): LifeOpsOwnerProfile {
  return {
    name: "admin",
    relationshipStatus: "n/a",
    partnerName: "n/a",
    orientation: "n/a",
    gender: "n/a",
    age: "n/a",
    location: "n/a",
    travelBookingPreferences: "n/a",
    morningCheckinTime: "",
    nightCheckinTime: "",
    updatedAt: null,
  };
}

function activeGoal(
  overrides: Partial<LifeOpsGoalDefinition> & {
    id: string;
    title: string;
  },
): LifeOpsGoalDefinition {
  return {
    id: overrides.id,
    agentId: "owner",
    domain: "personal",
    subjectType: "owner",
    subjectId: "owner",
    visibilityScope: "owner",
    contextPolicy: "private",
    title: overrides.title,
    description: overrides.description ?? "",
    cadence: overrides.cadence ?? null,
    supportStrategy: overrides.supportStrategy ?? {},
    successCriteria: overrides.successCriteria ?? {},
    status: overrides.status ?? "active",
    reviewState: overrides.reviewState ?? "on_track",
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-30T00:00:00.000Z",
  } as LifeOpsGoalDefinition;
}

function emptySection(): LifeOpsOverviewSection {
  return {
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
  };
}

function overviewWithOwnerGoals(
  goals: LifeOpsGoalDefinition[],
): LifeOpsOverview {
  const ownerSection: LifeOpsOverviewSection = {
    ...emptySection(),
    goals,
    summary: {
      activeOccurrenceCount: 0,
      overdueOccurrenceCount: 0,
      snoozedOccurrenceCount: 0,
      activeReminderCount: 0,
      activeGoalCount: goals.filter((goal) => goal.status === "active").length,
    },
  };
  const agentSection = emptySection();
  return {
    occurrences: ownerSection.occurrences,
    goals: ownerSection.goals,
    reminders: ownerSection.reminders,
    summary: ownerSection.summary,
    owner: ownerSection,
    agentOps: agentSection,
    schedule: null,
  };
}

describe("lifeOpsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasLifeOpsAccessMock.mockResolvedValue(true);
    readLifeOpsOwnerProfileMock.mockResolvedValue(ownerProfile());
    getGoogleConnectorAccountsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an empty provider result when the sender lacks LifeOps access", async () => {
    hasLifeOpsAccessMock.mockResolvedValue(false);

    const result = await lifeOpsProvider.get(
      { agentId: "owner" } as never,
      { entityId: "other" } as never,
      {} as never,
    );

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(getOverviewMock).not.toHaveBeenCalled();
  });

  it("surfaces active goal titles, review state, and last-reviewed timing alongside the count", async () => {
    const now = new Date("2026-05-03T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const goals: LifeOpsGoalDefinition[] = [
      activeGoal({
        id: "goal-marathon",
        title: "Train for marathon",
        reviewState: "on_track",
        updatedAt: "2026-05-01T12:00:00.000Z",
        metadata: {
          computedGoalReview: {
            reviewedAt: "2026-05-01T12:00:00.000Z",
            reviewState: "on_track",
          },
        },
      }),
      activeGoal({
        id: "goal-books",
        title: "Read 20 books in 2026",
        reviewState: "needs_attention",
        updatedAt: "2026-04-26T12:00:00.000Z",
        metadata: {
          computedGoalReview: {
            reviewedAt: "2026-04-26T12:00:00.000Z",
            reviewState: "needs_attention",
          },
        },
      }),
      activeGoal({
        id: "goal-launch",
        title: "Ship LifeOps v2 launch",
        reviewState: "at_risk",
        updatedAt: "2026-04-20T12:00:00.000Z",
      }),
    ];
    getOverviewMock.mockResolvedValue(overviewWithOwnerGoals(goals));

    try {
      const result = await lifeOpsProvider.get(
        { agentId: "owner" } as never,
        { entityId: "owner" } as never,
        {} as never,
      );

      expect(result.text).toContain("Owner active goals: 3");
      expect(result.text).toContain("Train for marathon");
      expect(result.text).toContain("Read 20 books in 2026");
      expect(result.text).toContain("Ship LifeOps v2 launch");
      expect(result.text).toContain("on_track");
      expect(result.text).toContain("needs_attention");
      expect(result.text).toContain("at_risk");
      expect(result.text).toContain("last reviewed");
      expect(result.text).toContain("not yet reviewed");
      const marathonIdx = result.text.indexOf("Train for marathon");
      const booksIdx = result.text.indexOf("Read 20 books in 2026");
      const launchIdx = result.text.indexOf("Ship LifeOps v2 launch");
      expect(marathonIdx).toBeGreaterThan(-1);
      expect(marathonIdx).toBeLessThan(booksIdx);
      expect(booksIdx).toBeLessThan(launchIdx);
      expect(result.values?.ownerActiveGoalTitles).toEqual([
        "Train for marathon",
        "Read 20 books in 2026",
        "Ship LifeOps v2 launch",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("truncates long goal titles to 80 characters and notes additional goals beyond the cap", async () => {
    const longTitle = "A".repeat(120);
    const goals: LifeOpsGoalDefinition[] = Array.from({ length: 7 }).map(
      (_, index) =>
        activeGoal({
          id: `goal-${index}`,
          title:
            index === 0
              ? longTitle
              : `Active goal number ${index} with reasonable length`,
          updatedAt: new Date(
            Date.UTC(2026, 4, 3 - index, 12, 0, 0),
          ).toISOString(),
        }),
    );
    getOverviewMock.mockResolvedValue(overviewWithOwnerGoals(goals));

    const result = await lifeOpsProvider.get(
      { agentId: "owner" } as never,
      { entityId: "owner" } as never,
      {} as never,
    );

    expect(result.text).toContain("Owner active goals: 7");
    expect(result.text).not.toContain(longTitle);
    expect(result.text).toMatch(/A{79}…/);
    expect(result.text).toContain("(+2 more active goals)");
  });
});
