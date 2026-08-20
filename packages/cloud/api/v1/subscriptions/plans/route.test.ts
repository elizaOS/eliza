/**
 * Exercises the public subscription-plan route with deterministic catalog
 * loaders, covering auth classification, cache policy, and fail-closed errors.
 */

import { describe, expect, mock, test } from "bun:test";
import type { SubscriptionPlansDto } from "@/lib/types/cloud-api";

mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser: async () => null,
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  getRequestIp: () => "127.0.0.1",
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug() {},
    error() {},
    info() {},
    warn() {},
  },
}));
mock.module("../../../src/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({ dispatch: async () => undefined }),
}));

const [{ isPublicPath }, { createSubscriptionPlansRoute }] = await Promise.all([
  import("../../../src/middleware/auth"),
  import("./route"),
]);

const PLANS: SubscriptionPlansDto = {
  catalogVersion: "v1",
  plans: [
    {
      key: "plus_monthly",
      name: "Plus",
      catalogVersion: "v1",
      active: true,
      interval: "month",
      intervalCount: 1,
      currency: "usd",
      amountCents: 3_000,
      allowance: {
        amountUsd: "25.000000",
        fundingClass: "allowance_eligible",
        rollover: false,
      },
      fundingClasses: ["allowance_eligible", "cash_only"],
      rateLimits: {
        completionsRpm: 120,
        embeddingsRpm: 200,
        standardRpm: 60,
        strictRpm: 10,
      },
      resourceCeilings: {
        cloudCharacters: 100,
        agentSandboxes: 100,
        containers: 25,
        storageGiB: 25,
        apps: 25,
      },
    },
  ],
};

describe("subscription plans route", () => {
  test("allows only public GET and HEAD access to the exact endpoint", () => {
    expect(isPublicPath("/api/v1/subscriptions/plans", "GET")).toBe(true);
    expect(isPublicPath("/api/v1/subscriptions/plans/", "HEAD")).toBe(true);
    expect(isPublicPath("/api/v1/subscriptions/plans", "POST")).toBe(false);
    expect(isPublicPath("/api/v1/subscriptions/plans/private", "GET")).toBe(
      false,
    );
  });

  test("returns the verified DTO with bounded public caching", async () => {
    const app = createSubscriptionPlansRoute({ loadPlans: async () => PLANS });
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=60, s-maxage=300, must-revalidate",
    );
    expect(response.headers.get("etag")).toBe('"subscription-catalog-v1"');
    expect((await response.json()) as unknown).toEqual({
      success: true,
      data: PLANS,
    });
    const head = await app.request("/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("returns an explicit non-cacheable unavailable response", async () => {
    const app = createSubscriptionPlansRoute({
      loadPlans: async () => {
        throw Object.assign(new Error("provider detail"), {
          code: "SUBSCRIPTION_CATALOG_PROVIDER_DRIFT",
        });
      },
    });
    const response = await app.request("/");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("60");
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: "Subscription plans are temporarily unavailable",
      code: "service_unavailable",
    });
  });

  test("the route cannot serialize provider identifiers", async () => {
    const app = createSubscriptionPlansRoute({ loadPlans: async () => PLANS });
    const serialized = await (await app.request("/")).text();
    expect(serialized.toLowerCase()).not.toContain("stripe");
    expect(serialized).not.toMatch(/(?:price|prod)_[A-Za-z0-9]+/);
  });
});
