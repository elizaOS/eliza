/** Proves structured API error bodies stay readable but out of default logs. */
import { describe, expect, test } from "vitest";
import { ApiError } from "./client-types-core";

describe("ApiError structured body", () => {
  test("is non-enumerable while remaining directly readable", () => {
    const data = { code: "insufficient_credits", privateDetail: "sensitive" };
    const error = new ApiError({
      kind: "http",
      path: "/api/test",
      status: 402,
      code: "insufficient_credits",
      message: "insufficient credits",
      data,
    });

    expect(error.data).toBe(data);
    expect(Object.keys(error)).not.toContain("data");
    expect({ ...error }).not.toHaveProperty("data");
  });
});
