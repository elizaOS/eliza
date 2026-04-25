import type { Route } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import {
  applyPaymentProtection,
  isRoutePaymentWrapped,
  X402_ROUTE_PAYMENT_WRAPPED,
} from "../payment-wrapper.ts";

describe("applyPaymentProtection", () => {
  it("tags routes so the runtime dispatcher does not double-wrap the handler", () => {
    const routes: Route[] = [
      {
        type: "GET",
        path: "/plugin/paid",
        public: true,
        x402: { priceInCents: 1, paymentConfigs: ["base_usdc"] },
        handler: vi.fn().mockResolvedValue(undefined),
      } as Route,
    ];

    const [protectedRoute] = applyPaymentProtection(routes);

    expect(Reflect.get(protectedRoute, X402_ROUTE_PAYMENT_WRAPPED)).toBe(true);
    expect(isRoutePaymentWrapped(protectedRoute)).toBe(true);
    expect(protectedRoute.handler).not.toBe(routes[0]?.handler);
  });
});
