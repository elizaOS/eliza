import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface Harness {
  updates: Array<Record<string, unknown>>;
  ledgerEntries: Array<Record<string, unknown>>;
  transactionCount: number;
}

function whereResult(returningRows: unknown[] = []) {
  return {
    returning: async () => returningRows,
  };
}

function installMocks(harness: Harness): void {
  mock.module("@/db/client", () => ({
    dbRead: {},
    dbWrite: {
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        harness.transactionCount++;
        let updateIndex = 0;
        const tx = {
          update: () => ({
            set: (values: Record<string, unknown>) => ({
              where: () => {
                harness.updates.push(values);
                updateIndex++;
                return whereResult(updateIndex === 2 ? [{ available_balance: "4.00" }] : []);
              },
            }),
          }),
          insert: () => ({
            values: (values: Record<string, unknown>) => {
              harness.ledgerEntries.push(values);
              return Promise.resolve();
            },
          }),
        };

        await fn(tx);
      },
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
      `../../lib/services/payout-processor.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  return new mod.PayoutProcessorService() as {
    markCompleted: (redemption: Record<string, unknown>, txHash: string) => Promise<void>;
  };
}

describe("payout processor", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("completes a redemption and moves locked earnings to redeemed balance", async () => {
    const harness: Harness = { updates: [], ledgerEntries: [], transactionCount: 0 };
    installMocks(harness);
    const service = await loadService();

    await service.markCompleted(
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        usd_value: "5.00",
        network: "base",
      },
      "0xpaid",
    );

    expect(harness.transactionCount).toBe(1);
    expect(harness.updates).toHaveLength(2);
    expect(harness.updates[0]).toMatchObject({
      status: "completed",
      tx_hash: "0xpaid",
    });
    expect(harness.updates[1]).toMatchObject({
      last_redemption_at: expect.any(Date),
      updated_at: expect.any(Date),
    });

    expect(harness.ledgerEntries).toEqual([
      expect.objectContaining({
        user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        entry_type: "redemption",
        amount: "0",
        balance_after: "4.00",
        redemption_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        description: "Redemption completed: $5.00 sent as elizaOS",
        metadata: expect.objectContaining({
          network: "base",
          tx_hash: "0xpaid",
        }),
      }),
    ]);
  });
});
