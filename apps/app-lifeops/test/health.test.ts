import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  GetLifeOpsHealthSummaryRequest,
  LifeOpsHealthMetric,
  LifeOpsHealthMetricSample,
  LifeOpsHealthSummaryResponse,
} from "../src/contracts/index.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("node:child_process");
  const { EventEmitter } = await import("node:events");
  const execFile = vi.fn(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb?: (
        err: NodeJS.ErrnoException | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      const callback =
        typeof _opts === "function"
          ? (_opts as (
              err: NodeJS.ErrnoException | null,
              s: string,
              e: string,
            ) => void)
          : cb;
      const err: NodeJS.ErrnoException = Object.assign(new Error("not found"), {
        code: "ENOENT",
      });
      callback?.(err, "", "");
      return new EventEmitter();
    },
  );
  return { ...actual, execFile, spawn: vi.fn() };
});

import { healthAction } from "../src/actions/health.js";
import {
  detectHealthBackend,
  getDailySummary,
  getDataPoints,
  HealthBridgeError,
} from "../src/lifeops/health-bridge.js";
import { createLifeOpsHealthMetricSample } from "../src/lifeops/repository.js";
import { withHealth } from "../src/lifeops/service-mixin-health.js";
import { LifeOpsServiceError } from "../src/lifeops/service-types.js";

const ORIGINAL_ENV = { ...process.env };
const SAME_ID = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (
      k.startsWith("ELIZA_HEALTHKIT") ||
      k.startsWith("ELIZA_GOOGLE_FIT") ||
      k === "ELIZA_TEST_HEALTH_BACKEND" ||
      k === "ELIZA_BENCHMARK_USE_MOCKS"
    ) {
      delete process.env[k];
    }
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("detectHealthBackend", () => {
  test('returns "none" when no env vars or binary configured', async () => {
    const backend = await detectHealthBackend();
    expect(backend).toBe("none");
  });

  test("does not enable fixture health data from benchmark mock mode", async () => {
    process.env.ELIZA_BENCHMARK_USE_MOCKS = "1";

    const backend = await detectHealthBackend();

    expect(backend).toBe("none");
  });

  test("enables fixture health data only through explicit health test backend", async () => {
    process.env.ELIZA_TEST_HEALTH_BACKEND = "fixture";

    const backend = await detectHealthBackend();

    expect(backend).toBe("fixture");
  });
});

describe("getDailySummary", () => {
  test('throws HealthBridgeError when backend is "none"', async () => {
    await expect(getDailySummary("2025-01-01")).rejects.toBeInstanceOf(
      HealthBridgeError,
    );
  });
});

describe("getDataPoints", () => {
  test("returns Google Fit sleep_hours points from sleep segment summaries", async () => {
    const originalFetch = globalThis.fetch;
    process.env.ELIZA_GOOGLE_FIT_ACCESS_TOKEN = "token";
    globalThis.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        aggregateBy?: Array<{ dataTypeName?: string }>;
        startTimeMillis?: number;
      };
      const isSleepQuery = body.aggregateBy?.some(
        (entry) => entry.dataTypeName === "com.google.sleep.segment",
      );
      if (!isSleepQuery) {
        return new Response(JSON.stringify({ bucket: [{ dataset: [] }] }), {
          status: 200,
        });
      }
      const startMs =
        typeof body.startTimeMillis === "number"
          ? body.startTimeMillis
          : Date.parse("2026-04-19T00:00:00.000Z");
      const sleepStartMs = startMs + 30 * 60 * 1_000;
      const sleepEndMs = sleepStartMs + 7.5 * 60 * 60 * 1_000;
      return new Response(
        JSON.stringify({
          bucket: [
            {
              dataset: [
                {
                  point: [
                    {
                      startTimeNanos: String(sleepStartMs * 1_000_000),
                      endTimeNanos: String(sleepEndMs * 1_000_000),
                      value: [{ intVal: 2 }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const points = await getDataPoints({
        metric: "sleep_hours",
        startAt: "2026-04-19T12:00:00.000Z",
        endAt: "2026-04-19T13:00:00.000Z",
      });

      expect(points).toEqual([
        {
          metric: "sleep_hours",
          value: 7.5,
          unit: "hours",
          startAt: "2026-04-19T00:00:00.000Z",
          endAt: "2026-04-19T23:59:59.999Z",
          source: "google-fit",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("withHealth mixin", () => {
  // Minimal stub base mimicking LifeOpsServiceBase fields the mixin uses.
  class StubBase {
    runtime = { agentId: "test", logger: console };
    ownerEntityId = null;
  }

  const ComposedHealth = withHealth(StubBase as never);
  // biome-ignore lint/suspicious/noExplicitAny: mixin stub
  const svc = new (ComposedHealth as any)();

  test("getHealthConnectorStatus reports available: false without backend", async () => {
    const status = await svc.getHealthConnectorStatus();
    expect(status.available).toBe(false);
    expect(status.backend).toBe("none");
    expect(typeof status.lastCheckedAt).toBe("string");
  });

  test("getHealthDailySummary translates HealthBridgeError to LifeOpsServiceError", async () => {
    await expect(
      svc.getHealthDailySummary("2025-01-01"),
    ).rejects.toBeInstanceOf(LifeOpsServiceError);
  });

  test("getHealthSummary aggregates connector samples without a real health device", async () => {
    const samples: LifeOpsHealthMetricSample[] = [
      metricSample("steps", 6000, "steps-1"),
      metricSample("steps", 4000, "steps-2"),
      metricSample("calories", 1400, "calories-1"),
      metricSample("calories", 1000, "calories-2"),
      metricSample("heart_rate", 60, "heart-1"),
      metricSample("heart_rate", 70, "heart-2"),
      metricSample("weight_kg", 72, "weight-1"),
      metricSample("weight_kg", 73, "weight-2"),
    ];
    const testRepository = {
      listConnectorGrants: vi.fn(async () => []),
      getConnectorGrant: vi.fn(async () => null),
      getHealthSyncState: vi.fn(async () => null),
      listHealthMetricSamples: vi.fn(async () => samples),
      listHealthWorkouts: vi.fn(async () => []),
      listHealthSleepEpisodes: vi.fn(async () => []),
    };
    class SummaryStubBase {
      runtime = { agentId: SAME_ID, logger: console };
      ownerEntityId = null;
      repository = testRepository;
      agentId() {
        return SAME_ID;
      }
    }
    const ComposedSummary = withHealth(SummaryStubBase as never);
    const summarySvc = new (
      ComposedSummary as new () => {
        getHealthSummary(
          request?: GetLifeOpsHealthSummaryRequest,
        ): Promise<LifeOpsHealthSummaryResponse>;
      }
    )();

    const summary = await summarySvc.getHealthSummary({
      startDate: "2026-04-20",
      endDate: "2026-04-20",
      metrics: ["steps", "calories", "heart_rate", "weight_kg"],
    });

    expect(testRepository.listHealthMetricSamples).toHaveBeenCalledWith(
      SAME_ID,
      {
        provider: undefined,
        startDate: "2026-04-20",
        endDate: "2026-04-20",
        metrics: ["steps", "calories", "heart_rate", "weight_kg"],
        limit: 2000,
      },
    );
    expect(summary.providers).toHaveLength(4);
    expect(summary.summaries).toEqual([
      expect.objectContaining({
        provider: "strava",
        date: "2026-04-20",
        steps: 10000,
        calories: 2400,
        heartRateAvg: 65,
        weightKg: 72.5,
      }),
    ]);
  });
});

function metricSample(
  metric: LifeOpsHealthMetric,
  value: number,
  sourceExternalId: string,
): LifeOpsHealthMetricSample {
  return createLifeOpsHealthMetricSample({
    agentId: SAME_ID,
    provider: "strava",
    grantId: "grant-strava",
    metric,
    value,
    unit: metric === "steps" ? "count" : "unit",
    startAt: "2026-04-20T12:00:00.000Z",
    endAt: "2026-04-20T12:00:00.000Z",
    localDate: "2026-04-20",
    sourceExternalId,
    metadata: {},
  });
}

describe("healthAction", () => {
  test("validate is owner-gated", async () => {
    const validate = healthAction.validate;
    if (!validate) {
      throw new Error("healthAction.validate is required");
    }
    const runtime = { agentId: SAME_ID } as unknown as Parameters<
      NonNullable<typeof healthAction.validate>
    >[0];
    const ownerMsg = {
      entityId: SAME_ID,
      content: { text: "" },
    } as unknown as Parameters<NonNullable<typeof healthAction.validate>>[1];
    expect(await validate(runtime, ownerMsg)).toBe(true);

    const otherMsg = {
      entityId: "00000000-0000-0000-0000-0000000000ff",
      content: { text: "" },
    } as unknown as Parameters<NonNullable<typeof healthAction.validate>>[1];
    expect(await validate(runtime, otherMsg)).toBe(false);
  });

  test("status subaction returns connector status text", async () => {
    const handler = healthAction.handler;
    if (!handler) {
      throw new Error("healthAction.handler is required");
    }
    const runtime = {
      agentId: SAME_ID,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
      },
    } as unknown as Parameters<NonNullable<typeof healthAction.handler>>[0];
    const message = {
      entityId: SAME_ID,
      roomId: "00000000-0000-0000-0000-000000000002",
      content: { text: "is health connected?" },
    } as unknown as Parameters<NonNullable<typeof healthAction.handler>>[1];

    const result = await handler(
      runtime,
      message,
      undefined,
      { parameters: { subaction: "status" } },
      undefined,
    );
    const r = result as {
      success: boolean;
      text: string;
      data?: { status?: { available?: boolean } };
    };
    expect(r.success).toBe(true);
    // Backend is "none" in this test, so the text says "No health backend".
    expect(r.text.toLowerCase()).toContain("health");
    expect(r.data?.status?.available).toBe(false);
  });
});
