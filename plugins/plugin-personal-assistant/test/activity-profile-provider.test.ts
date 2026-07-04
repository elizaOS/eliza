/**
 * Covers the activity-profile provider's app-usage context: formatting the current
 * foreground app and today's top-app dwell, injecting ambient usage for owner turns, and
 * withholding it for non-owner turns. Deterministic, mocked activity repo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(),
  getActivityReportBetween: vi.fn(),
  getLatestForegroundActivity: vi.fn(),
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

vi.mock("@elizaos/core", () => ({
  formatError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  logger: mocks.logger,
}));

vi.mock("../src/lifeops/defaults.js", () => ({
  resolveDefaultTimeZone: () => "UTC",
}));

vi.mock("../src/activity-profile/proactive-worker.js", () => ({
  PROACTIVE_TASK_TAGS: ["queue", "repeat", "proactive"],
}));

vi.mock("../src/activity-profile/service.js", () => ({
  readProfileFromMetadata: vi.fn(() => null),
}));

vi.mock("../src/activity-profile/activity-tracker-reporting.js", () => ({
  getActivityReportBetween: mocks.getActivityReportBetween,
  getLatestForegroundActivity: mocks.getLatestForegroundActivity,
}));

import {
  activityProfileProvider,
  formatActivityUsageContext,
} from "../src/providers/activity-profile.js";

const NOW_ISO = "2026-01-15T18:30:00.000Z";

function makeRuntime() {
  return {
    agentId: "agent-activity",
    getTasks: vi.fn(async () => []),
  };
}

function makeMessage() {
  return {
    id: "msg-activity",
    entityId: "owner",
    roomId: "room",
    content: { text: "what am I working on?" },
  };
}

describe("activityProfileProvider app-usage context", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    mocks.hasOwnerAccess.mockReset().mockResolvedValue(true);
    mocks.getActivityReportBetween.mockReset().mockResolvedValue({
      sinceMs: Date.parse("2026-01-15T08:00:00.000Z"),
      untilMs: Date.parse(NOW_ISO),
      totalMs: 9_000_000,
      apps: [
        {
          bundleId: "com.microsoft.VSCode",
          appName: "VS Code",
          totalMs: 7_200_000,
          sessionCount: 2,
          sampleWindowTitles: [],
        },
        {
          bundleId: "com.tinyspeck.slackmacgap",
          appName: "Slack",
          totalMs: 1_800_000,
          sessionCount: 1,
          sampleWindowTitles: [],
        },
      ],
    });
    mocks.getLatestForegroundActivity.mockReset().mockResolvedValue({
      bundleId: "com.microsoft.VSCode",
      appName: "VS Code",
      observedAtMs: Date.parse("2026-01-15T18:00:00.000Z"),
      activeMs: 1_800_000,
    });
    mocks.logger.debug.mockReset();
    mocks.logger.warn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats current foreground app and today's top app dwell", () => {
    const text = formatActivityUsageContext({
      current: {
        bundleId: "com.microsoft.VSCode",
        appName: "VS Code",
        observedAtMs: Date.parse("2026-01-15T18:00:00.000Z"),
        activeMs: 1_800_000,
      },
      report: {
        sinceMs: Date.parse("2026-01-15T08:00:00.000Z"),
        untilMs: Date.parse(NOW_ISO),
        totalMs: 9_000_000,
        apps: [
          {
            bundleId: "com.microsoft.VSCode",
            appName: "VS Code",
            totalMs: 7_200_000,
            sessionCount: 2,
            sampleWindowTitles: [],
          },
          {
            bundleId: "com.tinyspeck.slackmacgap",
            appName: "Slack",
            totalMs: 1_800_000,
            sessionCount: 1,
            sampleWindowTitles: [],
          },
        ],
      },
    });

    expect(text).toBe(
      "current app VS Code for 30m | today apps VS Code 2h, Slack 30m",
    );
  });

  it("injects ambient app usage for owner turns", async () => {
    const runtime = makeRuntime();
    const result = await activityProfileProvider.get(
      runtime as never,
      makeMessage() as never,
      {} as never,
    );

    expect(result.text).toContain("current app VS Code for 30m");
    expect(result.text).toContain("today apps VS Code 2h, Slack 30m");
    expect(result.values?.userCurrentAppName).toBe("VS Code");
    expect(result.values?.userTodayAppUsageTotalMs).toBe(9_000_000);
    expect(result.values?.userTodayAppUsage).toEqual([
      {
        appName: "VS Code",
        bundleId: "com.microsoft.VSCode",
        totalMs: 7_200_000,
        sessionCount: 2,
      },
      {
        appName: "Slack",
        bundleId: "com.tinyspeck.slackmacgap",
        totalMs: 1_800_000,
        sessionCount: 1,
      },
    ]);
    expect(mocks.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: "activity_profile",
        operation: "provider_activity_usage_context",
        currentAppPresent: true,
        topAppCount: 2,
      }),
      "[activity-profile] Injected ambient app-usage context.",
    );
  });

  it("does not read app usage for non-owner turns", async () => {
    mocks.hasOwnerAccess.mockResolvedValueOnce(false);

    const result = await activityProfileProvider.get(
      makeRuntime() as never,
      makeMessage() as never,
      {} as never,
    );

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(mocks.getActivityReportBetween).not.toHaveBeenCalled();
    expect(mocks.getLatestForegroundActivity).not.toHaveBeenCalled();
  });

  it("keeps base context when app usage read fails", async () => {
    mocks.getActivityReportBetween.mockRejectedValueOnce(
      new Error("activity table unavailable"),
    );

    const result = await activityProfileProvider.get(
      makeRuntime() as never,
      makeMessage() as never,
      {} as never,
    );

    expect(result.text).toContain("User context:");
    expect(result.values?.userCurrentAppName).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: "activity_profile",
        operation: "provider_activity_usage_read",
      }),
      "[activity-profile] Failed to read ambient app-usage context; continuing without app-usage context.",
    );
  });
});
