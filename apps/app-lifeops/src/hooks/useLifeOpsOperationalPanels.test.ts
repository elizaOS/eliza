// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, reactModuleUrl } = vi.hoisted(() => {
  return {
    clientMock: {
      getLifeOpsScheduleMergedState: vi.fn(async () => ({
        mergedState: {
          id: "schedule-1",
          agentId: "agent-1",
          scope: "effective",
          mergedAt: "2026-04-20T10:00:00.000Z",
          observationCount: 3,
          deviceCount: 1,
          contributingDeviceKinds: ["mac"],
          effectiveDayKey: "2026-04-20",
          localDate: "2026-04-20",
          timezone: "America/Los_Angeles",
          inferredAt: "2026-04-20T10:00:00.000Z",
          phase: "morning",
          sleepStatus: "slept",
          isProbablySleeping: false,
          sleepConfidence: 0.81,
          currentSleepStartedAt: null,
          lastSleepStartedAt: "2026-04-20T06:00:00.000Z",
          lastSleepEndedAt: "2026-04-20T10:00:00.000Z",
          lastSleepDurationMinutes: 240,
          typicalWakeHour: 7,
          typicalSleepHour: 23,
          wakeAt: "2026-04-20T07:00:00.000Z",
          firstActiveAt: "2026-04-20T07:05:00.000Z",
          lastActiveAt: "2026-04-20T09:45:00.000Z",
          meals: [],
          lastMealAt: null,
          nextMealLabel: "lunch",
          nextMealWindowStartAt: null,
          nextMealWindowEndAt: null,
          nextMealConfidence: 0.4,
          metadata: {},
          createdAt: "2026-04-20T10:00:00.000Z",
          updatedAt: "2026-04-20T10:00:00.000Z",
        },
      })),
      getLifeOpsOverview: vi.fn(async () => ({
        owner: {
          occurrences: [],
          goals: [],
          reminders: [
            {
              domain: "health",
              subjectType: "definition",
              subjectId: "stretch-1",
              ownerType: "occurrence",
              ownerId: "occ-1",
              occurrenceId: "occ-1",
              definitionId: "stretch-def",
              eventId: null,
              title: "Stretch break",
              channel: "client_chat",
              stepIndex: 0,
              stepLabel: "Stretch now",
              scheduledFor: "2026-04-20T11:00:00.000Z",
              dueAt: null,
              state: "upcoming",
            },
          ],
          summary: {
            activeOccurrenceCount: 0,
            overdueOccurrenceCount: 0,
            snoozedOccurrenceCount: 0,
            activeReminderCount: 1,
            activeGoalCount: 0,
          },
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
        schedule: {
          effectiveDayKey: "2026-04-20",
          localDate: "2026-04-20",
          timezone: "America/Los_Angeles",
          inferredAt: "2026-04-20T10:00:00.000Z",
          phase: "morning",
          sleepStatus: "slept",
          isProbablySleeping: false,
          sleepConfidence: 0.81,
          currentSleepStartedAt: null,
          lastSleepStartedAt: "2026-04-20T06:00:00.000Z",
          lastSleepEndedAt: "2026-04-20T10:00:00.000Z",
          lastSleepDurationMinutes: 240,
          typicalWakeHour: 7,
          typicalSleepHour: 23,
          wakeAt: "2026-04-20T07:00:00.000Z",
          firstActiveAt: "2026-04-20T07:05:00.000Z",
          lastActiveAt: "2026-04-20T09:45:00.000Z",
          meals: [],
          lastMealAt: null,
          nextMealLabel: "lunch",
          nextMealWindowStartAt: null,
          nextMealWindowEndAt: null,
          nextMealConfidence: 0.4,
        },
      })),
      getLifeOpsSeedTemplates: vi.fn(async () => ({
        needsSeeding: true,
        availableTemplates: [
          {
            key: "stretch",
            title: "Stretch break",
            description: "Short stretch breaks during the day",
          },
        ],
      })),
      seedLifeOpsRoutines: vi.fn(async () => ({ createdIds: ["def-1"] })),
      inspectLifeOpsReminder: vi.fn(async () => ({
        ownerType: "occurrence",
        ownerId: "occ-1",
        reminderPlan: null,
        attempts: [],
        audits: [],
      })),
      getXLifeOpsConnectorStatus: vi.fn(async () => ({
        provider: "x",
        mode: "local",
        connected: false,
        grantedCapabilities: [],
        grantedScopes: [],
        identity: null,
        hasCredentials: false,
        dmInbound: false,
        grant: null,
      })),
      upsertXLifeOpsConnector: vi.fn(async () => ({
        provider: "x",
        mode: "local",
        connected: true,
        grantedCapabilities: ["x.read", "x.write"],
        grantedScopes: [],
        identity: { username: "milady" },
        hasCredentials: true,
        dmInbound: true,
        grant: null,
      })),
      createXLifeOpsPost: vi.fn(async () => ({
        ok: true,
        status: 200,
        postId: "post-1",
        category: "success",
      })),
    },
    reactModuleUrl: `${process.cwd()}/node_modules/react/index.js`,
  };
});

vi.mock("@elizaos/app-core/api", () => ({ client: clientMock }));
vi.mock("react", async () => import(reactModuleUrl));

import { useLifeOpsScheduleState } from "./useLifeOpsScheduleState";
import { useLifeOpsStretchReminder } from "./useLifeOpsStretchReminder";
import { useLifeOpsXConnector } from "./useLifeOpsXConnector";

describe("LifeOps operational hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("loads schedule state and refreshes it", async () => {
    const { result } = renderHook(() =>
      useLifeOpsScheduleState({ scope: "effective" }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toMatchObject({ sleepStatus: "slept" });

    await act(async () => {
      await result.current.refresh();
    });

    expect(clientMock.getLifeOpsScheduleMergedState).toHaveBeenCalled();
  });

  it("connects X and posts text through typed client methods", async () => {
    const { result } = renderHook(() => useLifeOpsXConnector());

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.connect("local");
    });
    expect(clientMock.upsertXLifeOpsConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "local",
        capabilities: ["x.read", "x.write"],
      }),
    );

    await act(async () => {
      await result.current.post("hello from LifeOps");
    });
    expect(clientMock.createXLifeOpsPost).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello from LifeOps",
        confirmPost: true,
      }),
    );
  });

  it("seeds and inspects the stretch reminder flow", async () => {
    const { result } = renderHook(() => useLifeOpsStretchReminder());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stretchReminder?.title).toBe("Stretch break");

    await act(async () => {
      await result.current.createStretchReminder();
    });
    expect(clientMock.seedLifeOpsRoutines).toHaveBeenCalledWith({
      keys: ["stretch"],
      timezone: "America/Los_Angeles",
    });

    await act(async () => {
      await result.current.inspectStretchReminder();
    });
    expect(clientMock.inspectLifeOpsReminder).toHaveBeenCalledWith(
      "occurrence",
      "occ-1",
    );
    expect(result.current.inspection?.ownerId).toBe("occ-1");
  });
});
