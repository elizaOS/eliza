/**
 * An explicit analytics maxRows of 0 is an empty page. `maxRows &&` treated 0
 * as no cap and returned the full series.
 */

import { expect, mock, test } from "bun:test";

const points = [
  { timestamp: new Date("2026-08-13T00:00:00.000Z") },
  { timestamp: new Date("2026-08-13T01:00:00.000Z") },
];
const users = [
  { lastActive: new Date("2026-08-13T00:00:00.000Z"), userId: "a" },
  { lastActive: new Date("2026-08-13T01:00:00.000Z"), userId: "b" },
];
const providers = [{ provider: "a" }, { provider: "b" }];
const models = [{ model: "a" }, { model: "b" }];

mock.module("../cache/client", () => ({
  cache: {
    getWithSWR: async (_key: string, _ttl: unknown, loader: () => Promise<unknown>) => loader(),
  },
}));

mock.module("../../db/repositories/usage-records", () => ({
  usageRecordsRepository: {
    getUsageTimeSeries: async () => points,
    getUsageByUser: async () => users,
    getProviderBreakdown: async () => providers,
    getModelBreakdown: async () => models,
  },
}));

const { AnalyticsService } = await import("./analytics");

test("treats an explicit analytics maxRows of 0 as an empty page", async () => {
  const service = new AnalyticsService();
  const range = {
    startDate: new Date("2026-08-13T00:00:00.000Z"),
    endDate: new Date("2026-08-14T00:00:00.000Z"),
  };

  const emptySeries = await service.getUsageTimeSeries("org-1", {
    ...range,
    granularity: "hour",
    maxRows: 0,
  });
  expect(emptySeries).toEqual([]);
  const oneSeries = await service.getUsageTimeSeries("org-1", {
    ...range,
    granularity: "hour",
    maxRows: 1,
  });
  expect(oneSeries).toHaveLength(1);

  expect(await service.getUsageByUser("org-1", { maxRows: 0 })).toEqual([]);
  expect(await service.getUsageByUser("org-1")).toHaveLength(2);

  expect(await service.getProviderBreakdown("org-1", { maxRows: 0 })).toEqual([]);
  expect(await service.getModelBreakdown("org-1", { maxRows: 0 })).toEqual([]);
  expect(await service.getModelBreakdown("org-1", { maxRows: 1 })).toHaveLength(1);
});
