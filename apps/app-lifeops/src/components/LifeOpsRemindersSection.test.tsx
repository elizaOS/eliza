// @vitest-environment jsdom

import type {
  LifeOpsDefinitionRecord,
  LifeOpsTaskDefinition,
} from "@elizaos/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, selectMock } = vi.hoisted(() => ({
  clientMock: {
    getLifeOpsOverview: vi.fn(),
    listLifeOpsDefinitions: vi.fn(),
    createLifeOpsDefinition: vi.fn(),
  },
  selectMock: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => ({
  client: clientMock,
  useApp: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? _key,
  }),
}));

vi.mock("./LifeOpsChatAdapter.js", () => ({
  useLifeOpsChatLauncher: () => ({
    chatAboutReminder: vi.fn(),
  }),
}));

vi.mock("./LifeOpsSelectionContext.js", () => ({
  useLifeOpsSelection: () => ({
    select: selectMock,
    selection: {},
  }),
}));

import { LifeOpsRemindersSection } from "./LifeOpsRemindersSection.js";

const performanceWindow = {
  scheduledCount: 0,
  completedCount: 0,
  skippedCount: 0,
  pendingCount: 0,
  completionRate: 0,
  perfectDayCount: 0,
};

function buildDefinitionRecord(
  overrides: Partial<LifeOpsTaskDefinition>,
): LifeOpsDefinitionRecord {
  return {
    definition: {
      id: "definition-1",
      agentId: "agent-1",
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: "owner-1",
      visibilityScope: "owner_only",
      contextPolicy: "sidebar_only",
      kind: "task",
      title: "Morning alarm",
      description: "Alarm",
      originalIntent: "Morning alarm",
      timezone: "America/Los_Angeles",
      status: "active",
      priority: 1,
      cadence: {
        kind: "once",
        dueAt: "2026-05-01T14:00:00.000Z",
      },
      windowPolicy: {
        timezone: "America/Los_Angeles",
        windows: [
          {
            name: "custom",
            label: "Alarm",
            startMinute: 420,
            endMinute: 421,
          },
        ],
      },
      progressionRule: { kind: "none" },
      websiteAccess: null,
      reminderPlanId: "plan-1",
      goalId: null,
      source: "lifeops_ui_alarm",
      metadata: { lifeOpsAlarm: true },
      createdAt: "2026-04-28T12:00:00.000Z",
      updatedAt: "2026-04-28T12:00:00.000Z",
      ...overrides,
    },
    reminderPlan: null,
    performance: {
      lastCompletedAt: null,
      lastSkippedAt: null,
      lastActivityAt: null,
      totalScheduledCount: 0,
      totalCompletedCount: 0,
      totalSkippedCount: 0,
      totalPendingCount: 0,
      currentOccurrenceStreak: 0,
      bestOccurrenceStreak: 0,
      currentPerfectDayStreak: 0,
      bestPerfectDayStreak: 0,
      last7Days: performanceWindow,
      last30Days: performanceWindow,
    },
  };
}

beforeEach(() => {
  clientMock.getLifeOpsOverview.mockResolvedValue({ reminders: [] });
  clientMock.listLifeOpsDefinitions.mockResolvedValue({ definitions: [] });
  clientMock.createLifeOpsDefinition.mockResolvedValue(
    buildDefinitionRecord({ id: "created-definition" }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LifeOpsRemindersSection", () => {
  it("loads reminders and definitions for the reminders route shell", async () => {
    render(<LifeOpsRemindersSection />);

    expect(screen.getByTestId("lifeops-reminders")).toBeTruthy();
    await waitFor(() => expect(clientMock.getLifeOpsOverview).toHaveBeenCalled());
    expect(clientMock.listLifeOpsDefinitions).toHaveBeenCalled();
    expect(
      await screen.findByText("All clear. No active reminders."),
    ).toBeTruthy();
  });

  it("creates selected-weekday alarms with a valid weekly custom window cadence", async () => {
    render(<LifeOpsRemindersSection />);

    fireEvent.click(screen.getByRole("tab", { name: /alarms/i }));
    fireEvent.click(await screen.findByText("Add alarm"));
    fireEvent.change(screen.getByLabelText("Time"), {
      target: { value: "06:30" },
    });
    fireEvent.change(screen.getByLabelText("Label (optional)"), {
      target: { value: "Gym" },
    });
    fireEvent.click(screen.getByTitle("Monday"));
    fireEvent.click(screen.getByTitle("Wednesday"));
    fireEvent.click(screen.getByText("Save alarm"));

    await waitFor(() =>
      expect(clientMock.createLifeOpsDefinition).toHaveBeenCalled(),
    );
    const request = clientMock.createLifeOpsDefinition.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      title: "Gym",
      source: "lifeops_ui_alarm",
      cadence: {
        kind: "weekly",
        weekdays: [1, 3],
        windows: ["custom"],
        visibilityLeadMinutes: 0,
        visibilityLagMinutes: 0,
      },
      windowPolicy: {
        windows: [
          {
            name: "custom",
            label: "Alarm",
            startMinute: 390,
            endMinute: 391,
          },
        ],
      },
      metadata: {
        lifeOpsAlarm: true,
      },
      reminderPlan: {
        steps: [
          {
            channel: "in_app",
            offsetMinutes: 0,
            label: "Alarm",
          },
        ],
      },
    });
    expect(request.metadata.nativeAppleReminder).toBeUndefined();
  });

  it("does not show the Reminders.app badge until native sync returns an id", async () => {
    clientMock.listLifeOpsDefinitions.mockResolvedValue({
      definitions: [
        buildDefinitionRecord({
          metadata: {
            lifeOpsAlarm: true,
            nativeAppleReminder: {
              kind: "alarm",
              provider: "apple_reminders",
              reminderId: null,
              source: "heuristic",
            },
          },
        }),
      ],
    });

    render(<LifeOpsRemindersSection />);

    fireEvent.click(screen.getByRole("tab", { name: /alarms/i }));

    expect(await screen.findByText("Morning alarm")).toBeTruthy();
    expect(screen.queryByText("Reminders.app")).toBeNull();
    expect(screen.getByText("In-app")).toBeTruthy();
  });

  it("shows the Reminders.app badge after native sync returns an id", async () => {
    clientMock.listLifeOpsDefinitions.mockResolvedValue({
      definitions: [
        buildDefinitionRecord({
          metadata: {
            lifeOpsAlarm: true,
            nativeAppleReminder: {
              kind: "alarm",
              provider: "apple_reminders",
              reminderId: "x-apple-reminder-id",
              source: "heuristic",
            },
          },
        }),
      ],
    });

    render(<LifeOpsRemindersSection />);

    fireEvent.click(screen.getByRole("tab", { name: /alarms/i }));

    expect(await screen.findByText("Morning alarm")).toBeTruthy();
    expect(screen.getByText("Reminders.app")).toBeTruthy();
  });
});
