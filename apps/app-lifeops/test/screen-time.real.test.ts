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
} from "../../../../test/helpers/real-runtime";
import { insertActivityEvent } from "../src/activity-profile/activity-tracker-repo.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import { screenTimeAction } from "../src/actions/screen-time.js";

const AGENT_ID = "lifeops-screentime-agent";

function makeMessage(runtime: IAgentRuntime, text: string) {
  return {
    id: `msg-${Math.random()}` as unknown as string,
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    content: { text },
  };
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
    expect(safari).toBeTruthy();
    expect(safari!.totalSeconds).toBeGreaterThanOrEqual(1200);
    expect(safari!.sessionCount).toBeGreaterThanOrEqual(2);
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
    const result = await screenTimeAction.handler!(
      runtime,
      makeMessage(runtime, "screen time today") as never,
      undefined,
      { parameters: { subaction: "today", date: today } } as never,
      async () => {},
    );
    expect(result?.success).toBe(true);
    expect(typeof (result as unknown as { text?: string }).text).toBe("string");
    const data = (result as unknown as { data?: { date?: string } }).data;
    expect(data?.date).toBe(today);
  });

  it("screenTimeAction summary handler returns ranked items", async () => {
    const result = await screenTimeAction.handler!(
      runtime,
      makeMessage(runtime, "screen time summary") as never,
      undefined,
      { parameters: { subaction: "summary", sinceDays: 7 } } as never,
      async () => {},
    );
    expect(result?.success).toBe(true);
    const data = (
      result as unknown as {
        data?: { summary?: { items: unknown[]; totalSeconds: number } };
      }
    ).data;
    expect(Array.isArray(data?.summary?.items)).toBe(true);
  });
});
