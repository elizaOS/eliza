import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const APP_ID = "app_settlement_test";
const CHARGE_ID = "charge_settlement_test";

function installMocks(harness: {
  updates: Array<Record<string, unknown>>;
  callbackReads: number;
}): void {
  let chargeRequest = {
    id: CHARGE_ID,
    status: "requested",
    expected_amount: "5.00",
    metadata: {
      kind: "app_charge_request",
      app_id: APP_ID,
      payment_context: "verified_payer",
    },
  };

  mock.module("@/db/schemas/crypto-payments", () => ({
    cryptoPayments: { id: "id" },
  }));

  mock.module("@/db/repositories/agents/memories", () => ({
    memoriesRepository: {
      create: async () => {
        throw new Error("No room callback should be created in this test");
      },
    },
  }));

  mock.module("@/db/helpers", () => ({
    dbRead: {
      query: {
        cryptoPayments: {
          findFirst: async () => {
            harness.callbackReads += 1;
            return chargeRequest;
          },
        },
      },
    },
    dbWrite: {
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        const selectChain = {
          from: () => selectChain,
          where: () => selectChain,
          for: () => selectChain,
          limit: async () => [chargeRequest],
        };
        const updateChain = {
          set: (data: Record<string, unknown>) => {
            harness.updates.push(data);
            chargeRequest = {
              ...chargeRequest,
              ...data,
              status: "confirmed",
              metadata: data.metadata as typeof chargeRequest.metadata,
            };
            return updateChain;
          },
          where: async () => [],
        };
        await fn({
          select: () => selectChain,
          update: () => updateChain,
        });
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
      `../../lib/services/app-charge-settlement.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  return mod.appChargeSettlementService as {
    markPaid: (params: {
      appId: string;
      chargeRequestId: string;
      provider: "stripe" | "oxapay";
      providerPaymentId: string;
      amountUsd: number;
      payerUserId?: string;
      payerOrganizationId?: string;
    }) => Promise<void>;
  };
}

describe("app charge settlement", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("does not duplicate settlement updates or callbacks for an already-paid charge", async () => {
    const harness = { updates: [] as Array<Record<string, unknown>>, callbackReads: 0 };
    installMocks(harness);
    const service = await loadService();

    await service.markPaid({
      appId: APP_ID,
      chargeRequestId: CHARGE_ID,
      provider: "stripe",
      providerPaymentId: "pi_first",
      amountUsd: 5,
      payerUserId: "payer-user",
      payerOrganizationId: "payer-org",
    });
    await service.markPaid({
      appId: APP_ID,
      chargeRequestId: CHARGE_ID,
      provider: "stripe",
      providerPaymentId: "pi_duplicate",
      amountUsd: 5,
      payerUserId: "payer-user",
      payerOrganizationId: "payer-org",
    });

    expect(harness.updates).toHaveLength(1);
    expect(harness.callbackReads).toBe(1);
  });
});
