import type { IAgentRuntime, Task } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  LIFEOPS_TASK_NAME,
  LIFEOPS_TASK_TAGS,
} from "../src/lifeops/runtime.js";
import type { LifeOpsScheduleMergedState } from "../src/lifeops/schedule-sync-contracts.js";
import { LifeOpsService } from "../src/lifeops/service.js";

const NOW = "2026-04-20T10:00:00.000Z";

function buildMergedState(): LifeOpsScheduleMergedState {
  return {
    id: "schedule-1",
    agentId: "00000000-0000-0000-0000-000000000001",
    scope: "local",
    mergedAt: NOW,
    observationCount: 4,
    deviceCount: 2,
    contributingDeviceKinds: ["iphone", "mac"],
    effectiveDayKey: "2026-04-20",
    localDate: "2026-04-20",
    timezone: "UTC",
    inferredAt: NOW,
    phase: "morning",
    relativeTime: {
      computedAt: NOW,
      localNowAt: "2026-04-20T10:00:00+00:00",
      phase: "morning",
      isProbablySleeping: false,
      isAwake: true,
      awakeState: "awake",
      wakeAnchorAt: "2026-04-20T07:00:00.000Z",
      wakeAnchorSource: "sleep_cycle",
      minutesSinceWake: 180,
      minutesAwake: 180,
      bedtimeTargetAt: "2026-04-20T23:00:00.000Z",
      bedtimeTargetSource: "typical_sleep",
      minutesUntilBedtimeTarget: 780,
      minutesSinceBedtimeTarget: null,
      dayBoundaryStartAt: "2026-04-20T00:00:00.000Z",
      dayBoundaryEndAt: "2026-04-21T00:00:00.000Z",
      minutesSinceDayBoundaryStart: 600,
      minutesUntilDayBoundaryEnd: 840,
      confidence: 0.82,
    },
    sleepStatus: "slept",
    isProbablySleeping: false,
    sleepConfidence: 0.82,
    currentSleepStartedAt: null,
    lastSleepStartedAt: "2026-04-19T23:00:00.000Z",
    lastSleepEndedAt: "2026-04-20T07:00:00.000Z",
    lastSleepDurationMinutes: 480,
    typicalWakeHour: 7,
    typicalSleepHour: 23,
    wakeAt: "2026-04-20T07:00:00.000Z",
    firstActiveAt: "2026-04-20T07:10:00.000Z",
    lastActiveAt: "2026-04-20T09:50:00.000Z",
    meals: [],
    lastMealAt: null,
    nextMealLabel: "lunch",
    nextMealWindowStartAt: "2026-04-20T12:00:00.000Z",
    nextMealWindowEndAt: "2026-04-20T14:00:00.000Z",
    nextMealConfidence: 0.5,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function buildRuntime(): IAgentRuntime {
  const schedulerTask: Task = {
    id: "00000000-0000-0000-0000-000000000010",
    name: LIFEOPS_TASK_NAME,
    description: "Process life-ops reminders and scheduled workflows",
    roomId: "00000000-0000-0000-0000-000000000011",
    agentId: "00000000-0000-0000-0000-000000000001",
    tags: [...LIFEOPS_TASK_TAGS],
    metadata: { updateInterval: 60_000 },
    dueAt: Date.parse(NOW),
    createdAt: Date.parse(NOW),
    updatedAt: Date.parse(NOW),
  } as Task;
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    adapter: {
      db: {
        execute: vi.fn(async () => ({ rows: [] })),
      },
    },
    getCache: vi.fn(async () => ({ enabled: true })),
    setCache: vi.fn(async () => true),
    getService: vi.fn(() => null),
    getTaskWorker: vi.fn(() => ({ name: LIFEOPS_TASK_NAME })),
    getTasks: vi.fn(async () => [schedulerTask]),
  } as unknown as IAgentRuntime;
}

function stubCapabilityDependencies(service: LifeOpsService): void {
  vi.spyOn(service, "getScheduleMergedState").mockResolvedValue(
    buildMergedState(),
  );
  vi.spyOn(service, "getBrowserSettings").mockResolvedValue({
    enabled: true,
    trackingMode: "metadata",
    allowBrowserControl: false,
    requireConfirmationForAccountAffecting: true,
    incognitoEnabled: false,
    siteAccessMode: "allowlist",
    grantedOrigins: ["https://x.com"],
    blockedOrigins: [],
    maxRememberedTabs: 50,
    pauseUntil: null,
    metadata: {},
    updatedAt: NOW,
  });
  vi.spyOn(service, "listBrowserCompanions").mockResolvedValue([]);
  vi.spyOn(service, "getHealthConnectorStatus").mockResolvedValue({
    available: true,
    backend: "healthkit",
    lastCheckedAt: NOW,
  });
  vi.spyOn(service, "getXConnectorStatus").mockResolvedValue({
    provider: "x",
    mode: "local",
    connected: true,
    grantedCapabilities: ["x.read", "x.write"],
    grantedScopes: ["tweet.read", "tweet.write"],
    identity: { username: "milady" },
    hasCredentials: true,
    feedRead: true,
    feedWrite: true,
    dmRead: false,
    dmWrite: false,
    dmInbound: false,
    grant: null,
  });
}

describe("LifeOps capability status", () => {
  it("summarizes runtime, awake-relative time, scheduler, browser, features, and X", async () => {
    const service = new LifeOpsService(buildRuntime());
    stubCapabilityDependencies(service);

    const status = await service.getCapabilityStatus(new Date(NOW));

    expect(status.appEnabled).toBe(true);
    expect(status.relativeTime?.isAwake).toBe(true);
    expect(status.summary.totalCount).toBeGreaterThanOrEqual(6);
    expect(status.capabilities.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "lifeops.app",
        "sleep.relative_time",
        "reminders.scheduler",
        "activity.browser",
        "features.opt_in",
        "connectors.x",
      ]),
    );
    expect(
      status.capabilities.find((item) => item.id === "sleep.relative_time")
        ?.summary,
    ).toContain("awake 3h");
  });

  it("marks runtime and scheduler degraded when app state cannot be loaded", async () => {
    const runtime = buildRuntime();
    vi.mocked(runtime.getCache).mockRejectedValue(new Error("cache offline"));
    const service = new LifeOpsService(runtime);
    stubCapabilityDependencies(service);

    const status = await service.getCapabilityStatus(new Date(NOW));
    const app = status.capabilities.find((item) => item.id === "lifeops.app");
    const scheduler = status.capabilities.find(
      (item) => item.id === "reminders.scheduler",
    );

    expect(status.appEnabled).toBe(false);
    expect(app?.state).toBe("degraded");
    expect(app?.summary).toBe("LifeOps app state could not be loaded");
    expect(scheduler?.state).toBe("degraded");
    expect(scheduler?.summary).toBe(
      "Scheduler status is degraded because LifeOps app state failed to load",
    );
  });
});
