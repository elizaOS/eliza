/**
 * `date` is read by both `today` and `by_metric`. A value that is not a real
 * calendar day must be refused before any health read on `today`, as it is on
 * `by_metric`. Otherwise the connector summary rejects it, the handler logs
 * the failure and the reply says no health data source is connected (or the
 * bridge is asked for a day that does not exist). Driven through the real
 * `createHealthActionRunner` handler on a real runtime with a recording
 * `HealthActionService`.
 */
import type { AgentRuntime, Memory, State } from "@elizaos/core";
import { createRealTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LifeOpsHealthSummaryResponse } from "../contracts/health.js";
import {
  type CreateHealthActionRunnerOptions,
  createHealthActionRunner,
  type HealthActionService,
} from "./health.js";

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ runtime, cleanup } = await createRealTestRuntime({ withLLM: false }));
}, 180_000);

afterAll(async () => {
  await cleanup?.();
});

const MESSAGE = {
  content: { text: "How did I sleep on February 30?" },
} as Memory;

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

function buildHarness(bridgeAvailable: boolean) {
  const reads: { method: string; arg: unknown }[] = [];
  const scenarios: string[] = [];
  const service: HealthActionService = {
    async getHealthConnectorStatus() {
      reads.push({ method: "getHealthConnectorStatus", arg: undefined });
      return bridgeAvailable
        ? { available: true, backend: "healthkit" }
        : { available: false, backend: "none" };
    },
    async getHealthSummary(request) {
      reads.push({ method: "getHealthSummary", arg: request });
      return emptyConnectorSummary();
    },
    async getHealthTrend() {
      reads.push({ method: "getHealthTrend", arg: undefined });
      return [];
    },
    async getHealthDataPoints() {
      reads.push({ method: "getHealthDataPoints", arg: undefined });
      return [];
    },
    async getHealthDailySummary(date) {
      reads.push({ method: "getHealthDailySummary", arg: date });
      return {
        date,
        steps: 4200,
        activeMinutes: 30,
        sleepHours: 7,
        source: "healthkit",
      };
    },
  };
  const adapters: CreateHealthActionRunnerOptions = {
    hasAccess: async () => true,
    createService: () => service,
    messageText: (message) => String(message.content?.text ?? ""),
    resolveTimeZone: async () => "America/Los_Angeles",
    renderReply: async (args) => {
      scenarios.push(args.scenario);
      return { kind: "deferred", grounding: "health today grounding" };
    },
    recentConversationTexts: async () => [],
    runJsonModel: async () => null,
  };
  const run = createHealthActionRunner(adapters);
  return {
    reads,
    scenarios,
    today: (date: string) =>
      run(runtime, MESSAGE, undefined as State | undefined, {
        parameters: { subaction: "today", date },
      }),
  };
}

describe("HEALTH today with a date that is not a calendar day", () => {
  for (const bridgeAvailable of [true, false]) {
    const path = bridgeAvailable ? "bridge" : "connector";
    for (const date of ["2026-02-30", "2026-5-9"]) {
      it(`refuses ${date} before any read on the ${path} path`, async () => {
        const harness = buildHarness(bridgeAvailable);

        const result = await harness.today(date);

        expect(result.success).toBe(false);
        expect(result.data).toMatchObject({ error: "INVALID_DATE" });
        expect(harness.scenarios).toEqual(["health_invalid_date"]);
        expect(harness.reads).toEqual([]);
      });
    }
  }

  it("still reads a real calendar day", async () => {
    const harness = buildHarness(true);

    const result = await harness.today("2026-02-28");

    expect(result.success).toBe(true);
    expect(harness.scenarios).toEqual(["health_today"]);
    expect(harness.reads).toContainEqual({
      method: "getHealthSummary",
      arg: { startDate: "2026-02-28", endDate: "2026-02-28" },
    });
    expect(harness.reads).toContainEqual({
      method: "getHealthDailySummary",
      arg: "2026-02-28",
    });
  });
});
