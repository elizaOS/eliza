/**
 * Drives the global anonymous-auth exception through the real detail route,
 * payment service, repository, and PGlite row. Collection and mutations stay
 * gated while the hosted page receives exactly the public checkout DTO.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  publicPaymentRequestActiveExpiry,
  publicPaymentRequestResponseFixture,
} from "@elizaos/cloud-shared/testing/payment-request-public-response-fixture";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { PaymentRequestsService } from "@/lib/services/payment-requests";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

const getCurrentUser = mock(async () => null);
const requireUserOrApiKeyWithOrg = mock(async () => {
  const error = new Error("Authentication required");
  error.name = "AuthenticationError";
  throw error;
});
const requireCronSecret = (c: {
  env: { CRON_SECRET?: string };
  req: { header: (name: string) => string | undefined };
}): void => {
  const expected = c.env.CRON_SECRET;
  const provided =
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || provided !== expected) {
    const error = new Error(
      expected ? "Invalid cron secret" : "Cron secret not configured",
    );
    error.name = expected ? "AuthenticationError" : "ForbiddenError";
    throw error;
  }
};
let paymentService: PaymentRequestsService;

mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser,
  requireCronSecret,
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/payment-requests-default", () => ({
  getPaymentRequestsService: () => paymentService,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: "standard" },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { closeDatabaseConnectionsForTests, dbWrite } = await import(
  "@/db/client"
);
const { paymentRequestEvents, paymentRequests } = await import(
  "@/db/schemas/payment-requests"
);
const { PaymentRequestsRepository } = await import(
  "@/db/repositories/payment-requests"
);
const { createPaymentRequestsService } = await import(
  "@/lib/services/payment-requests"
);
const { authMiddleware } = await import("../src/middleware/auth");
const { default: paymentRequestDetailRoute } = await import(
  "../v1/payment-requests/[id]/route"
);

const ENV = { NODE_ENV: "test" };
const repository = new PaymentRequestsRepository();
paymentService = createPaymentRequestsService({ repository, adapters: [] });

const app = new Hono();
app.use("*", authMiddleware);
app.route("/api/v1/payment-requests/:id", paymentRequestDetailRoute);
app.get("/api/v1/payment-requests", (c) => c.json({ reached: true }));
app.post("/api/v1/payment-requests/:id/cancel", (c) =>
  c.json({ reached: true, id: c.req.param("id") }),
);

describe("payment-request hosted-page authority", () => {
  let paymentRequestId = "";

  beforeAll(async () => {
    await dbWrite.execute(sql`
      CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL UNIQUE
      )
    `);
    await dbWrite.execute(sql`
      CREATE TABLE payment_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        agent_id uuid,
        app_id uuid,
        provider text NOT NULL,
        amount_cents bigint NOT NULL,
        currency text NOT NULL DEFAULT 'usd',
        reason text,
        payment_context jsonb NOT NULL DEFAULT '{"kind":"any_payer"}'::jsonb,
        payer_identity_id text,
        payer_user_id uuid,
        status text NOT NULL DEFAULT 'pending',
        hosted_url text,
        callback_url text,
        callback_secret text,
        provider_intent jsonb NOT NULL DEFAULT '{}'::jsonb,
        settled_at timestamp with time zone,
        settlement_tx_ref text,
        settlement_proof jsonb,
        expires_at timestamp with time zone NOT NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await dbWrite.execute(sql`
      CREATE TABLE payment_request_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_request_id uuid NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
        event_name text NOT NULL,
        redacted_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at timestamp with time zone NOT NULL DEFAULT now()
      )
    `);
  }, 60_000);

  beforeEach(async () => {
    getCurrentUser.mockClear();
    requireUserOrApiKeyWithOrg.mockClear();
    await dbWrite.delete(paymentRequestEvents);
    await dbWrite.delete(paymentRequests);
    await dbWrite.execute(sql`DELETE FROM organizations`);
    const organizationId = crypto.randomUUID();
    await dbWrite.execute(
      sql`INSERT INTO organizations (id, name, slug) VALUES (
        ${organizationId},
        'Checkout Org',
        ${`checkout-${crypto.randomUUID()}`}
      )`,
    );
    paymentRequestId = publicPaymentRequestResponseFixture.paymentRequest.id;
    await dbWrite.execute(sql`
      INSERT INTO payment_requests (
        id,
        organization_id,
        provider,
        amount_cents,
        currency,
        reason,
        payer_identity_id,
        status,
        hosted_url,
        callback_url,
        callback_secret,
        provider_intent,
        expires_at,
        metadata
      ) VALUES (
        ${paymentRequestId},
        ${organizationId},
        'stripe',
        2500,
        'USD',
        'Premium plan',
        'private-payer',
        'delivered',
        'https://checkout.example.test/session',
        'https://merchant.example.test/private-callback',
        'private-callback-secret',
        '{"stripe_session_id":"private-provider-intent"}'::jsonb,
        ${publicPaymentRequestActiveExpiry},
        '{"internal":"private-metadata"}'::jsonb
      )
    `);
  });

  afterAll(async () => {
    await closeDatabaseConnectionsForTests();
  });

  test("anonymous exact-item GET reaches the real route and returns only eight public fields", async () => {
    const response = await app.request(
      `https://api.example.test/api/v1/payment-requests/${paymentRequestId}?public=1`,
      undefined,
      ENV,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      paymentRequest: Record<string, unknown>;
    };
    expect(body).toEqual(publicPaymentRequestResponseFixture);
    expect(Object.keys(body.paymentRequest)).toHaveLength(8);
    expect(JSON.stringify(body)).not.toContain("private-");
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
  });

  test("collection, unflagged item, and cancellation stay behind global auth", async () => {
    const [collection, item, cancel] = await Promise.all([
      app.request(
        "https://api.example.test/api/v1/payment-requests",
        undefined,
        ENV,
      ),
      app.request(
        `https://api.example.test/api/v1/payment-requests/${paymentRequestId}`,
        undefined,
        ENV,
      ),
      app.request(
        `https://api.example.test/api/v1/payment-requests/${paymentRequestId}/cancel`,
        { method: "POST" },
        ENV,
      ),
    ]);

    expect([collection.status, item.status, cancel.status]).toEqual([
      401, 401, 401,
    ]);
    expect(getCurrentUser).toHaveBeenCalledTimes(2);
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
  });

  test("missing public id stays anonymous and returns the real route's 404", async () => {
    const response = await app.request(
      "https://api.example.test/api/v1/payment-requests/00000000-0000-0000-0000-000000000000?public=1",
      undefined,
      ENV,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Payment request not found",
    });
    expect(getCurrentUser).not.toHaveBeenCalled();
  });
});
