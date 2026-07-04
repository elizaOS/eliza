// Exercises cloud API tests app charge public route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Context } from "hono";
import { Hono } from "hono";

const findPublicInfoById = mock();
const getForApp = mock();

mock.module("@/db/repositories/apps", () => ({
  appsRepository: {
    findPublicInfoById,
  },
}));

mock.module("@/lib/services/app-charge-requests", () => ({
  appChargeRequestsService: {
    getForApp,
  },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: Context, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(),
  },
}));

const { default: publicChargeRoute } = await import(
  "../v1/apps/[id]/charges/[chargeId]/route"
);

const app = new Hono();
app.route("/api/v1/apps/:id/charges/:chargeId", publicChargeRoute);

type PublicChargeRouteBody = {
  success: boolean;
  charge: Record<string, string | number | boolean | null | string[]>;
  app: Record<string, string | null>;
};

describe("public app charge route", () => {
  beforeEach(() => {
    findPublicInfoById.mockReset();
    getForApp.mockReset();
  });

  test("returns only payer-facing charge fields, never internal metadata or IDs", async () => {
    findPublicInfoById.mockResolvedValue({
      id: "app-1",
      name: "Demo App",
      description: "Public demo",
      logo_url: "https://cdn.example/logo.png",
      website_url: "https://demo.example",
      organization_id: "org-secret",
      created_by_user_id: "user-secret",
    });
    getForApp.mockResolvedValue({
      id: "charge-1",
      appId: "app-1",
      amountUsd: 12.5,
      description: "Demo purchase",
      providers: ["stripe", "oxapay"],
      paymentContext: "any_payer",
      paymentUrl: "https://pay.example/charge-1",
      status: "requested",
      paidAt: null,
      paidProvider: undefined,
      providerPaymentId: "pi_secret",
      payerUserId: "payer-user-secret",
      payerOrganizationId: "payer-org-secret",
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
      createdAt: new Date("2026-06-29T00:00:00.000Z"),
      successUrl: "https://demo.example/success",
      cancelUrl: "https://demo.example/cancel",
      metadata: {
        callback_secret: "secret",
        callback_url: "https://creator.example/private-callback",
        creator_organization_id: "creator-org-secret",
        creator_user_id: "creator-user-secret",
        room_id: "room-secret",
      },
    });

    const response = await app.request("/api/v1/apps/app-1/charges/charge-1");

    expect(response.status).toBe(200);
    const body: PublicChargeRouteBody = await response.json();
    expect(body.success).toBe(true);
    expect(body.charge).toMatchObject({
      id: "charge-1",
      appId: "app-1",
      amountUsd: 12.5,
      description: "Demo purchase",
      providers: ["stripe", "oxapay"],
      paymentContext: "any_payer",
      paymentUrl: "https://pay.example/charge-1",
      status: "requested",
      successUrl: "https://demo.example/success",
      cancelUrl: "https://demo.example/cancel",
    });
    expect(body.charge).not.toHaveProperty("metadata");
    expect(body.charge).not.toHaveProperty("providerPaymentId");
    expect(body.charge).not.toHaveProperty("payerUserId");
    expect(body.charge).not.toHaveProperty("payerOrganizationId");
    expect(JSON.stringify(body.charge)).not.toContain("secret");
    expect(body.app).toEqual({
      id: "app-1",
      name: "Demo App",
      description: "Public demo",
      logo_url: "https://cdn.example/logo.png",
      website_url: "https://demo.example",
    });
  });
});
