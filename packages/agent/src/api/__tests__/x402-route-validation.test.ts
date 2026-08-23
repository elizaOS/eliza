import { describe, expect, it } from "vitest";
import {
  routeNeedsX402Validation,
  runtimeRoutesNeedX402Validation,
} from "./x402-route-validation.ts";

describe("routeNeedsX402Validation", () => {
  it("detects any non-nullish x402 marker", () => {
    expect(routeNeedsX402Validation({ x402: {} } as never)).toBe(true);
    expect(routeNeedsX402Validation({ x402: false } as never)).toBe(true);
    expect(routeNeedsX402Validation({ x402: "" } as never)).toBe(true);
  });

  it("is false when x402 is absent or nullish", () => {
    expect(routeNeedsX402Validation({} as never)).toBe(false);
    expect(routeNeedsX402Validation({ x402: null } as never)).toBe(false);
    expect(routeNeedsX402Validation({ x402: undefined } as never)).toBe(false);
  });
});

describe("runtimeRoutesNeedX402Validation", () => {
  it("is true when any route needs validation", () => {
    expect(
      runtimeRoutesNeedX402Validation([{ x402: true } as never, {} as never]),
    ).toBe(true);
  });

  it("is false for empty, null, and all-clean route sets", () => {
    expect(runtimeRoutesNeedX402Validation([])).toBe(false);
    expect(runtimeRoutesNeedX402Validation(null)).toBe(false);
    expect(runtimeRoutesNeedX402Validation(undefined)).toBe(false);
    expect(runtimeRoutesNeedX402Validation([{} as never])).toBe(false);
  });
});
