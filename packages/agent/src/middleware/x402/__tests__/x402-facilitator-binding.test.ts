import { describe, expect, it } from "vitest";

import { facilitatorVerifyResponseMatchesRoute } from "../x402-facilitator-binding.ts";

const ctx = {
  resource: "https://x.example/r",
  routePath: "/r",
  priceInCents: 100,
  paymentConfigNames: ["base_usdc"],
};

describe("x402-facilitator-binding", () => {
  it("strict mode rejects empty facilitator body", () => {
    expect(facilitatorVerifyResponseMatchesRoute({}, ctx, false)).toBe(false);
  });

  it("strict mode accepts matching binding fields", () => {
    expect(
      facilitatorVerifyResponseMatchesRoute(
        {
          resource: ctx.resource,
          routePath: "/r",
          priceInCents: 100,
          paymentConfig: "base_usdc",
        },
        ctx,
        false,
      ),
    ).toBe(true);
  });

  it("strict mode accepts route alias field", () => {
    expect(
      facilitatorVerifyResponseMatchesRoute(
        {
          resource: ctx.resource,
          route: "/r",
          priceInCents: 100,
          paymentConfig: "base_usdc",
        },
        ctx,
        false,
      ),
    ).toBe(true);
  });

  it("strict mode accepts paymentConfigs array when every entry is allowed", () => {
    expect(
      facilitatorVerifyResponseMatchesRoute(
        {
          resource: ctx.resource,
          routePath: "/r",
          priceInCents: 100,
          paymentConfigs: ["base_usdc"],
        },
        ctx,
        false,
      ),
    ).toBe(true);
  });

  it("strict mode rejects paymentConfigs when any entry is not allowed", () => {
    expect(
      facilitatorVerifyResponseMatchesRoute(
        {
          resource: ctx.resource,
          routePath: "/r",
          priceInCents: 100,
          paymentConfigs: ["base_usdc", "other"],
        },
        ctx,
        false,
      ),
    ).toBe(false);
  });

  it("relaxed mode accepts empty body", () => {
    expect(facilitatorVerifyResponseMatchesRoute({}, ctx, true)).toBe(true);
  });

  it("relaxed mode still rejects explicit resource mismatch", () => {
    expect(
      facilitatorVerifyResponseMatchesRoute(
        { resource: "https://other.example/r" },
        ctx,
        true,
      ),
    ).toBe(false);
  });
});
