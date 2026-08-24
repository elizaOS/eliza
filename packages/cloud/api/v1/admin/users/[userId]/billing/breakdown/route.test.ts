/**
 * Exercises the billing breakdown route and firstOfCurrentMonthUtc helper.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("@/db/helpers", () => ({
  dbRead: {
    select: () => ({
      from: () => ({
        where: () => ({
          groupBy: () => [],
        }),
      }),
    }),
  },
}));

mock.module("@/db/schemas/usage-records", () => ({
  usageRecords: {
    user_id: "user_id",
    recorded_at: "recorded_at",
    type: "type",
    provider: "provider",
    raw_cost: "raw_cost",
    markup: "markup",
    billed_cost: "billed_cost",
  },
}));

mock.module("@/lib/auth/admin", () => ({
  requireAdminWithResponse: async () => null,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const { firstOfCurrentMonthUtc } = await import("./route");

describe("firstOfCurrentMonthUtc", () => {
  test("returns the first day of the current month at UTC midnight", () => {
    const fixed = new Date("2026-08-24T15:30:00.000Z");
    const first = firstOfCurrentMonthUtc(fixed);

    expect(first.getUTCFullYear()).toBe(2026);
    expect(first.getUTCMonth()).toBe(7); // 0-indexed August
    expect(first.getUTCDate()).toBe(1);
    expect(first.getUTCHours()).toBe(0);
    expect(first.getUTCMinutes()).toBe(0);
    expect(first.getUTCSeconds()).toBe(0);
    expect(first.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  test("preserves years 0-99 without Date.UTC 1900-1999 remapping", () => {
    const fixed = new Date("0025-06-15T12:00:00.000Z");
    const first = firstOfCurrentMonthUtc(fixed);

    expect(first.getUTCFullYear()).toBe(25);
    expect(first.getUTCMonth()).toBe(5); // June
    expect(first.getUTCDate()).toBe(1);
    expect(first.toISOString()).toBe("0025-06-01T00:00:00.000Z");
  });
});
