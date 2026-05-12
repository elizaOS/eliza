import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const ID = "pr_redaction_test";

type PaymentProvider = "stripe" | "oxapay" | "x402" | "wallet_native";
type PaymentContext =
  | { kind: "verified_payer"; scope: "owner_or_linked_identity" }
  | { kind: "any_payer" };
type PaymentRequestStatus = "pending" | "delivered" | "settled" | "expired" | "canceled" | "failed";

interface PaymentRequestRow {
  id: string;
  organizationId: string;
  agentId: string | null;
  provider: PaymentProvider;
  amountCents: number;
  currency: string;
  paymentContext: PaymentContext;
  status: PaymentRequestStatus;
  reason: string | null;
  expiresAt: string | null;
  callbackUrl: string | null;
  callbackSecret: string | null;
  payerIdentityId: string | null;
  settlementTxRef: string | null;
  settlementProof: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  hostedUrl?: string;
}

function row(overrides: Partial<PaymentRequestRow> = {}): PaymentRequestRow {
  return {
    id: ID,
    organizationId: "org_redaction",
    agentId: null,
    provider: "stripe",
    amountCents: 500,
    currency: "USD",
    paymentContext: { kind: "verified_payer", scope: "owner_or_linked_identity" },
    status: "pending",
    reason: "redaction test",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    callbackUrl: "https://creator.example.com/callback",
    callbackSecret: "super-secret-callback-key",
    payerIdentityId: "user_identity_42",
    settlementTxRef: "tx_proof_ref",
    settlementProof: { txHash: "0xdeadbeef", block: 42 },
    metadata: { invoice: "INV-1" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hostedUrl: "https://checkout.stripe.com/c/pay/cs_test",
    ...overrides,
  };
}

function installMocks(getRow: () => PaymentRequestRow | null): void {
  mock.module("@/lib/auth/workers-hono-auth", () => ({
    requireUserOrApiKeyWithOrg: async () => {
      throw new Error("Authenticated path should not run on ?public=1");
    },
  }));

  mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
    RateLimitPresets: { STANDARD: "standard", STRICT: "strict" },
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  }));

  mock.module("@/lib/api/cloud-worker-errors", () => ({
    failureResponse: (_c: unknown, error: unknown) =>
      new Response(JSON.stringify({ success: false, error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    ApiError: class ApiError extends Error {
      status: number;
      constructor(message: string, status = 500) {
        super(message);
        this.status = status;
      }
    },
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
  }));

  const service = {
    getPublic: async () => getRow(),
    create: async () => ({ paymentRequest: row() }),
    list: async () => [],
    cancel: async () => row({ status: "canceled" }),
    expirePast: async () => [],
    markSettled: async () => row({ status: "settled" }),
    markFailed: async () => row({ status: "failed" }),
  };

  mock.module("@/lib/services/payment-requests-default", () => ({
    getPaymentRequestsService: () => service,
  }));

  mock.module("@/lib/services/payment-requests", () => ({
    redactPaymentRequestForPublic: (input: PaymentRequestRow) => {
      const { callbackSecret, settlementProof, ...rest } = input;
      return {
        ...rest,
        payerIdentityId: input.paymentContext.kind === "any_payer" ? null : input.payerIdentityId,
      };
    },
  }));
}

async function loadIdRoute() {
  const mod = await import(
    new URL(
      `../../../apps/api/v1/payment-requests/[id]/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const parent = new Hono();
  parent.route("/api/v1/payment-requests/:id", mod.default as Hono);
  return parent;
}

describe("payment-requests public redaction", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("?public=1 strips callbackSecret and settlementProof for verified_payer", async () => {
    installMocks(() =>
      row({
        paymentContext: {
          kind: "verified_payer",
          scope: "owner_or_linked_identity",
        },
      }),
    );
    const route = await loadIdRoute();

    const response = await route.request(`https://api.test/api/v1/payment-requests/${ID}?public=1`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      success?: boolean;
      paymentRequest?: Partial<PaymentRequestRow>;
    };
    expect(body.success).toBe(true);
    expect(body.paymentRequest).toBeTruthy();
    expect("callbackSecret" in (body.paymentRequest ?? {})).toBe(false);
    expect("settlementProof" in (body.paymentRequest ?? {})).toBe(false);
    // verified_payer: payerIdentityId is preserved so the payer page can verify identity.
    expect(body.paymentRequest?.payerIdentityId).toBe("user_identity_42");
  });

  test("?public=1 also strips payerIdentityId for any_payer requests", async () => {
    installMocks(() =>
      row({ paymentContext: { kind: "any_payer" }, payerIdentityId: "user_identity_42" }),
    );
    const route = await loadIdRoute();

    const response = await route.request(`https://api.test/api/v1/payment-requests/${ID}?public=1`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      success?: boolean;
      paymentRequest?: Partial<PaymentRequestRow>;
    };
    expect(body.paymentRequest?.payerIdentityId).toBeNull();
    expect("callbackSecret" in (body.paymentRequest ?? {})).toBe(false);
    expect("settlementProof" in (body.paymentRequest ?? {})).toBe(false);
  });

  test("?public=1 returns 404 when payment request is missing", async () => {
    installMocks(() => null);
    const route = await loadIdRoute();

    const response = await route.request(
      `https://api.test/api/v1/payment-requests/missing?public=1`,
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { success?: boolean };
    expect(body.success).toBe(false);
  });
});
