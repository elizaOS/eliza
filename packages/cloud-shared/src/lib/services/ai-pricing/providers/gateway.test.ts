import { describe, expect, mock, test } from "bun:test";

const loggerWarnCalls: unknown[] = [];

mock.module("../../../utils/logger", () => ({
  logger: {
    warn: (...args: unknown[]) => {
      loggerWarnCalls.push(args);
    },
  },
}));

mock.module("./cerebras", () => ({
  fetchCerebrasPublicCatalogEntries: async () => {
    throw new Error("cerebras catalog 404");
  },
}));

describe("pricing provider gateway", () => {
  test("degrades external catalog failures instead of throwing", async () => {
    const { fetchEntriesForSource } = await import("./gateway");

    await expect(fetchEntriesForSource("cerebras")).resolves.toEqual([]);
    expect(loggerWarnCalls).toHaveLength(1);
    expect(loggerWarnCalls[0]).toEqual([
      "[AI Pricing] external catalog fetch failed; using cached/seed pricing",
      { source: "cerebras", error: "cerebras catalog 404" },
    ]);
  });
});
