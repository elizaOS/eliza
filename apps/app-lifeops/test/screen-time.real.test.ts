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
    await service.recordScreenTimeEvent({
      source: "app",
      identifier: "com.summary.SafariX",
      displayName: "SafariX",
      startAt: new Date(baseMs).toISOString(),
      endAt: new Date(baseMs + 600_000).toISOString(),
      durationSeconds: 600,
      metadata: {},
    });
    await service.recordScreenTimeEvent({
      source: "app",
      identifier: "com.summary.ChromeX",
      displayName: "ChromeX",
      startAt: new Date(baseMs + 700_000).toISOString(),
      endAt: new Date(baseMs + 1_000_000).toISOString(),
      durationSeconds: 300,
      metadata: {},
    });
    await service.recordScreenTimeEvent({
      source: "app",
      identifier: "com.summary.VSCodeX",
      displayName: "VSCodeX",
      startAt: new Date(baseMs + 1_100_000).toISOString(),
      endAt: new Date(baseMs + 2_300_000).toISOString(),
      durationSeconds: 1200,
      metadata: {},
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
