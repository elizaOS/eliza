/**
 * LifeOps screen-time integration tests against a real PGLite runtime.
 *
 * Exercises LifeOpsService screen-time recording, daily aggregation, summary,
 * and the SCREEN_TIME action handler end-to-end. No SQL mocks, no LLM.
 */

import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/real-runtime";
import { screenTimeAction } from "../src/actions/screen-time.js";
import { insertActivityEvent } from "../src/activity-profile/activity-tracker-repo.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";

const AGENT_ID = "lifeops-screentime-agent";
const DAY_MS = 24 * 60 * 60_000;

function makeMessage(runtime: IAgentRuntime, text: string) {
  return {
    id: `msg-${Math.random()}` as string,
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    content: { text },
  };
}

function requireScreenTimeHandler() {
  const handler = screenTimeAction.handler;
  if (!handler) {
    throw new Error("SCREEN_TIME action handler is required");
  }
  return handler;
}

describe("screen-time handler — real PGLite", () => {
  let runtime: AgentRuntime;
  let service: LifeOpsService;
  let testResult: RealTestRuntimeResult;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({ characterName: AGENT_ID });
    runtime = testResult.runtime;
    await LifeOpsRepository.bootstrapSchema(runtime);
    service = new LifeOpsService(runtime);
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("recordScreenTimeEvent inserts a session", async () => {
    const session = await service.recordScreenTimeEvent({
      source: "app",
      identifier: "com.apple.Safari",
      displayName: "Safari",
      startAt: new Date(Date.now() - 600_000).toISOString(),
      endAt: new Date().toISOString(),
      durationSeconds: 600,
      metadata: {},
    });
    expect(session.id).toBeTruthy();
    expect(session.durationSeconds).toBe(600);
  });

  it("aggregateDailyForDate rolls sessions into daily totals", async () => {
    // Use a fixed historical date so this test does not collide with the
    // session inserted above, and so the daily total is deterministic.
    const dateBase = new Date("2025-01-15T00:00:00.000Z");
    const date = dateBase.toISOString().slice(0, 10);
    await service.recordScreenTimeEvent({
      source: "app",
      identifier: "com.apple.SafariAggTest",
      displayName: "SafariAggTest",
      startAt: new Date(dateBase.getTime() + 3_600_000).toISOString(),
      endAt: new Date(dateBase.getTime() + 4_200_000).toISOString(),
      durationSeconds: 600,
      metadata: {},
    });
    await service.recordScreenTimeEvent({
      source: "app",
      identifier: "com.apple.SafariAggTest",
      displayName: "SafariAggTest",
      startAt: new Date(dateBase.getTime() + 7_200_000).toISOString(),
      endAt: new Date(dateBase.getTime() + 7_800_000).toISOString(),
      durationSeconds: 600,
      metadata: {},
    });
    await service.aggregateDailyForDate(date);
    const daily = await service.getScreenTimeDaily({ date });
    const safari = daily.find(
      (d) => d.identifier === "com.apple.SafariAggTest",
    );
    if (!safari) {
      throw new Error("Expected Safari aggregate row");
    }
    expect(safari.totalSeconds).toBeGreaterThanOrEqual(1200);
    expect(safari.sessionCount).toBeGreaterThanOrEqual(2);
  });

  it("getScreenTimeSummary returns top apps in descending order", async () => {
    const baseMs = Date.now() - 3 * 3_600_000;
    await insertActivityEvent(runtime, {
      agentId: String(runtime.agentId),
      observedAt: new Date(baseMs).toISOString(),
      eventKind: "activate",
      bundleId: "com.summary.SafariX",
      appName: "SafariX",
      windowTitle: null,
    });
    await insertActivityEvent(runtime, {
      agentId: String(runtime.agentId),
      observedAt: new Date(baseMs + 600_000).toISOString(),
      eventKind: "activate",
      bundleId: "com.summary.ChromeX",
      appName: "ChromeX",
      windowTitle: null,
    });
    await insertActivityEvent(runtime, {
      agentId: String(runtime.agentId),
      observedAt: new Date(baseMs + 900_000).toISOString(),
      eventKind: "activate",
      bundleId: "com.summary.VSCodeX",
      appName: "VSCodeX",
      windowTitle: null,
    });
    await insertActivityEvent(runtime, {
      agentId: String(runtime.agentId),
      observedAt: new Date(baseMs + 2_100_000).toISOString(),
      eventKind: "deactivate",
      bundleId: "com.summary.VSCodeX",
      appName: "VSCodeX",
      windowTitle: null,
    });
    const since = new Date(baseMs - 60_000).toISOString();
    const until = new Date().toISOString();
    const summary = await service.getScreenTimeSummary({
      since,
      until,
      source: "app",
      topN: 2,
    });
    const summaryIds = summary.items.map((i) => i.identifier);
    expect(summaryIds).toContain("com.summary.VSCodeX");
    // VSCode (1200) should rank above Chrome (300); top-2 must include VSCode first.
    expect(summary.items[0].identifier).toBe("com.summary.VSCodeX");
    expect(summary.items.length).toBe(2);
  });

  it("excludes OS login surfaces from app screen-time summaries", async () => {
    const startAt = new Date("2025-01-16T01:00:00.000Z");
    const endAt = new Date("2025-01-16T01:30:00.000Z");
    await service.recordScreenTimeEvent({
      source: "app",
      identifier: "com.apple.loginwindow",
      displayName: "loginwindow",
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      durationSeconds: 30 * 60,
      metadata: { platform: "darwin" },
    });
    await service.recordScreenTimeEvent({
      source: "app",
      identifier: "com.summary.RealEditor",
      displayName: "RealEditor",
      startAt: new Date("2025-01-16T02:00:00.000Z").toISOString(),
      endAt: new Date("2025-01-16T02:20:00.000Z").toISOString(),
      durationSeconds: 20 * 60,
      metadata: {},
    });

    const summary = await service.getScreenTimeSummary({
      since: "2025-01-16T00:00:00.000Z",
      until: "2025-01-16T03:00:00.000Z",
      source: "app",
      topN: 10,
    });

    expect(summary.items.map((item) => item.identifier)).not.toContain(
      "com.apple.loginwindow",
    );
    expect(summary.items.map((item) => item.identifier)).toContain(
      "com.summary.RealEditor",
    );
  });

  it("getScreenTimeWeeklyAverageByApp returns structured per-day averages", async () => {
    const weekStart = Date.parse("2025-02-03T00:00:00.000Z");
    const weekEnd = weekStart + 7 * DAY_MS;

    for (let day = 0; day < 7; day += 1) {
      const dayStart = weekStart + day * DAY_MS;
      await service.recordScreenTimeEvent({
        source: "app",
        identifier: "com.weekly.VSCode",
        displayName: "VS Code",
        startAt: new Date(dayStart + 30 * 60_000).toISOString(),
        endAt: new Date(dayStart + 90 * 60_000).toISOString(),
        durationSeconds: 60 * 60,
        metadata: {},
      });
      await service.recordScreenTimeEvent({
        source: "app",
        identifier: "com.weekly.Safari",
        displayName: "Safari",
        startAt: new Date(dayStart + 150 * 60_000).toISOString(),
        endAt: new Date(dayStart + 180 * 60_000).toISOString(),
        durationSeconds: 30 * 60,
        metadata: {},
      });
    }

    const weeklyAverage = await service.getScreenTimeWeeklyAverageByApp({
      since: new Date(weekStart).toISOString(),
      until: new Date(weekEnd).toISOString(),
      daysInWindow: 7,
      topN: 10,
    });

    expect(weeklyAverage.daysInWindow).toBe(7);
    expect(weeklyAverage.totalSeconds).toBe(7 * 90 * 60);
    const vscode = weeklyAverage.items.find(
      (item) => item.identifier === "com.weekly.VSCode",
    );
    const safari = weeklyAverage.items.find(
      (item) => item.identifier === "com.weekly.Safari",
    );
    expect(vscode?.averageSecondsPerDay).toBe(60 * 60);
    expect(vscode?.averageMinutesPerDay).toBe(60);
    expect(safari?.averageSecondsPerDay).toBe(30 * 60);
    expect(safari?.averageMinutesPerDay).toBe(30);
  });

  it("SCREEN_TIME weekly_average_by_app returns structured action data", async () => {
    const now = Date.now();
    const weekStart = now - 7 * DAY_MS;

    for (let day = 0; day < 7; day += 1) {
      const dayStart = weekStart + day * DAY_MS;
      await service.recordScreenTimeEvent({
        source: "app",
        identifier: "com.action.VSCode",
        displayName: "VS Code",
        startAt: new Date(dayStart + 15 * 60_000).toISOString(),
        endAt: new Date(dayStart + 75 * 60_000).toISOString(),
        durationSeconds: 60 * 60,
        metadata: {},
      });
    }

    const result = await requireScreenTimeHandler()(
      runtime,
      makeMessage(runtime, "What's my weekly average per app?") as never,
      undefined,
      {
        parameters: {
          subaction: "weekly_average_by_app",
          sinceDays: 7,
        },
      },
      async () => undefined,
    );

    expect(result.success).toBe(true);
    const data = result.data as
      | {
          subaction?: string;
          weeklyAverage?: {
            daysInWindow?: number;
            items?: Array<{
              identifier?: string;
              averageSecondsPerDay?: number;
            }>;
          };
        }
      | undefined;
    expect(data?.subaction).toBe("weekly_average_by_app");
    const weeklyAverage = data?.weeklyAverage;
    expect(weeklyAverage?.daysInWindow).toBe(7);
    expect(
      weeklyAverage?.items?.find(
        (item) => item.identifier === "com.action.VSCode",
      )?.averageSecondsPerDay,
    ).toBe(60 * 60);
  });

  it("syncBrowserState persists website focus windows into screen time summaries", async () => {
    const startAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const endAt = new Date(Date.now() - 6 * 60_000).toISOString();

    await service.updateBrowserSettings({
      enabled: true,
      allowBrowserControl: true,
    });

    await service.syncBrowserState({
      companion: {
        browser: "chrome",
        profileId: "screen-time-profile",
        label: "LifeOps Browser",
        connectionState: "connected",
        lastSeenAt: startAt,
        permissions: {
          tabs: true,
          scripting: true,
          activeTab: true,
          allOrigins: true,
          grantedOrigins: ["https://github.com"],
          incognitoEnabled: false,
        },
      },
      tabs: [
        {
          browser: "chrome",
          profileId: "screen-time-profile",
          windowId: "window-1",
          tabId: "tab-1",
          url: "https://github.com/elizaos/elizaos",
          title: "elizaOS",
          activeInWindow: true,
          focusedWindow: true,
          focusedActive: true,
          lastSeenAt: startAt,
          lastFocusedAt: startAt,
        },
      ],
      pageContexts: [],
    });

    await service.syncBrowserState({
      companion: {
        browser: "chrome",
        profileId: "screen-time-profile",
        label: "LifeOps Browser",
        connectionState: "connected",
        lastSeenAt: endAt,
        permissions: {
          tabs: true,
          scripting: true,
          activeTab: true,
          allOrigins: true,
          grantedOrigins: ["https://github.com"],
          incognitoEnabled: false,
        },
      },
      tabs: [
        {
          browser: "chrome",
          profileId: "screen-time-profile",
          windowId: "window-1",
          tabId: "tab-2",
          url: "https://news.ycombinator.com",
          title: "Hacker News",
          activeInWindow: true,
          focusedWindow: true,
          focusedActive: true,
          lastSeenAt: endAt,
          lastFocusedAt: endAt,
        },
      ],
      pageContexts: [],
    });

    const summary = await service.getScreenTimeSummary({
      since: new Date(Date.now() - 30 * 60_000).toISOString(),
      until: new Date().toISOString(),
      source: "website",
      topN: 5,
    });

    expect(summary.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "website",
          identifier: "github.com",
        }),
      ]),
    );
  });

  it("screenTimeAction today handler returns text and data", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = await requireScreenTimeHandler()(
      runtime,
      makeMessage(runtime, "screen time today") as never,
      undefined,
      { parameters: { subaction: "today", date: today } } as never,
      async () => {},
    );
    expect(result?.success).toBe(true);
    expect(typeof (result as { text?: string }).text).toBe("string");
    const data = (result as { data?: { date?: string } }).data;
    expect(data?.date).toBe(today);
  });

  it("screenTimeAction summary handler returns ranked items", async () => {
    const result = await requireScreenTimeHandler()(
      runtime,
      makeMessage(runtime, "screen time summary") as never,
      undefined,
      { parameters: { subaction: "summary", sinceDays: 7 } } as never,
      async () => {},
    );
    expect(result?.success).toBe(true);
    const data = (
      result as {
        data?: { summary?: { items: unknown[]; totalSeconds: number } };
      }
    ).data;
    expect(Array.isArray(data?.summary?.items)).toBe(true);
  });
});
