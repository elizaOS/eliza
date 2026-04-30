import type { IAgentRuntime, Task } from "@elizaos/core";
import type {
  BrowserBridgeCompanionStatus,
  BrowserBridgeSettings,
} from "@elizaos/plugin-browser-bridge";
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
    circadianState: "awake",
    stateConfidence: 0.82,
    uncertaintyReason: null,
    relativeTime: {
      computedAt: NOW,
      localNowAt: "2026-04-20T10:00:00+00:00",
      circadianState: "awake",
      stateConfidence: 0.82,
      uncertaintyReason: null,
      awakeProbability: {
        pAwake: 0.82,
        pAsleep: 0.05,
        pUnknown: 0.13,
        contributingSources: [],
        computedAt: NOW,
      },
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
    awakeProbability: {
      pAwake: 0.82,
      pAsleep: 0.05,
      pUnknown: 0.13,
      contributingSources: [],
      computedAt: NOW,
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
      medianWakeLocalHour: 7,
      medianBedtimeLocalHour: 23,
      medianSleepDurationMin: 480,
      bedtimeStddevMin: 30,
      wakeStddevMin: 28,
      sampleCount: 8,
      windowDays: 28,
    },
    sleepStatus: "slept",
    sleepConfidence: 0.82,
    currentSleepStartedAt: null,
    lastSleepStartedAt: "2026-04-19T23:00:00.000Z",
    lastSleepEndedAt: "2026-04-20T07:00:00.000Z",
    lastSleepDurationMinutes: 480,
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

function buildBrowserSettings(
  overrides: Partial<BrowserBridgeSettings> = {},
): BrowserBridgeSettings {
  return {
    enabled: true,
    trackingMode: "current_tab",
    allowBrowserControl: true,
    requireConfirmationForAccountAffecting: true,
    incognitoEnabled: false,
    siteAccessMode: "all_sites",
    grantedOrigins: [],
    blockedOrigins: [],
    maxRememberedTabs: 50,
    pauseUntil: null,
    metadata: {},
    updatedAt: NOW,
    ...overrides,
  };
}

function buildBrowserCompanion(
  overrides: Partial<BrowserBridgeCompanionStatus> = {},
): BrowserBridgeCompanionStatus {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    browser: "chrome",
    connectionState: "connected",
    createdAt: NOW,
    extensionVersion: "1.0.0",
    id: "browser-companion-1",
    label: "Chrome Default",
    lastSeenAt: NOW,
    metadata: {},
    pairedAt: NOW,
    permissions: {
      activeTab: true,
      allOrigins: true,
      grantedOrigins: [],
      incognitoEnabled: false,
      scripting: true,
      tabs: true,
    },
    profileId: "default",
    profileLabel: "Default",
    updatedAt: NOW,
    ...overrides,
  };
}

function stubCapabilityDependencies(
  service: LifeOpsService,
  options: {
    browserSettings?: BrowserBridgeSettings;
    browserSettingsError?: Error;
    browserCompanions?: BrowserBridgeCompanionStatus[];
    browserCompanionsError?: Error;
  } = {},
): void {
  vi.spyOn(service, "getScheduleMergedState").mockResolvedValue(
    buildMergedState(),
  );
  const browserSettingsSpy = vi.spyOn(service, "getBrowserSettings");
  if (options.browserSettingsError) {
    browserSettingsSpy.mockRejectedValue(options.browserSettingsError);
  } else {
    browserSettingsSpy.mockResolvedValue(
      options.browserSettings ?? buildBrowserSettings(),
    );
  }
  const browserCompanionsSpy = vi.spyOn(service, "listBrowserCompanions");
  if (options.browserCompanionsError) {
    browserCompanionsSpy.mockRejectedValue(options.browserCompanionsError);
  } else {
    browserCompanionsSpy.mockResolvedValue(
      options.browserCompanions ?? [buildBrowserCompanion()],
    );
  }
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
    expect(status.relativeTime?.circadianState).toBe("awake");
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

  it("does not mark browser activity working when no companion is paired", async () => {
    const service = new LifeOpsService(buildRuntime());
    stubCapabilityDependencies(service, { browserCompanions: [] });

    const status = await service.getCapabilityStatus(new Date(NOW));
    const browser = status.capabilities.find(
      (item) => item.id === "activity.browser",
    );

    expect(browser?.state).toBe("not_configured");
    expect(browser?.summary).toBe("No browser companion has paired yet");
  });

  it("marks browser activity working only for a recent connected usable companion", async () => {
    const service = new LifeOpsService(buildRuntime());
    stubCapabilityDependencies(service, {
      browserCompanions: [buildBrowserCompanion()],
    });

    const status = await service.getCapabilityStatus(new Date(NOW));
    const browser = status.capabilities.find(
      (item) => item.id === "activity.browser",
    );

    expect(browser?.state).toBe("working");
    expect(browser?.summary).toContain("1 recent companion");
  });

  it("marks browser activity degraded when the companion is stale", async () => {
    const service = new LifeOpsService(buildRuntime());
    stubCapabilityDependencies(service, {
      browserCompanions: [
        buildBrowserCompanion({ lastSeenAt: "2026-04-20T09:40:00.000Z" }),
      ],
    });

    const status = await service.getCapabilityStatus(new Date(NOW));
    const browser = status.capabilities.find(
      (item) => item.id === "activity.browser",
    );

    expect(browser?.state).toBe("degraded");
    expect(browser?.summary).toBe(
      "No connected browser companion has checked in recently",
    );
  });

  it("marks browser activity not configured when browser settings are disabled", async () => {
    const service = new LifeOpsService(buildRuntime());
    stubCapabilityDependencies(service, {
      browserSettings: buildBrowserSettings({ enabled: false }),
    });

    const status = await service.getCapabilityStatus(new Date(NOW));
    const browser = status.capabilities.find(
      (item) => item.id === "activity.browser",
    );

    expect(browser?.state).toBe("not_configured");
    expect(browser?.summary).toBe("Browser tracking is disabled");
  });

  it("marks browser activity degraded when browser control is disabled", async () => {
    const service = new LifeOpsService(buildRuntime());
    stubCapabilityDependencies(service, {
      browserSettings: buildBrowserSettings({ allowBrowserControl: false }),
    });

    const status = await service.getCapabilityStatus(new Date(NOW));
    const browser = status.capabilities.find(
      (item) => item.id === "activity.browser",
    );

    expect(browser?.state).toBe("degraded");
    expect(browser?.summary).toBe("Browser control is disabled");
  });

  it("marks browser activity degraded when browser status fails to load", async () => {
    const service = new LifeOpsService(buildRuntime());
    stubCapabilityDependencies(service, {
      browserSettingsError: new Error("settings offline"),
    });

    const status = await service.getCapabilityStatus(new Date(NOW));
    const browser = status.capabilities.find(
      (item) => item.id === "activity.browser",
    );

    expect(browser?.state).toBe("degraded");
    expect(browser?.summary).toBe("Browser status failed to load");
    expect(browser?.evidence[0]?.detail).toBe("settings offline");
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
