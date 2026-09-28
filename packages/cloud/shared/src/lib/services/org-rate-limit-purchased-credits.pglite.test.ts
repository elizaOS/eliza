/**
 * RPM tier credit sources (#23019): subscribers get their plan's tier, and a
 * pay-as-you-go tier derives only from net purchased credits. Exercises the
 * real organization policy reader against migrated PGlite ledger rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createBillingSnapshotFixture } from "../../db/repositories/account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const PLUS_ORG = "61000000-0000-4000-8000-000000000001";
const PLUS_SUB = "62000000-0000-4000-8000-000000000001";
const ORG = "61000000-0000-4000-8000-000000023019";
const OTHER_ORG = "61000000-0000-4000-8000-000000023020";

let database: typeof import("../../db/client");
let readPolicy: typeof import("./organization-quota-policy").readOrganizationQuotaPolicy;
let sequence = 0;

async function exec(query: string): Promise<void> {
  await database.getPgliteClientForTests().exec(query);
}

async function ledger(
  organizationId: string,
  amount: string,
  type: string,
  metadata: Record<string, unknown>,
  paymentIdentity: string | null,
): Promise<void> {
  sequence += 1;
  const identity = paymentIdentity === null ? "NULL" : `'${paymentIdentity}-${sequence}'`;
  await exec(`INSERT INTO credit_transactions(id, organization_id, amount, type, metadata, stripe_payment_intent_id)
    VALUES (gen_random_uuid(), '${organizationId}', ${amount}, '${type}', '${JSON.stringify(metadata)}'::jsonb, ${identity})`);
}

async function tier(organizationId: string) {
  const policy = await readPolicy(organizationId);
  if (policy.tier.status !== "available") throw new Error("tier unavailable");
  return { total: policy.tierSourceCreditTotal, tier: policy.tier.value };
}

beforeAll(async () => {
  database = await import("../../db/client");
  await createBillingSnapshotFixture(exec, "");
  for (const org of [ORG, OTHER_ORG]) {
    await exec(`INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state)
      VALUES ('${org}', '0', 1, 0, '{}', true, false, 'active')`);
  }
  ({ readOrganizationQuotaPolicy: readPolicy } = await import("./organization-quota-policy"));
}, 120_000);

beforeEach(async () => {
  await exec(`DELETE FROM credit_transactions WHERE organization_id IN ('${ORG}', '${OTHER_ORG}')`);
});

afterAll(async () => {
  if (database) await database.closeDatabaseConnectionsForTests();
});

describe("pay-as-you-go RPM tier sources (#23019)", () => {
  test("promo, signup, affiliate, earnings, MCP and refund credits never qualify", async () => {
    await ledger(ORG, "50", "credit", { type: "initial_free_credits" }, null);
    await ledger(ORG, "50", "credit", { type: "signup_code_bonus" }, null);
    await ledger(ORG, "50", "credit", { type: "app_signup_bonus" }, null);
    await ledger(ORG, "50", "credit", { type: "referral_bonus" }, null);
    await ledger(ORG, "50", "credit", { source: "mcp", payment_type: "affiliate" }, null);
    await ledger(ORG, "50", "credit", { billing_type: "container_earnings_conversion" }, null);
    await ledger(
      ORG,
      "50",
      "credit",
      { reason: "post_debit_accounting_failed" },
      "app-inference-compensation:x",
    );
    await ledger(ORG, "50", "refund", { type: "usage_refund" }, null);
    await ledger(ORG, "50", "refund", { source: "reconcile" }, "refund");
    expect(await tier(ORG)).toMatchObject({ total: "0", tier: { tierName: "free" } });
  });

  test("purchases qualify at the $5 boundary and only the paid part of a crypto promo counts", async () => {
    await ledger(ORG, "4.99", "credit", { type: "custom_amount" }, "pi_card");
    expect((await tier(ORG)).tier.tierName).toBe("free");
    await ledger(ORG, "0.01", "credit", { payment_method: "x402" }, "x402:base:0xabc");
    expect(await tier(ORG)).toMatchObject({ total: "5.000000", tier: { tierName: "paid" } });

    // $10 paid + $5 BSC promotion: only the paid $10 counts.
    await ledger(
      ORG,
      "15.00",
      "credit",
      { provider: "wallet_native", paid_amount_usd: "10.00", bonus_credits: 5 },
      "wallet_native:payment",
    );
    await ledger(ORG, "20", "credit", { crypto_payment_id: "c1" }, "crypto:payment");
    await ledger(ORG, "25", "credit", { type: "auto_top_up" }, "pi_auto");
    await ledger(ORG, "39.99", "credit", { type: "payment_request_topup" }, "payment-request:x");
    expect(await tier(ORG)).toMatchObject({ total: "99.990000", tier: { tierName: "paid" } });
    await ledger(ORG, "0.01", "credit", { type: "custom_amount" }, "pi_card");
    expect(await tier(ORG)).toMatchObject({ total: "100.000000", tier: { tierName: "growth" } });

    // Organizations are isolated.
    expect(await tier(OTHER_ORG)).toMatchObject({ total: "0", tier: { tierName: "free" } });
  });

  test("a refund or chargeback reverses the purchase and a won dispute restores it", async () => {
    await ledger(ORG, "100", "credit", { type: "custom_amount" }, "pi_growth");
    expect((await tier(ORG)).tier.tierName).toBe("growth");
    // The balance was spent, so only $0 is applied but the whole $60 is reversed.
    await ledger(
      ORG,
      "0",
      "clawback",
      { requested_clawback_usd: 60, applied_clawback_usd: 0, unrecovered_clawback_usd: 60 },
      "re_refund",
    );
    expect(await tier(ORG)).toMatchObject({ total: "40.000000", tier: { tierName: "paid" } });
    await ledger(ORG, "60", "refund", { source: "charge.dispute.funds_reinstated" }, "reinstated");
    expect(await tier(ORG)).toMatchObject({ total: "100.000000", tier: { tierName: "growth" } });
    await ledger(ORG, "-500", "clawback", {}, "dp_dispute");
    expect(await tier(ORG)).toMatchObject({ total: "0", tier: { tierName: "free" } });
  });
});

describe("subscriber RPM tier (#23019)", () => {
  test("an active Plus subscriber gets the plan tier regardless of purchases", async () => {
    const { subscriptionAuthorityRepository } = await import(
      "../../db/repositories/subscription-authority"
    );
    const { subscriptionEntitlementsRepository } = await import(
      "../../db/repositories/subscription-entitlements"
    );
    const current = await subscriptionAuthorityRepository.findById(PLUS_ORG, PLUS_SUB);
    if (!current) throw new Error("Expected the Plus subscription fixture");
    const {
      id: _id,
      organization_id: _org,
      lifecycle_revision: _revision,
      created_at: _created,
      updated_at: _updated,
      ...values
    } = current;
    const advanced = await subscriptionAuthorityRepository.advance({
      organizationId: PLUS_ORG,
      subscriptionId: PLUS_SUB,
      expectedRevision: 1,
      source: "webhook",
      observation: "authoritative_provider_retrieval",
      values: {
        ...values,
        current_period_start: new Date(Date.now() - 86_400_000),
        current_period_end: new Date(Date.now() + 86_400_000),
        provider_object_digest: "c".repeat(64),
      },
    });
    await subscriptionEntitlementsRepository.rebuild({
      organizationId: PLUS_ORG,
      sourceSubscriptionId: PLUS_SUB,
      sourceSubscriptionRevision: advanced.subscription.lifecycle_revision,
      expectedProjectionRevision: 1,
    });
    const policy = await readPolicy(PLUS_ORG);
    expect(policy.tierSourceCreditTotal).toBeNull();
    expect(policy.tier).toMatchObject({
      status: "available",
      value: { tierName: "plus_monthly", completionsRpm: 120, strictRpm: 10 },
    });
  });
});
