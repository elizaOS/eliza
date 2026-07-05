/**
 * Pins the fail-closed contract of UserMetricsService: an internal DB read
 * failure must PROPAGATE (reject) out of the exported service, and must stay
 * distinguishable from a legitimately-empty result (zero users / no
 * credentials), which resolves to a well-formed zeroed DTO. Uses a chainable
 * thenable stub for `dbRead` so no real Postgres/PGlite is touched.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

// Per-test resolvers for the two distinct query builders getOAuthConnectionRate
// issues: `.select()` (COUNT of non-anonymous users) and `.selectDistinct()`
// (active platform credentials). A resolver may throw to simulate a DB failure.
let selectResolver: () => unknown = () => [{ cnt: 0 }];
let selectDistinctResolver: () => unknown = () => [];

// Minimal Drizzle-shaped chainable thenable: every builder method returns the
// same object, and awaiting it runs the resolver. Throwing inside the resolver
// rejects the await, mirroring a real driver-level query failure.
function chain(resolver: () => unknown) {
  const builder: Record<string, unknown> = {};
  for (const m of ["from", "leftJoin", "innerJoin", "where", "groupBy", "orderBy", "limit"]) {
    builder[m] = () => builder;
  }
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable thenables.
  builder.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve().then(resolver).then(res, rej);
  builder.catch = (rej: (e: unknown) => unknown) => Promise.resolve().then(resolver).catch(rej);
  builder.finally = (f: () => void) => Promise.resolve().then(resolver).finally(f);
  return builder;
}

const dbStub = {
  select: () => chain(selectResolver),
  selectDistinct: () => chain(selectDistinctResolver),
};

mock.module("../../db/client", () => ({ dbRead: dbStub, dbWrite: dbStub }));

const { userMetricsService } = await import("./user-metrics");

beforeEach(() => {
  selectResolver = () => [{ cnt: 0 }];
  selectDistinctResolver = () => [];
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

afterAll(() => {
  mock.restore();
});

describe("UserMetricsService fail-closed contract", () => {
  test("designed-empty: no users and no credentials resolves to a zeroed DTO", async () => {
    selectResolver = () => [{ cnt: 0 }];
    selectDistinctResolver = () => [];

    const result = await userMetricsService.getOAuthConnectionRate();

    expect(result).toEqual({
      total_users: 0,
      connected_users: 0,
      rate: 0,
      byService: {},
    });
  });

  test("populated: real counts flow through untouched", async () => {
    selectResolver = () => [{ cnt: 4 }];
    selectDistinctResolver = () => [
      { userId: "u1", platform: "discord" },
      { userId: "u2", platform: "discord" },
      { userId: "u1", platform: "telegram" },
    ];

    const result = await userMetricsService.getOAuthConnectionRate();

    expect(result.total_users).toBe(4);
    expect(result.connected_users).toBe(2); // distinct users u1, u2
    expect(result.byService).toEqual({ discord: 2, telegram: 1 });
    expect(result.rate).toBeCloseTo(0.5, 10);
  });

  test("internal failure: a failed user-count read PROPAGATES, never reads as zero", async () => {
    const boom = new Error("connection terminated unexpectedly");
    selectResolver = () => {
      throw boom;
    };
    selectDistinctResolver = () => [];

    // The failure must surface as a rejection — it must NOT be swallowed into a
    // { total_users: 0, ... } success that conflates "DB down" with "no users".
    await expect(userMetricsService.getOAuthConnectionRate()).rejects.toThrow(
      "connection terminated unexpectedly",
    );
  });

  test("internal failure: a failed credentials read PROPAGATES", async () => {
    selectResolver = () => [{ cnt: 4 }];
    selectDistinctResolver = () => {
      throw new Error("relation platform_credentials does not exist");
    };

    await expect(userMetricsService.getOAuthConnectionRate()).rejects.toThrow(
      "relation platform_credentials does not exist",
    );
  });
});
