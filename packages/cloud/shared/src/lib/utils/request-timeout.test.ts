/**
 * Coverage for request-timeout.
 */
import { describe, expect, it } from "vitest";
import { getRouteTimeoutMs } from "./request-timeout.js";

describe("request-timeout", () => {
  it("calculates timeout", () => {
    expect(getRouteTimeoutMs(30)).toBe(20000);
  });
  it("respects min", () => {
    expect(getRouteTimeoutMs(1)).toBe(1000);
  });
  it("custom buffer", () => {
    expect(getRouteTimeoutMs(10, 5000)).toBe(5000);
  });
});
