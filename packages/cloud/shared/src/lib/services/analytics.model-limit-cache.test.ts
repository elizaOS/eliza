/**
 * The model breakdown cache key ignored `limit`. The analytics page asks for
 * 20 rows and the export asks for 100000. Both calls shared one key, so the
 * second call returned the first page.
 */
import { expect, mock, test } from "bun:test";

const page20 = [{ model: "small-a" }, { model: "small-b" }];
const pageExport = [{ model: "export-a" }, { model: "export-b" }, { model: "export-c" }];
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
    getModelBreakdown: async (_organizationId: string, options?: { limit?: number }) => {
      if (options?.limit === 20) return page20;
      if (options?.limit === 100_000) return pageExport;
      return [{ model: "default" }];
    },
  },
}));

const { AnalyticsService } = await import("./analytics");

test("does not reuse a 20-row model page for the export limit", async () => {
  const service = new AnalyticsService();
  expect(await service.getModelBreakdown("org-1", { limit: 20 })).toEqual(page20);
  expect(await service.getModelBreakdown("org-1", { limit: 100_000 })).toEqual(pageExport);
});
