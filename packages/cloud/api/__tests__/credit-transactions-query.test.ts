import { describe, expect, test } from "bun:test";

import { parseCreditTransactionsQuery } from "../credits/transactions/query";

describe("parseCreditTransactionsQuery", () => {
  test("returns default limit and no hours filter", () => {
    expect(parseCreditTransactionsQuery({})).toEqual({
      limit: 100,
      hours: null,
    });
  });

  test("accepts explicit positive integer values at the route bounds", () => {
    expect(
      parseCreditTransactionsQuery({ limit: "200", hours: "8760" }),
    ).toEqual({
      limit: 200,
      hours: 8760,
    });
  });

  test.each([
    "-1",
    "0",
    "abc",
    "1.5",
    "1e2",
    " 10",
    "10 ",
    "+10",
    "201",
    "999999999999999999999",
  ])("rejects invalid limit %s", (limit) => {
    expect(() => parseCreditTransactionsQuery({ limit })).toThrow();
  });

  test.each([
    "-24",
    "0",
    "abc",
    "1.5",
    "1e2",
    " 24",
    "24 ",
    "+24",
    "8761",
    "999999999999999999999",
  ])("rejects invalid hours %s", (hours) => {
    expect(() => parseCreditTransactionsQuery({ hours })).toThrow();
  });
});
