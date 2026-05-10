import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const CHARGE_ID = "charge_callback_test";
const APP_ID = "app_callback_test";

interface Harness {
  memories: Array<Record<string, unknown>>;
}

function installMocks(harness: Harness): void {
  mock.module("@/db/helpers", () => ({
    dbRead: {
      query: {
        cryptoPayments: {
          findFirst: async () => ({
            id: CHARGE_ID,
            expected_amount: "5.00",
            metadata: {
              kind: "app_charge_request",
              app_id: APP_ID,
              amount_usd: 5,
              payment_context: "verified_payer",
              description: "Please send me $5",
              payment_url: `https://cloud.test/payment/app-charge/${APP_ID}/${CHARGE_ID}`,
              callback_channel: {
                source: "dashboard",
                roomId: "room_payment_5",
                agentId: "agent_payment_5",
              },
              callback_metadata: {
                scenario: "send_me_five",
              },
            },
          }),
        },
      },
    },
  }));

  mock.module("@/db/repositories/agents/memories", () => ({
    memoriesRepository: {
      create: async (memory: Record<string, unknown>) => {
        harness.memories.push(memory);
        return memory;
      },
    },
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
  }));
}

async function loadService() {
  const mod = await import(
    new URL(
      `../../lib/services/app-charge-callbacks.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  return mod.appChargeCallbacksService as {
    dispatch: (params: {
      appId: string;
      chargeRequestId: string;
      status: "paid" | "failed";
      provider: "stripe" | "oxapay";
      providerPaymentId: string;
      amountUsd: number;
      reason?: string;
    }) => Promise<{ roomMessageCreated: boolean; httpPosted: boolean; errors: string[] }>;
  };
}

describe("app charge callbacks", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("creates a success callback message in the initiating channel", async () => {
    const harness: Harness = { memories: [] };
    installMocks(harness);
    const service = await loadService();

    const result = await service.dispatch({
      appId: APP_ID,
      chargeRequestId: CHARGE_ID,
      status: "paid",
      provider: "oxapay",
      providerPaymentId: "oxapay_payment_5",
      amountUsd: 5,
    });

    expect(result.roomMessageCreated).toBe(true);
    expect(result.errors).toEqual([]);
    expect(harness.memories).toHaveLength(1);
    expect(harness.memories[0]).toMatchObject({
      roomId: "room_payment_5",
      entityId: "agent_payment_5",
      agentId: "agent_payment_5",
      content: {
        text: "Payment went through for $5.00.",
        source: "agent",
        channelType: "dashboard",
        appChargeId: CHARGE_ID,
        paymentStatus: "paid",
      },
      metadata: {
        role: "agent",
        appChargeEvent: "app_charge.paid",
        appChargeId: CHARGE_ID,
        provider: "oxapay",
        providerPaymentId: "oxapay_payment_5",
      },
    });
  });

  test("creates a failure callback message in the initiating channel", async () => {
    const harness: Harness = { memories: [] };
    installMocks(harness);
    const service = await loadService();

    const result = await service.dispatch({
      appId: APP_ID,
      chargeRequestId: CHARGE_ID,
      status: "failed",
      provider: "stripe",
      providerPaymentId: "pi_failed_5",
      amountUsd: 5,
      reason: "card_declined",
    });

    expect(result.roomMessageCreated).toBe(true);
    expect(result.errors).toEqual([]);
    expect(harness.memories).toHaveLength(1);
    expect(harness.memories[0]).toMatchObject({
      roomId: "room_payment_5",
      content: {
        text: "Payment did not go through for $5.00.",
        appChargeId: CHARGE_ID,
        paymentStatus: "failed",
      },
      metadata: {
        appChargeEvent: "app_charge.failed",
        provider: "stripe",
        providerPaymentId: "pi_failed_5",
      },
    });
  });
});
