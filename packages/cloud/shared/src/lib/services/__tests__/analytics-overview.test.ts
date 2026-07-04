// Exercises analytics overview behavior with deterministic cloud-shared lib fixtures.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realUsageRecords from "../../../db/repositories/usage-records";
import * as realCacheClient from "../../cache/client";

const REAL_USAGE_RECORDS = { ...realUsageRecords };
const REAL_CACHE_CLIENT = { ...realCacheClient };

const getStatsByOrganization = mock();
const getUsageTimeSeries = mock();
const getProviderBreakdown = mock();
const getModelBreakdown = mock();
const getTrendData = mock();

mock.module("../../../db/repositories/usage-records", () => ({
  ...REAL_USAGE_RECORDS,
  usageRecordsRepository: {
    getStatsByOrganization,
    getUsageTimeSeries,
    getProviderBreakdown,
    getModelBreakdown,
    getTrendData,
  },
}));

type SwrLoader<T> = () => Promise<T>;

async function loadThroughCache<T>(
  _cacheKey: string,
  _ttl: number,
  loader: SwrLoader<T>,
): Promise<T | null> {
  return loader();
}

async function cacheMiss<T>(): Promise<T | null> {
  return null;
}

const getWithSWR = mock(loadThroughCache);

mock.module("../../cache/client", () => ({
  ...REAL_CACHE_CLIENT,
  cache: {
    ...REAL_CACHE_CLIENT.cache,
    getWithSWR,
  },
}));

const { AnalyticsService } = await import("../analytics");

afterAll(() => {
  mock.module("../../../db/repositories/usage-records", () => REAL_USAGE_RECORDS);
  mock.module("../../cache/client", () => REAL_CACHE_CLIENT);
});

const summary = {
  totalRequests: 20,
  totalCost: 10,
  totalInputTokens: 100,
  totalOutputTokens: 300,
  successRate: 0.75,
};

const trendData = {
  requestsChange: 1.2,
  costChange: 2.3,
  tokensChange: 3.4,
  successRateChange: 4.5,
  period: "daily",
};

function mockRepositoryResults(): void {
  getStatsByOrganization.mockResolvedValue(summary);
  getUsageTimeSeries.mockResolvedValue([
    {
      timestamp: new Date("2026-06-24T12:00:00.000Z"),
      totalRequests: 20,
      totalCost: 10,
      inputTokens: 100,
      outputTokens: 300,
    },
  ]);
  getProviderBreakdown.mockResolvedValue([
    {
      provider: "openai",
      totalRequests: 20,
      totalCost: 10,
      totalTokens: 400,
      percentage: 100,
    },
  ]);
  getModelBreakdown.mockResolvedValue([
    {
      model: "gpt-test",
      totalRequests: 20,
      totalCost: 10,
      totalTokens: 400,
    },
  ]);
  getTrendData.mockResolvedValue(trendData);
}

async function getOverviewSummary(cacheMode: "loader" | "miss") {
  getWithSWR.mockImplementation(cacheMode === "loader" ? loadThroughCache : cacheMiss);

  const service = new AnalyticsService();
  const overview = await service.getOverview("org-1", "daily");

  return overview.summary;
}

beforeEach(() => {
  getStatsByOrganization.mockReset();
  getUsageTimeSeries.mockReset();
  getProviderBreakdown.mockReset();
  getModelBreakdown.mockReset();
  getTrendData.mockReset();
  getWithSWR.mockReset();
  mockRepositoryResults();
});

describe("AnalyticsService.getOverview", () => {
  test("cached loader path returns only derived summary fields", async () => {
    const overviewSummary = await getOverviewSummary("loader");

    expect(overviewSummary).toEqual({
      totalRequests: 20,
      totalCost: 10,
      totalTokens: 400,
      successRate: 0.75,
      avgCostPerRequest: 0.5,
    });
    expect("avgLatency" in overviewSummary).toBe(false);
    expect("activeApiKeys" in overviewSummary).toBe(false);
  });

  test("cache-miss fallback path returns only derived summary fields", async () => {
    const overviewSummary = await getOverviewSummary("miss");

    expect(overviewSummary).toEqual({
      totalRequests: 20,
      totalCost: 10,
      totalTokens: 400,
      successRate: 0.75,
      avgCostPerRequest: 0.5,
    });
    expect("avgLatency" in overviewSummary).toBe(false);
    expect("activeApiKeys" in overviewSummary).toBe(false);
  });
});
