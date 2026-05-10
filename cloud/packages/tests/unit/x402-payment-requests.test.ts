import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const PAYMENT_ID = "x402_request_test";

function payment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PAYMENT_ID,
    organization_id: "org-x402",
    user_id: "user-x402",
    payment_address: "0x0000000000000000000000000000000000000001",
    token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    token: "USDC",
    network: "eip155:8453",
    expected_amount: "1010000",
    credits_to_add: "1.0000",
    status: "confirmed",
    transaction_hash: "0xtx",
    block_number: null,
    received_amount: "1010000",
    confirmed_at: new Date("2026-05-10T12:00:00.000Z"),
    expires_at: new Date("2026-05-10T12:15:00.000Z"),
    created_at: new Date("2026-05-10T11:55:00.000Z"),
    updated_at: new Date("2026-05-10T12:00:00.000Z"),
    metadata: {
      kind: "x402_payment_request",
      amountUsd: 1,
      platformFeeUsd: 0.01,
      serviceFeeUsd: 0.01,
      totalChargedUsd: 1.02,
      description: "Public status",
      appId: "app-x402",
      callbackUrl: "https://app.example.com/private/callback",
      payer: "0x0000000000000000000000000000000000000002",
    },
    ...overrides,
  };
}

async function loadService() {
  const mod = await import(
    new URL(
      `../../lib/services/x402-payment-requests.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  return mod.x402PaymentRequestsService as {
    toView: (payment: ReturnType<typeof payment>) => Record<string, unknown>;
    toPublicView: (payment: ReturnType<typeof payment>) => Record<string, unknown>;
    settle: (
      id: string,
      paymentPayloadInput: unknown,
    ) => Promise<{ paymentRequest: Record<string, unknown>; paymentResponse: string }>;
  };
}

describe("x402 payment requests", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("redacts callback URLs from public status views", async () => {
    const service = await loadService();
    const privateView = service.toView(payment());
    const publicView = service.toPublicView(payment());

    expect(privateView.callbackUrl).toBe("https://app.example.com/private/callback");
    expect(publicView.callbackUrl).toBeUndefined();
    expect(JSON.stringify(publicView)).not.toContain("callback");
  });

  test("returns already-settled status without duplicating settlement side effects", async () => {
    let markAsConfirmedCalls = 0;
    let updateCalls = 0;
    let earningsCalls = 0;
    let settleCalls = 0;

    mock.module("@/db/repositories/crypto-payments", () => ({
      cryptoPaymentsRepository: {
        findById: async () => payment(),
        markAsConfirmed: async () => {
          markAsConfirmedCalls += 1;
          return payment();
        },
        update: async () => {
          updateCalls += 1;
          return payment();
        },
      },
    }));

    mock.module("@/lib/services/redeemable-earnings", () => ({
      redeemableEarningsService: {
        addEarnings: async () => {
          earningsCalls += 1;
        },
      },
    }));

    mock.module("@/lib/services/x402-facilitator", () => ({
      x402FacilitatorService: {
        settle: async () => {
          settleCalls += 1;
          return { success: true, transaction: "0xnew", network: "eip155:8453" };
        },
      },
    }));

    mock.module("@/lib/utils/logger", () => ({
      logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
    }));

    const service = await loadService();
    const result = await service.settle(PAYMENT_ID, "unused");

    expect(result.paymentRequest.callbackUrl).toBeUndefined();
    expect(markAsConfirmedCalls).toBe(0);
    expect(updateCalls).toBe(0);
    expect(earningsCalls).toBe(0);
    expect(settleCalls).toBe(0);
    expect(JSON.parse(Buffer.from(result.paymentResponse, "base64").toString("utf-8"))).toEqual({
      success: true,
      transaction: "0xtx",
      network: "eip155:8453",
      alreadySettled: true,
    });
  });

  test("settles app-scoped payments to the app creator earnings ledgers", async () => {
    const appEarningsCalls: Array<{ method: string; args: unknown[] }> = [];
    const redeemableCalls: unknown[] = [];
    let appCounterUpdated = false;

    const pendingPayment = payment({
      status: "pending",
      transaction_hash: null,
      confirmed_at: null,
      expires_at: new Date(Date.now() + 60_000),
      metadata: {
        kind: "x402_payment_request",
        amountUsd: 12.5,
        platformFeeUsd: 0.13,
        serviceFeeUsd: 0.01,
        totalChargedUsd: 12.64,
        description: "Paid workflow",
        appId: "11111111-1111-4111-8111-111111111111",
        requirements: {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "12640000",
          maxAmountRequired: "12640000",
          payTo: "0x0000000000000000000000000000000000000001",
        },
      },
    });

    mock.module("@/db/repositories/crypto-payments", () => ({
      cryptoPaymentsRepository: {
        findById: async () => pendingPayment,
        markAsConfirmed: async () => ({ ...pendingPayment, status: "confirmed" }),
        update: async () => ({
          ...pendingPayment,
          status: "confirmed",
          transaction_hash: "0xsettled",
          metadata: {
            ...(pendingPayment.metadata as Record<string, unknown>),
            payer: "0x0000000000000000000000000000000000000002",
          },
        }),
      },
    }));

    mock.module("@/db/repositories/apps", () => ({
      appsRepository: {
        findById: async () => ({
          id: "11111111-1111-4111-8111-111111111111",
          created_by_user_id: "creator-user",
        }),
      },
    }));

    mock.module("@/db/repositories/app-earnings", () => ({
      appEarningsRepository: {
        addPurchaseEarnings: async (...args: unknown[]) => {
          appEarningsCalls.push({ method: "addPurchaseEarnings", args });
        },
        createTransaction: async (...args: unknown[]) => {
          appEarningsCalls.push({ method: "createTransaction", args });
        },
      },
    }));

    mock.module("@/db/helpers", () => ({
      dbWrite: {
        update: () => ({
          set: () => ({
            where: async () => {
              appCounterUpdated = true;
            },
          }),
        }),
      },
    }));

    mock.module("@/lib/services/redeemable-earnings", () => ({
      redeemableEarningsService: {
        addEarnings: async (args: unknown) => {
          redeemableCalls.push(args);
        },
      },
    }));

    mock.module("@/lib/services/x402-facilitator", () => ({
      x402FacilitatorService: {
        settle: async () => ({
          success: true,
          transaction: "0xsettled",
          network: "eip155:8453",
          payer: "0x0000000000000000000000000000000000000002",
        }),
      },
    }));

    mock.module("@/lib/utils/logger", () => ({
      logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
    }));

    const service = await loadService();
    await service.settle(PAYMENT_ID, {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "12640000",
        payTo: "0x0000000000000000000000000000000000000001",
      },
      payload: { signature: "0xsig" },
    });

    expect(appEarningsCalls[0]).toEqual({
      method: "addPurchaseEarnings",
      args: ["11111111-1111-4111-8111-111111111111", 12.5],
    });
    expect(appEarningsCalls[1]?.method).toBe("createTransaction");
    expect(appCounterUpdated).toBe(true);
    expect(redeemableCalls).toHaveLength(1);
    expect(redeemableCalls[0]).toMatchObject({
      userId: "creator-user",
      amount: 12.5,
      source: "miniapp",
      sourceId: PAYMENT_ID,
      dedupeBySourceId: true,
    });
  });
});
