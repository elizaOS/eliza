import { beforeEach, describe, expect, mock, test } from "bun:test";

const stats = {
  totalRequests: 4,
  totalInputTokens: 120,
  totalOutputTokens: 80,
  totalCost: 2,
  successRate: 0.75,
};

const timeSeries = [
  {
    timestamp: new Date("2026-06-24T00:00:00.000Z"),
    totalRequests: 4,
    totalCost: 2,
    inputTokens: 120,
    outputTokens: 80,
    successRate: 0.75,
  },
];

const providerBreakdown = [
  {
    provider: "openai",
    totalRequests: 4,
    totalCost: 2,
    totalTokens: 200,
    successRate: 0.75,
    percentage: 100,
  },
];

const modelBreakdown = [
  {
    model: "gpt-4.1-mini",
    provider: "openai",
    totalRequests: 4,
    totalCost: 2,
    totalTokens: 200,
    avgCostPerToken: 0.01,
    successRate: 0.75,
  },
];

const trends = {
  requestsChange: 10,
  costChange: 20,
  tokensChange: 30,
  successRateChange: 40,
  period: "7d",
};

const getStatsByOrganization = mock(async () => stats);
const getUsageTimeSeries = mock(async () => timeSeries);
const getProviderBreakdown = mock(async () => providerBreakdown);
const getModelBreakdown = mock(async () => modelBreakdown);
const getTrendData = mock(async () => trends);
const getWithSWR = mock(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());

mock.module("../../../db/repositories/usage-records", () => ({
  usageRecordsRepository: {
    getStatsByOrganization,
    getUsageTimeSeries,
    getProviderBreakdown,
    getModelBreakdown,
    getTrendData,
  },
}));

mock.module("../../cache/client", () => ({
  cache: {
    getWithSWR,
  },
}));

import { analyticsService } from "../analytics";

function resetMocks() {
  getStatsByOrganization.mockReset();
  getUsageTimeSeries.mockReset();
  getProviderBreakdown.mockReset();
  getModelBreakdown.mockReset();
  getTrendData.mockReset();
  getWithSWR.mockReset();

  getStatsByOrganization.mockResolvedValue(stats);
  getUsageTimeSeries.mockResolvedValue(timeSeries);
  getProviderBreakdown.mockResolvedValue(providerBreakdown);
  getModelBreakdown.mockResolvedValue(modelBreakdown);
  getTrendData.mockResolvedValue(trends);
  getWithSWR.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) =>
    load(),
  );
}

const expectedSummary = {
  totalRequests: 4,
  totalCost: 2,
  totalTokens: 200,
  successRate: 0.75,
  avgCostPerRequest: 0.5,
};

describe("AnalyticsService.getOverview", () => {
  beforeEach(resetMocks);

  test("returns only derived summary metrics from the cached loader path", async () => {
    const overview = await analyticsService.getOverview("org-1", "weekly");

    expect(overview.summary).toEqual(expectedSummary);
    expect("avgLatency" in overview.summary).toBe(false);
    expect("activeApiKeys" in overview.summary).toBe(false);
    expect(getWithSWR).toHaveBeenCalledTimes(1);
  });

  test("returns the same summary contract when the cache lookup misses", async () => {
    getWithSWR.mockResolvedValueOnce(null);

    const overview = await analyticsService.getOverview("org-1", "weekly");

    expect(overview.summary).toEqual(expectedSummary);
    expect("avgLatency" in overview.summary).toBe(false);
    expect("activeApiKeys" in overview.summary).toBe(false);
    expect(getStatsByOrganization).toHaveBeenCalledTimes(1);
  });
});
