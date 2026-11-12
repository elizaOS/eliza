/** A Worker has one database connection: a locked caller cannot open a second transaction. */
import { beforeEach, expect, mock, test } from "bun:test";
import type { DbTransaction } from "../../db/client";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
const database = await import("../../db/client");
const policies = await import("./organization-quota-policy");
let held = false;
let transactions = 0;
let reads = 0;
const transaction = {
  select: () => ({
    from: () => ({
      where: async () => {
        expect(held).toBe(true);
        reads++;
        return [{ status: "active", plan_key: "plus_monthly", catalog_version: "v1" }];
      },
    }),
  }),
} as unknown as DbTransaction;
const pool = {
  transaction: async (read: (tx: DbTransaction) => Promise<unknown>) => {
    if (held)
      throw new Error(
        "A second connection cannot be acquired while the policy transaction is held",
      );
    held = true;
    transactions++;
    try {
      return await read(transaction);
    } finally {
      held = false;
    }
  },
};
mock.module("../../db/client", () => ({ ...database, dbWrite: pool }));
mock.module("./organization-quota-policy", () => ({
  ...policies,
  readOrganizationQuotaPolicyInTransaction: async (tx: DbTransaction) => {
    expect(tx).toBe(transaction);
    expect(held).toBe(true);
    return {
      authority: {
        source: "subscription",
        sourceSubscriptionId: "test-subscription",
        effectiveUntil: "2099-01-01T00:00:00Z",
      },
      tier: { status: "available", value: { tierName: "plus" } },
      subscriptionFunded: true,
    };
  },
}));
const { readOrganizationEntitlementSummary } = await import("./subscription-entitlement-token");
beforeEach(() => {
  held = false;
  transactions = reads = 0;
});

test("a locked admission reads entitlement on its existing single connection", async () => {
  const result = await pool.transaction((tx) =>
    readOrganizationEntitlementSummary("test-org", { transaction: tx }),
  );
  expect(result).toMatchObject({
    plan: { id: "plus_monthly", status: "active" },
    source: "subscription",
    rateTier: "plus",
  });
  expect(transactions).toBe(1);
  expect(reads).toBe(1);
});

test("a standalone entitlement read still owns one transaction", async () => {
  const result = await readOrganizationEntitlementSummary("test-org");
  expect(result.plan.status).toBe("active");
  expect(transactions).toBe(1);
  expect(reads).toBe(1);
});
