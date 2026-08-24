/**
 * Exercises the invoice detail Worker route with deterministic auth and
 * persistence fixtures so the response tenant identity comes from storage.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getById = mock(async () => ({
  id: "inv-1",
  organization_id: "org-one",
  stripe_invoice_id: "in_1756",
  stripe_customer_id: "cus_9",
  stripe_payment_intent_id: "pi_3",
  amount_due: 2500,
  amount_paid: 2500,
  currency: "usd",
  status: "paid",
  invoice_type: "subscription",
  invoice_number: "ELZ-0007",
  invoice_pdf: "https://files.example.test/inv-1.pdf",
  hosted_invoice_url: "https://invoice.example.test/inv-1",
  credits_added: 500,
  metadata: { intent: "card-topup" },
  created_at: new Date("2026-08-01T10:00:00.000Z"),
  updated_at: new Date("2026-08-01T10:05:00.000Z"),
  due_date: new Date("2026-08-15T00:00:00.000Z"),
  paid_at: new Date("2026-08-01T10:04:00.000Z"),
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (
    c: { json: (body: unknown, status: number) => Response },
    _error: unknown,
  ) => c.json({ error: "internal_error" }, 500),
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-one",
  }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/services/invoices", () => ({
  invoicesService: { getById },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined },
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/invoices/:id", route);

describe("GET /api/invoices/:id tenant identity", () => {
  beforeEach(() => getById.mockClear());

  test("returns the stored invoice organization as authoritative identity", async () => {
    const response = await app.request("/api/invoices/inv-1");

    expect(response.status).toBe(200);
    expect(getById).toHaveBeenCalledWith("inv-1");
    await expect(response.json()).resolves.toMatchObject({
      invoice: {
        id: "inv-1",
        organizationId: "org-one",
      },
    });
  });
});
