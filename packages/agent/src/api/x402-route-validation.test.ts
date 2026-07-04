/**
 * Coverage for the x402 route-validation guard. Deterministic checks confirming
 * that a nullish `x402` field means no validation is required, while any present
 * value — enabled, malformed, or even `false` — forces the route set through
 * x402 validation.
 */
import type { Route } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  routeNeedsX402Validation,
  runtimeRoutesNeedX402Validation,
} from "./x402-route-validation";

function route(overrides: Record<string, unknown> = {}): Route {
  return {
    path: "/test",
    type: "GET",
    handler: async () => new Response(null),
    ...overrides,
  } as unknown as Route;
}

describe("x402 route validation guard", () => {
  it("does not require x402 validation for ordinary routes", () => {
    expect(runtimeRoutesNeedX402Validation([route()])).toBe(false);
  });

  it("does not require x402 validation for nullish x402 values", () => {
    expect(runtimeRoutesNeedX402Validation([route({ x402: null })])).toBe(
      false,
    );
    expect(runtimeRoutesNeedX402Validation([route({ x402: undefined })])).toBe(
      false,
    );
  });

  it("requires x402 validation for enabled or malformed x402 values", () => {
    expect(routeNeedsX402Validation(route({ x402: true }))).toBe(true);
    expect(
      runtimeRoutesNeedX402Validation([
        route(),
        route({ x402: { priceInCents: 25 } }),
      ]),
    ).toBe(true);
    expect(runtimeRoutesNeedX402Validation([route({ x402: false })])).toBe(
      true,
    );
  });
});
