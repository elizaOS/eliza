import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type Stripe from "stripe";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

const TIMEOUT = 60_000;
const ORG = "52000000-0000-4000-8000-000000000001";
const CUSTOMER = "cus_held";
const PAYMENT_METHOD = "pm_held";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDatabaseConnectionsForTests: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let getPgliteClientForTests: typeof import("../../../db/client").getPgliteClientForTests;

function migration(name: string): Promise<string> {
  return readFile(new URL(`../../../db/migrations/${name}`, import.meta.url), "utf8");
}

async function execStatements(source: string): Promise<void> {
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
}

async function seedHeldOrganization(): Promise<{ holdId: string }> {
  await dbWrite.execute(sql`
    INSERT INTO organizations (
      id, name, slug, credit_balance, settings, stripe_default_payment_method,
      auto_top_up_enabled, auto_top_up_threshold, auto_top_up_amount, is_active
    ) VALUES (
      ${ORG}, 'Held', 'held', 0::numeric, '{}'::jsonb, ${PAYMENT_METHOD},
      true, 5.00::numeric, 10.00::numeric, true
    )
  `);

  const authorityAttemptId = randomUUID();
  const requestDigest = "b".repeat(64);
  await dbWrite.execute(sql`
    INSERT INTO stripe_customer_attempts (
      id, organization_id, generation, request_digest, caller_intent, idempotency_key
    ) VALUES (
      ${authorityAttemptId}, ${ORG}, 1, ${requestDigest}, 'auto_top_up',
      ${`eliza-customer-attempt:${authorityAttemptId}`}
    )
  `);
  await dbWrite.execute(sql`
    UPDATE stripe_customer_attempts
    SET status = 'provider_started', provider_started_at = now()
    WHERE id = ${authorityAttemptId}
  `);
  const receipt = {
    binding_kind: "attempt_created",
    created: 1_700_000_000,
    customer_id: CUSTOMER,
    livemode: false,
    metadata: {
      organization_id: ORG,
      eliza_organization_id: ORG,
      eliza_customer_attempt_id: authorityAttemptId,
      eliza_customer_generation: "1",
      eliza_customer_request_digest: requestDigest,
      eliza_customer_provider: "stripe",
    },
  };
  await dbWrite.execute(sql`
    UPDATE stripe_customer_attempts
    SET status = 'bound', provider_customer_id = ${CUSTOMER},
        provider_receipt = ${JSON.stringify(receipt)}::jsonb,
        provider_livemode = false, bound_at = now()
    WHERE id = ${authorityAttemptId}
  `);
  await dbWrite.execute(sql`
    UPDATE organizations SET stripe_customer_id = ${CUSTOMER} WHERE id = ${ORG}
  `);

  const clawback = await dbWrite.execute<{ id: string }>(sql`
    INSERT INTO credit_transactions (organization_id, amount, type, description, metadata)
    VALUES (
      ${ORG}, -6.000000::numeric, 'clawback', 'Refund clawback',
      '{"unrecovered_clawback_usd":"4.000000"}'::jsonb
    )
    RETURNING id
  `);
  const hold = await dbWrite.execute<{ id: string }>(sql`
    INSERT INTO organization_payment_reversal_holds (
      organization_id, reason, clawback_transaction_id, shortfall_usd, outstanding_usd
    ) VALUES (
      ${ORG}, 'reversal_shortfall', ${clawback.rows[0]!.id}, 4.000000, 4.000000
    )
    RETURNING id
  `);
  return { holdId: hold.rows[0]!.id };
}

function succeededPaymentIntent(params: Stripe.PaymentIntentCreateParams): Stripe.PaymentIntent {
  return {
    id: "pi_auto_top_up_held",
    object: "payment_intent",
    status: "succeeded",
    amount: params.amount,
    amount_received: params.amount,
    currency: params.currency,
    customer: params.customer ?? null,
    payment_method: params.payment_method ?? null,
    metadata: params.metadata ?? {},
  } as Stripe.PaymentIntent;
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } = await import(
    "../../../db/client"
  ));
  await getPgliteClientForTests().exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      credit_balance numeric(12,6) NOT NULL DEFAULT 0,
      balance_revision bigint NOT NULL DEFAULT 0,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      stripe_customer_id text,
      stripe_default_payment_method text,
      auto_top_up_enabled boolean NOT NULL DEFAULT false,
      auto_top_up_threshold numeric(10,2),
      auto_top_up_amount numeric(10,2),
      is_active boolean NOT NULL DEFAULT true,
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid,
      amount numeric(12,6) NOT NULL,
      type text NOT NULL,
      description text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      stripe_payment_intent_id text,
      created_at timestamp NOT NULL DEFAULT now(),
      settled_at timestamp
    );
    CREATE UNIQUE INDEX credit_transactions_stripe_payment_intent_idx
      ON credit_transactions (stripe_payment_intent_id);
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX organizations_stripe_customer_authority_unique
      ON organizations(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
  `);
  const fence = await Promise.all([
    migration("0213_auto_top_up_organization_fence.sql"),
    migration("0214_backfill_auto_top_up_organization_fence.sql"),
    migration("0215_auto_top_up_attempts.sql"),
    migration("0216_auto_top_up_cutover_control.sql"),
    migration("0217_guard_auto_top_up_cutover_lifecycle.sql"),
  ]);
  await getPgliteClientForTests().exec(fence.join("\n"));
  await execStatements(await migration("0267_stripe_customer_attempts.sql"));
  await execStatements(await migration("0479_organization_payment_reversal_holds.sql"));
  await execStatements(await migration("0494_payment_reversal_shortfall_holds.sql"));

  const { autoTopUpAttemptsRepository } = await import(
    "../../../db/repositories/auto-top-up-attempts"
  );
  const pausedAt = new Date(Date.now() - 60_000);
  await getPgliteClientForTests().exec(`
    UPDATE auto_top_up_control
    SET mode = 'paused', paused_at = '${pausedAt.toISOString()}',
        legacy_reconciled_through = NULL, updated_at = '${pausedAt.toISOString()}'
    WHERE singleton = true;
  `);
  const activated = await autoTopUpAttemptsRepository.transitionControl({
    expectedMode: "paused",
    targetMode: "durable",
    legacyReconciledThrough: new Date(pausedAt.getTime() + 1),
    now: new Date(pausedAt.getTime() + 2),
  });
  expect(activated).toMatchObject({ outcome: "applied", control: { mode: "durable" } });
}, TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

test(
  "a card auto top-up repays the outstanding refund shortfall and clears the billing hold",
  async () => {
    const { holdId } = await seedHeldOrganization();
    const { AutoTopUpService } = await import("../auto-top-up");
    const { billingHoldService } = await import("../billing-hold");

    expect((await billingHoldService.getState(ORG)).status).toBe("held");

    const lifecycle = {
      organizationId: ORG,
      state: "active" as const,
      revision: 1,
      active: true,
      deletionRequestId: null,
    };
    const service = new AutoTopUpService({
      rolloutEnabled: () => true,
      stripe: (() => ({
        paymentIntents: {
          create: async (params: Stripe.PaymentIntentCreateParams) =>
            succeededPaymentIntent(params),
        },
      })) as never,
      customerAuthority: { ensure: async () => ({}) as never },
      lifecycleAuthority: async () => lifecycle,
      acquireProviderAdmission: async () => true,
      releaseProviderAdmission: async () => undefined,
    });

    const result = await service.executeAutoTopUpForOrganization(ORG, { source: "cron" });
    expect(result).toMatchObject({ success: true, status: "credited", amount: 10 });

    expect(await billingHoldService.getState(ORG)).toEqual({ status: "clear" });

    const balance = await dbWrite.execute<{ credit_balance: string }>(
      sql`SELECT credit_balance::text AS credit_balance FROM organizations WHERE id = ${ORG}`,
    );
    expect(balance.rows[0]?.credit_balance).toBe("6.000000");

    const hold = await dbWrite.execute<{ outstanding_usd: string; released_by: string | null }>(
      sql`SELECT outstanding_usd::text AS outstanding_usd, released_by
          FROM organization_payment_reversal_holds WHERE id = ${holdId}`,
    );
    expect(hold.rows[0]).toEqual({ outstanding_usd: "0.000000", released_by: "system:repayment" });
  },
  TIMEOUT,
);
