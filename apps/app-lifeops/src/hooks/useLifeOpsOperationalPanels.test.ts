// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock } = vi.hoisted(() => {
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
          relativeTime: {
            computedAt: "2026-04-20T10:00:00.000Z",
            localNowAt: "2026-04-20T03:00:00-07:00",
            phase: "morning",
            isProbablySleeping: false,
            isAwake: true,
            awakeState: "awake",
            wakeAnchorAt: "2026-04-20T07:00:00.000Z",
            wakeAnchorSource: "sleep_cycle",
            minutesSinceWake: 180,
            minutesAwake: 180,
            bedtimeTargetAt: "2026-04-21T06:00:00.000Z",
            bedtimeTargetSource: "typical_sleep",
            minutesUntilBedtimeTarget: 1200,
            minutesSinceBedtimeTarget: null,
            dayBoundaryStartAt: "2026-04-20T07:00:00.000Z",
            dayBoundaryEndAt: "2026-04-21T07:00:00.000Z",
            minutesSinceDayBoundaryStart: 180,
            minutesUntilDayBoundaryEnd: 1260,
            confidence: 0.81,
          },
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
          relativeTime: {
            computedAt: "2026-04-20T10:00:00.000Z",
            localNowAt: "2026-04-20T03:00:00-07:00",
            phase: "morning",
            isProbablySleeping: false,
            isAwake: true,
            awakeState: "awake",
            wakeAnchorAt: "2026-04-20T07:00:00.000Z",
            wakeAnchorSource: "sleep_cycle",
            minutesSinceWake: 180,
            minutesAwake: 180,
            bedtimeTargetAt: "2026-04-21T06:00:00.000Z",
            bedtimeTargetSource: "typical_sleep",
            minutesUntilBedtimeTarget: 1200,
            minutesSinceBedtimeTarget: null,
            dayBoundaryStartAt: "2026-04-20T07:00:00.000Z",
            dayBoundaryEndAt: "2026-04-21T07:00:00.000Z",
            minutesSinceDayBoundaryStart: 180,
            minutesUntilDayBoundaryEnd: 1260,
            confidence: 0.81,
          },
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
      getLifeOpsCapabilitiesStatus: vi.fn(async () => ({
        generatedAt: "2026-04-20T10:00:00.000Z",
        appEnabled: true,
        relativeTime: {
          computedAt: "2026-04-20T10:00:00.000Z",
          localNowAt: "2026-04-20T03:00:00-07:00",
          phase: "morning",
          isProbablySleeping: false,
          isAwake: true,
          awakeState: "awake",
          wakeAnchorAt: "2026-04-20T07:00:00.000Z",
          wakeAnchorSource: "sleep_cycle",
          minutesSinceWake: 180,
          minutesAwake: 180,
          bedtimeTargetAt: "2026-04-21T06:00:00.000Z",
          bedtimeTargetSource: "typical_sleep",
          minutesUntilBedtimeTarget: 1200,
          minutesSinceBedtimeTarget: null,
          dayBoundaryStartAt: "2026-04-20T07:00:00.000Z",
          dayBoundaryEndAt: "2026-04-21T07:00:00.000Z",
          minutesSinceDayBoundaryStart: 180,
          minutesUntilDayBoundaryEnd: 1260,
          confidence: 0.81,
        },
        capabilities: [
          {
            id: "sleep.relative_time",
            domain: "schedule",
            label: "Awake-relative time",
            state: "working",
            summary: "morning; awake 3h; bedtime in 20h",
            confidence: 0.81,
            lastCheckedAt: "2026-04-20T10:00:00.000Z",
            evidence: [],
          },
        ],
        summary: {
          totalCount: 1,
          workingCount: 1,
          degradedCount: 0,
          blockedCount: 0,
          notConfiguredCount: 0,
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
      startXLifeOpsConnector: vi.fn(async () => ({
        provider: "x",
        side: "agent",
        mode: "local",
        requestedCapabilities: ["x.read", "x.write", "x.dm.read", "x.dm.write"],
        redirectUri: "",
        authUrl: "",
      })),
      upsertXLifeOpsConnector: vi.fn(async () => ({
        provider: "x",
        mode: "local",
        connected: true,
        grantedCapabilities: ["x.read", "x.write", "x.dm.read", "x.dm.write"],
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
  };
});

vi.mock("@elizaos/app-core/api", () => ({ client: clientMock }));
vi.mock("@elizaos/app-core/utils", () => ({ openExternalUrl: vi.fn() }));

import { useLifeOpsCapabilitiesStatus } from "./useLifeOpsCapabilitiesStatus";
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

    expect(clientMock.getLifeOpsScheduleMergedState).toHaveBeenLastCalledWith({
      scope: "effective",
      timezone: undefined,
      refresh: true,
    });
  });

  it("loads LifeOps capability status through the typed client", async () => {
    const { result } = renderHook(() => useLifeOpsCapabilitiesStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status?.summary.workingCount).toBe(1);

    await act(async () => {
      await result.current.refresh();
    });

    expect(clientMock.getLifeOpsCapabilitiesStatus).toHaveBeenCalledTimes(2);
  });

  it("connects owner X by default and posts from the explicit agent account", async () => {
    const { result } = renderHook(() => useLifeOpsXConnector());

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.connect("local");
    });
    expect(clientMock.startXLifeOpsConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "local",
        side: "owner",
      }),
    );

    const agentHook = renderHook(() => useLifeOpsXConnector("agent"));
    await waitFor(() => expect(agentHook.result.current.loading).toBe(false));

    await act(async () => {
      await agentHook.result.current.post("hello from LifeOps");
    });
    expect(clientMock.createXLifeOpsPost).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "agent",
        text: "hello from LifeOps",
        confirmPost: true,
      }),
    );
  });

  it("uses the local LifeOps success endpoint for cloud-managed X auth", async () => {
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...originalLocation,
        origin: "http://localhost:31337",
      },
    });

    try {
      const { result } = renderHook(() => useLifeOpsXConnector());
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.connect("cloud_managed");
      });

      expect(clientMock.startXLifeOpsConnector).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "cloud_managed",
          side: "owner",
          redirectUrl:
            "http://localhost:31337/api/lifeops/connectors/x/success?side=owner&mode=cloud_managed",
        }),
      );
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
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
