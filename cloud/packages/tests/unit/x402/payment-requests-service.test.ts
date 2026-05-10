import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const PAYMENT_ID = "99999999-9999-4999-8999-999999999999";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const APP_ID = "33333333-3333-4333-8333-333333333333";

interface Harness {
  earningsCalls: Array<Record<string, unknown>>;
  roomMessages: Array<Record<string, unknown>>;
  payment?: ReturnType<typeof payment>;
}

function payment(status = "pending", overrides: Record<string, unknown> = {}) {
  const now = new Date();
  const base = {
    id: PAYMENT_ID,
    organization_id: ORG_ID,
    user_id: USER_ID,
    payment_address: "0x49620FE71DFC9ccACF37D89fA5f4bd0Cd83dEafB",
    token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    token: "USDC",
    network: "eip155:8453",
    expected_amount: "5060000",
    received_amount: null,
    credits_to_add: "5.0000",
    status,
    transaction_hash: status === "confirmed" ? "0xsettled" : null,
    expires_at: new Date(Date.now() + 60_000),
    confirmed_at: status === "confirmed" ? now : null,
    created_at: now,
    updated_at: now,
    metadata: {
      kind: "x402_payment_request",
      appId: APP_ID,
      amountUsd: 5,
      callbackChannel: {
        source: "woobench",
        roomId: "room-1",
        agentId: "agent-1",
      },
      platformFeeUsd: 0.05,
      serviceFeeUsd: 0.01,
      totalChargedUsd: 5.06,
      requirements: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "5060000",
        payTo: "0x49620FE71DFC9ccACF37D89fA5f4bd0Cd83dEafB",
      },
    },
  };
  return {
    ...base,
    ...overrides,
    metadata: {
      ...base.metadata,
      ...((overrides.metadata as Record<string, unknown> | undefined) ?? {}),
    },
  };
}

function installMocks(harness: Harness): void {
  mock.module("@/db/repositories/agents/memories", () => ({
    memoriesRepository: {
      create: async (message: Record<string, unknown>) => {
        harness.roomMessages.push(message);
        return message;
      },
    },
  }));

  mock.module("@/db/repositories/crypto-payments", () => ({
    cryptoPaymentsRepository: {
      findById: async () => harness.payment ?? payment(),
      markAsConfirmed: async () => payment("confirmed"),
      update: async (_id: string, patch: { metadata?: Record<string, unknown> }) => ({
        ...payment("confirmed"),
        metadata: {
          ...payment().metadata,
          ...(patch.metadata ?? {}),
        },
      }),
      create: async () => payment(),
      listByOrganization: async () => [],
      markAsExpired: async () => ({ ...(harness.payment ?? payment()), status: "expired" }),
    },
  }));

  mock.module("@/lib/services/redeemable-earnings", () => ({
    redeemableEarningsService: {
      addEarnings: async (params: Record<string, unknown>) => {
        harness.earningsCalls.push(params);
        return { success: true, newBalance: 5, ledgerEntryId: "ledger-x402" };
      },
    },
  }));

  mock.module("@/db/repositories/apps", () => ({
    appsRepository: {
      findById: async () => ({
        id: APP_ID,
        created_by_user_id: USER_ID,
      }),
    },
  }));

  mock.module("@/db/repositories/app-earnings", () => ({
    appEarningsRepository: {
      addPurchaseEarnings: async () => {},
      createTransaction: async () => {},
    },
  }));

  mock.module("@/db/helpers", () => ({
    dbWrite: {
      update: () => ({
        set: () => ({
          where: async () => {},
        }),
      }),
    },
  }));

  mock.module("@/lib/services/x402-facilitator", () => ({
    x402FacilitatorService: {
      settle: async () => ({
        success: true,
        transaction: "0xsettled",
        network: "eip155:8453",
        payer: "0x0000000000000000000000000000000000000001",
      }),
      initialize: async () => {},
      getSignerAddress: () => "0x49620FE71DFC9ccACF37D89fA5f4bd0Cd83dEafB",
      getSignerAddressForNetwork: () => "0x49620FE71DFC9ccACF37D89fA5f4bd0Cd83dEafB",
    },
  }));

  mock.module("@/lib/runtime/cloud-bindings", () => ({
    getCloudAwareEnv: () => ({}),
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
  }));
}

async function loadService() {
  const mod = await import(
    new URL(
      `../../../lib/services/x402-payment-requests.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  return mod.x402PaymentRequestsService as {
    settle: (
      id: string,
      payload: Record<string, unknown>,
    ) => Promise<{ paymentRequest: { paid: boolean } }>;
  };
}

describe("x402 payment requests service", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("credits app-linked x402 settlements using the payment id as the earnings dedupe key", async () => {
    const harness: Harness = { earningsCalls: [], roomMessages: [] };
    installMocks(harness);
    const service = await loadService();

    const result = await service.settle(PAYMENT_ID, {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "5060000",
        payTo: "0x49620FE71DFC9ccACF37D89fA5f4bd0Cd83dEafB",
      },
      payload: {
        signature: "0xpaid",
        authorization: {
          from: "0x0000000000000000000000000000000000000001",
        },
      },
    });

    expect(result.paymentRequest.paid).toBe(true);
    expect(harness.earningsCalls).toHaveLength(1);
    expect(harness.earningsCalls[0]).toMatchObject({
      userId: USER_ID,
      amount: 5,
      source: "miniapp",
      sourceId: PAYMENT_ID,
      dedupeBySourceId: true,
      metadata: expect.objectContaining({
        appId: APP_ID,
        paymentType: "x402_payment_request",
        transaction: "0xsettled",
      }),
    });
    expect(harness.roomMessages).toHaveLength(1);
    expect(harness.roomMessages[0]).toMatchObject({
      roomId: "room-1",
      entityId: "agent-1",
      agentId: "agent-1",
      type: "messages",
      content: expect.objectContaining({
        text: "Payment went through for $5.00.",
        source: "agent",
        channelType: "woobench",
        x402PaymentRequestId: PAYMENT_ID,
        paymentStatus: "paid",
      }),
      metadata: expect.objectContaining({
        x402PaymentEvent: "x402.payment_request.paid",
        x402PaymentRequestId: PAYMENT_ID,
      }),
    });
  });

  test("sends failed payment callbacks into the initiating channel", async () => {
    const harness: Harness = {
      earningsCalls: [],
      roomMessages: [],
      payment: payment("pending", { expires_at: new Date(Date.now() - 60_000) }),
    };
    installMocks(harness);
    const service = await loadService();

    await expect(service.settle(PAYMENT_ID, {})).rejects.toThrow("Payment request expired");

    expect(harness.earningsCalls).toHaveLength(0);
    expect(harness.roomMessages).toHaveLength(1);
    expect(harness.roomMessages[0]).toMatchObject({
      roomId: "room-1",
      entityId: "agent-1",
      agentId: "agent-1",
      content: expect.objectContaining({
        text: "Payment did not go through for $5.00.",
        paymentStatus: "failed",
        reason: "expired",
      }),
      metadata: expect.objectContaining({
        x402PaymentEvent: "x402.payment_request.failed",
        x402PaymentRequestId: PAYMENT_ID,
      }),
    });
  });
});
