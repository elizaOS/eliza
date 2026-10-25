/**
 * Verifies that HEALTH today/trend replies report a `sleepUnavailable` day as
 * unknown instead of fabricating a zero-sleep reading. The bridge contract on
 * `HealthDailySummary.sleepUnavailable` forbids presenting the placeholder
 * `sleepHours: 0` as a measured value; only the summary formatting and today
 * reply surfaces owned by `health.ts` are under test here, driven through the
 * real `createHealthActionRunner` handler with deterministic adapters and a
 * stub `HealthActionService`.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { LifeOpsHealthSummaryResponse } from "../contracts/health.js";
import {
  type CreateHealthActionRunnerOptions,
  createHealthActionRunner,
  type HealthActionService,
} from "./health.js";

const RUNTIME = {
  reportError: () => {},
  logger: { warn: () => {} },
} as unknown as IAgentRuntime;
const MESSAGE = {
  content: { text: "How did I sleep last night?" },
} as unknown as Memory;

function emptyConnectorSummary(): LifeOpsHealthSummaryResponse {
  return {
    providers: [],
    summaries: [],
    samples: [],
    workouts: [],
    sleepEpisodes: [],
    syncedAt: new Date().toISOString(),
  };
}

interface RenderedReply {
  fallback: string;
  context: Record<string, unknown> | undefined;
}

function buildHarness(service: HealthActionService) {
  const rendered: RenderedReply[] = [];
  const adapters: CreateHealthActionRunnerOptions = {
    hasAccess: async () => true,
    createService: () => service,
    messageText: (message) => String(message.content?.text ?? ""),
    resolveTimeZone: async () => "UTC",
    renderReply: async (args) => {
      rendered.push({ fallback: args.fallback, context: args.context });
      return { kind: "deferred", grounding: "health summary grounding" };
    },
    recentConversationTexts: async () => [],
    runJsonModel: async () => null,
  };
  const run = createHealthActionRunner(adapters);
  return {
    rendered,
    runOnce: async (
      subaction: "today" | "trend" | "by_metric",
      parameters: Record<string, unknown> = {},
    ) =>
      run(RUNTIME, MESSAGE, undefined as unknown as State, {
        parameters: { subaction, ...parameters },
      }),
  };
}

describe("HEALTH today/trend sleep-unavailable reporting", () => {
  it("today reports sleep unknown instead of a fabricated 0.0h reading", async () => {
    const harness = buildHarness({
      async getHealthDailySummary() {
        return {
          date: "2026-05-10",
          steps: 4200,
          activeMinutes: 30,
          sleepHours: 0,
          sleepUnavailable: true,
          source: "google-fit",
        };
      },
      async getHealthTrend() {
        return [];
      },
      async getHealthConnectorStatus() {
        return { available: true, backend: "google-fit" };
      },
      async getHealthSummary() {
        return emptyConnectorSummary();
      },
      async getHealthDataPoints() {
        return [];
      },
    });

    const result = await harness.runOnce("today");

    expect(result.success).toBe(true);
    const reply = harness.rendered[0];
    expect(reply.fallback).toContain(
      "- Sleep: unavailable (source error; sleep unknown for this day)",
    );
    expect(reply.fallback).not.toContain("Sleep: 0.0h");
    // The grounded-reply model reads `context`; the flag must survive so the
    // re-voiced reply cannot assert a fake zero as fact.
    expect(reply.context).toMatchObject({ sleepUnavailable: true });
    expect(result.values).toMatchObject({ sleepUnavailable: true });
  });

  it("today keeps a genuine zero-sleep day as a measured 0.0h value", async () => {
    const harness = buildHarness({
      async getHealthDailySummary() {
        return {
          date: "2026-05-10",
          steps: 4200,
          activeMinutes: 30,
          sleepHours: 0,
          source: "google-fit",
        };
      },
      async getHealthTrend() {
        return [];
      },
      async getHealthConnectorStatus() {
        return { available: true, backend: "google-fit" };
      },
      async getHealthSummary() {
        return emptyConnectorSummary();
      },
      async getHealthDataPoints() {
        return [];
      },
    });

    const result = await harness.runOnce("today");

    expect(result.success).toBe(true);
    expect(harness.rendered[0].fallback).toContain("- Sleep: 0.0h");
    expect(result.values).not.toHaveProperty("sleepUnavailable");
    expect(harness.rendered[0].context).not.toHaveProperty("sleepUnavailable");
  });

  it("trend marks the unavailable day unknown while genuine zeros stay numeric", async () => {
    const harness = buildHarness({
      async getHealthDailySummary() {
        throw new Error("not used");
      },
      async getHealthTrend() {
        return [
          {
            date: "2026-05-09",
            steps: 5000,
            activeMinutes: 20,
            sleepHours: 0,
            sleepUnavailable: true,
            source: "google-fit",
          },
          {
            date: "2026-05-10",
            steps: 3000,
            activeMinutes: 10,
            sleepHours: 0,
            source: "google-fit",
          },
        ];
      },
      async getHealthConnectorStatus() {
        return { available: true, backend: "google-fit" };
      },
      async getHealthSummary() {
        return emptyConnectorSummary();
      },
      async getHealthDataPoints() {
        return [];
      },
    });

    const result = await harness.runOnce("trend");

    expect(result.success).toBe(true);
    const fallback = harness.rendered[0].fallback;
    expect(fallback).toContain(
      "- Sleep: unavailable (source error; sleep unknown for this day)",
    );
    expect(fallback).toContain("- Sleep: 0.0h");
    // The unavailable day must never render its placeholder zero.
    const unavailableBlock = fallback.split("\n\n")[0];
    expect(unavailableBlock).toContain("2026-05-09");
    expect(unavailableBlock).not.toContain("Sleep: 0.0h");
  });
});

describe("HEALTH today on the connector path", () => {
  it("shows every provider's day and no 0 placeholders for metrics a provider did not send", async () => {
    const day = "2026-05-10";
    const sample = (
      provider: "strava" | "withings",
      metric: string,
      value: number,
    ) => ({
      id: `${provider}-${metric}`,
      agentId: "agent",
      provider,
      grantId: `${provider}-grant`,
      metric,
      value,
      unit: "",
      startAt: `${day}T00:00:00.000Z`,
      endAt: `${day}T23:59:59.000Z`,
      localDate: day,
      sourceExternalId: `${provider}-${metric}`,
      metadata: {},
      createdAt: `${day}T23:59:59.000Z`,
      updatedAt: `${day}T23:59:59.000Z`,
    });
    const row = (provider: "strava" | "withings") => ({
      date: day,
      provider,
      steps: 0,
      activeMinutes: 0,
      sleepHours: 0,
      calories: null,
      distanceMeters: null,
      heartRateAvg: null,
      restingHeartRate: null,
      hrvMs: null,
      sleepScore: null,
      readinessScore: null,
      weightKg: null,
      bloodPressureSystolic: null,
      bloodPressureDiastolic: null,
      bloodOxygenPercent: null,
    });
    const harness = buildHarness({
      async getHealthDailySummary() {
        throw new Error("the bridge is not used on the connector path");
      },
      async getHealthTrend() {
        return [];
      },
      async getHealthConnectorStatus() {
        return { available: false, backend: "none" };
      },
      async getHealthSummary() {
        return {
          ...emptyConnectorSummary(),
          providers: [
            { provider: "strava", connected: true },
            { provider: "withings", connected: true },
          ],
          summaries: [
            { ...row("strava"), activeMinutes: 45, distanceMeters: 20_000 },
            { ...row("withings"), steps: 8000, sleepHours: 7.2, weightKg: 80 },
          ],
          samples: [
            sample("strava", "active_minutes", 45),
            sample("strava", "distance_meters", 20_000),
            sample("withings", "steps", 8000),
            sample("withings", "sleep_hours", 7.2),
            sample("withings", "weight_kg", 80),
          ],
        } as unknown as LifeOpsHealthSummaryResponse;
      },
      async getHealthDataPoints() {
        return [];
      },
    });

    await harness.runOnce("today", { date: day });

    const reply = harness.rendered[0];
    expect(reply.fallback).toContain("- Steps: 8,000");
    expect(reply.fallback).toContain("- Sleep: 7.2h");
    expect(reply.fallback).toContain("- Weight: 80.0 kg");
    expect(reply.fallback).toContain("- Distance: 20.00 km");
    expect(reply.fallback).not.toContain("- Steps: 0");
    expect(reply.fallback).not.toContain("- Sleep: 0.0h");
  });
});

describe("HEALTH by_metric on the connector path", () => {
  it("reports each provider's total instead of adding providers together", async () => {
    // A Fitbit day total includes the run Strava also reports.
    const sample = (provider: "strava" | "fitbit", value: number) => ({
      id: `${provider}-distance`,
      agentId: "agent",
      provider,
      grantId: `${provider}-grant`,
      metric: "distance_meters",
      value,
      unit: "m",
      startAt: "2026-05-10T00:00:00.000Z",
      endAt: "2026-05-10T23:59:59.000Z",
      localDate: "2026-05-10",
      sourceExternalId: `${provider}-1`,
      metadata: {},
      createdAt: "2026-05-10T23:59:59.000Z",
      updatedAt: "2026-05-10T23:59:59.000Z",
    });
    const harness = buildHarness({
      async getHealthDailySummary() {
        throw new Error("the bridge is not used on the connector path");
      },
      async getHealthTrend() {
        return [];
      },
      async getHealthConnectorStatus() {
        return { available: false, backend: "none" };
      },
      async getHealthSummary() {
        return {
          ...emptyConnectorSummary(),
          providers: [
            { provider: "strava", connected: true },
            { provider: "fitbit", connected: true },
          ],
          samples: [sample("strava", 10_000), sample("fitbit", 14_000)],
        } as unknown as LifeOpsHealthSummaryResponse;
      },
      async getHealthDataPoints() {
        return [];
      },
    });

    await harness.runOnce("by_metric", {
      metric: "distance_meters",
      date: "2026-05-10",
    });

    const reply = harness.rendered[0];
    expect(reply.fallback).toContain("strava total 10000.00 m");
    expect(reply.fallback).toContain("fitbit total 14000.00 m");
    expect(reply.fallback).not.toContain("24000");
  });
});
