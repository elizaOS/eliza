/**
 * Exercises the crypto payment mutation routes through their real Hono
 * handlers with deterministic authentication and service ledgers, proving a
 * malformed JSON body is answered with the boundary's 400 instead of a 5xx
 * (or an engine parse diagnostic) and never reaches a money-mutating service.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const USER = {
  id: "user-1",
  organization_id: "org-1",
  wallet_address: null as string | null,
};

const DIRECT_PAYMENT = {
  id: "direct-payment-1",
  organization_id: USER.organization_id,
  user_id: USER.id,
  status: "pending",
  metadata: { direct_network: "base" },
};

const OXA_PAYMENT = {
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: USER.organization_id,
  user_id: USER.id,
  status: "pending",
  network: "ERC20",
};

const calls = {
  directCreate: [] as unknown[],
  directConfirm: [] as unknown[],
  directAttach: [] as unknown[],
  oxaCreate: [] as unknown[],
  oxaConfirm: [] as unknown[],
};

class CryptoPaymentError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserOrApiKeyWithOrg: async () => USER,
  requireUserWithOrg: async () => USER,
}));
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    RateLimitPresets: { STANDARD: {}, STRICT: {} },
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
    moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
      next(),
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/direct-wallet-payments",
  () => ({
    directWalletPaymentsService: {
      createPayment: async (...input: unknown[]) => {
        calls.directCreate.push(input);
        return {
          payment: { id: DIRECT_PAYMENT.id, status: "pending" },
          paymentInstructions: { network: "base" },
        };
      },
      confirmPayment: async (...input: unknown[]) => {
        calls.directConfirm.push(input);
        return {
          alreadyConfirmed: false,
          payment: { id: DIRECT_PAYMENT.id, credits_to_add: 1000 },
        };
      },
      attachTransaction: async (...input: unknown[]) => {
        calls.directAttach.push(input);
        return {
          alreadyAttached: false,
          payment: {
            id: DIRECT_PAYMENT.id,
            status: "pending",
            transaction_hash:
              "0x1111111111111111111111111111111111111111111111111111111111111111",
          },
        };
      },
    },
  }),
);
mock.module("@elizaos/cloud-shared/db/repositories/crypto-payments", () => ({
  cryptoPaymentsRepository: {
    findById: async (id: string) =>
      id === OXA_PAYMENT.id ? OXA_PAYMENT : DIRECT_PAYMENT,
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/crypto-payments", () => ({
  CryptoPaymentError,
  cryptoPaymentsService: {
    createPayment: async (...input: unknown[]) => {
      calls.oxaCreate.push(input);
      return {
        payment: { id: OXA_PAYMENT.id },
        trackId: "track-1",
        payLink: "https://oxapay.example/pay/track-1",
        expiresAt: new Date("2026-10-05T00:00:00.000Z"),
        creditsToAdd: 1000,
      };
    },
    verifyAndConfirmByTxHash: async (...input: unknown[]) => {
      calls.oxaConfirm.push(input);
      return { success: true, message: "Payment confirmed successfully" };
    },
    listPaymentsByOrganization: async () => [],
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/oxapay", () => ({
  isOxaPayConfigured: () => true,
}));
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  redact: {
    paymentId: (value: string) => value,
    ip: (value: string) => value,
    userId: (value: string) => value,
    orgId: (value: string) => value,
  },
}));

const { ORGANIZATION_CREDIT_CHECKOUT_LIMITS } = await import(
  "@elizaos/cloud-shared/billing"
);
const { default: directCreateRoute } = await import(
  "../crypto/direct-payments/route"
);
const { default: directConfirmRoute } = await import(
  "../crypto/direct-payments/[id]/confirm/route"
);
const { default: directAttachRoute } = await import(
  "../crypto/direct-payments/[id]/attach-tx/route"
);
const { default: oxaCreateRoute } = await import("../crypto/payments/route");
const { default: oxaConfirmRoute } = await import(
  "../crypto/payments/[id]/confirm/route"
);

afterAll(() => mock.restore());

beforeEach(() => {
  for (const ledger of Object.values(calls)) ledger.length = 0;
});

const EVM_TX_HASH = `0x${"1".repeat(64)}`;
const directCreateBody = {
  amount: ORGANIZATION_CREDIT_CHECKOUT_LIMITS.minAmountUsd + 1,
  network: "base",
  payerAddress: "0x0000000000000000000000000000000000000001",
};

type RouteCase = {
  label: string;
  route: Hono<AppEnv>;
  path: string;
  validBody: unknown;
  ledger: unknown[];
};

const routeCases: RouteCase[] = [
  {
    label: "direct-payments create",
    route: new Hono<AppEnv>().route(
      "/crypto/direct-payments",
      directCreateRoute,
    ),
    path: "/crypto/direct-payments",
    validBody: directCreateBody,
    ledger: calls.directCreate,
  },
  {
    label: "direct-payments confirm",
    route: new Hono<AppEnv>().route(
      "/crypto/direct-payments/:id/confirm",
      directConfirmRoute,
    ),
    path: `/crypto/direct-payments/${DIRECT_PAYMENT.id}/confirm`,
    validBody: { transactionHash: EVM_TX_HASH, payerSignature: "sig-1" },
    ledger: calls.directConfirm,
  },
  {
    label: "direct-payments attach-tx",
    route: new Hono<AppEnv>().route(
      "/crypto/direct-payments/:id/attach-tx",
      directAttachRoute,
    ),
    path: `/crypto/direct-payments/${DIRECT_PAYMENT.id}/attach-tx`,
    validBody: { transactionHash: EVM_TX_HASH, payerSignature: "sig-1" },
    ledger: calls.directAttach,
  },
  {
    label: "payments create",
    route: new Hono<AppEnv>().route("/crypto/payments", oxaCreateRoute),
    path: "/crypto/payments",
    validBody: { amount: 10 },
    ledger: calls.oxaCreate,
  },
  {
    label: "payments confirm",
    route: new Hono<AppEnv>().route(
      "/crypto/payments/:id/confirm",
      oxaConfirmRoute,
    ),
    path: `/crypto/payments/${OXA_PAYMENT.id}/confirm`,
    validBody: { transactionHash: EVM_TX_HASH },
    ledger: calls.oxaConfirm,
  },
];

for (const routeCase of routeCases) {
  test(`${routeCase.label}: malformed JSON is a 400 invalid body, not a 5xx`, async () => {
    const response = await routeCase.route.request(routeCase.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toBe("Invalid JSON body");
    expect(routeCase.ledger.length).toBe(0);
  });

  test(`${routeCase.label}: a valid body still reaches the payment service once`, async () => {
    const response = await routeCase.route.request(routeCase.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(routeCase.validBody),
    });
    expect(response.status).toBe(200);
    expect(routeCase.ledger.length).toBe(1);
  });
}
