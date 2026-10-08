/**
 * An omitted analytics limit is the repository default. An explicit limit of
 * 0 is an empty page. `limit || 0` put both calls on one cache key, so the
 * second call returned the first page.
 */

import { expect, mock, test } from "bun:test";

const users = [
  { userId: "a", lastActive: new Date("2026-08-13T00:00:00.000Z") },
  { userId: "b", lastActive: new Date("2026-08-13T01:00:00.000Z") },
];
const costs = [{ name: "model-a" }, { name: "model-b" }];
const store = new Map<string, unknown>();

mock.module("../cache/client", () => ({
  cache: {
    getWithSWR: async (key: string, _ttl: unknown, loader: () => Promise<unknown>) => {
      if (store.has(key)) return store.get(key);
      const value = await loader();
      store.set(key, value);
      return value;
    },
  },
}));

mock.module("../../db/repositories/usage-records", () => ({
  usageRecordsRepository: {
    getUsageByUser: async (_organizationId: string, options?: { limit?: number }) =>
      options?.limit === 0 ? [] : users,
    getCostBreakdown: async (
      _organizationId: string,
      _dimension: string,
      options?: { limit?: number },
    ) => (options?.limit === 0 ? [] : costs),
  },
}));

const { AnalyticsService } = await import("./analytics");

test("does not reuse a default analytics page for an explicit limit of 0", async () => {
  const service = new AnalyticsService();

  expect(await service.getUsageByUser("org-1")).toEqual(users);
  expect(await service.getUsageByUser("org-1", { limit: 0 })).toEqual([]);

  expect(await service.getCostBreakdown("org-1", "model")).toEqual(costs);
  expect(await service.getCostBreakdown("org-1", "model", { limit: 0 })).toEqual([]);
});
