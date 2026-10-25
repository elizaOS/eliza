/**
 * Exercises the durable auto-top-up repository against real PGlite, including
 * concurrent claims, immutable provider snapshots, lease takeover, crash
 * recovery after credit application, exact-cent settlement, and stale-fence
 * rejection. Stripe itself is not called; its durable request boundary is the
 * persisted payment-intent identity and result exercised here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const TIMEOUT = 60_000;
const BASE_TIME = Date.parse("2026-08-17T12:00:00.000Z");
const ORG_A = "51000000-0000-4000-8000-000000000001";
const ORG_B = "51000000-0000-4000-8000-000000000002";
const ORG_C = "51000000-0000-4000-8000-000000000003";
const ORG_D = "51000000-0000-4000-8000-000000000004";
const ORG_E = "51000000-0000-4000-8000-000000000005";
const ORG_F = "51000000-0000-4000-8000-000000000006";
const ORG_G = "51000000-0000-4000-8000-000000000007";

let dbWrite: typeof import("../client").dbWrite;
let closeDatabaseConnectionsForTests:
  | typeof import("../client").closeDatabaseConnectionsForTests
  | undefined;
let getPgliteClientForTests: typeof import("../client").getPgliteClientForTests;
let repository: import("./auto-top-up-attempts").AutoTopUpAttemptsRepository;

function at(offsetMs: number): Date {
  return new Date(BASE_TIME + offsetMs);
}

async function insertOrganization(input: {
  id: string;
  balance?: string;
  threshold?: string | null;
  amount?: string | null;
  enabled?: boolean;
  active?: boolean;
  customerId?: string | null;
  paymentMethodId?: string | null;
}): Promise<void> {
  const customerId =
    input.customerId === undefined ? `cus_${input.id.slice(-1)}` : input.customerId;
  await dbWrite.execute(sql`
    INSERT INTO organizations (
      id, name, slug, credit_balance, settings,
      stripe_default_payment_method, auto_top_up_enabled,
      auto_top_up_threshold, auto_top_up_amount, is_active, updated_at
    ) VALUES (
      ${input.id}, ${`Org ${input.id.slice(-1)}`}, ${`org-${input.id.slice(-1)}`},
      ${input.balance ?? "1.000000"}::numeric, '{}'::jsonb,
      ${input.paymentMethodId === undefined ? `pm_${input.id.slice(-1)}` : input.paymentMethodId},
      ${input.enabled ?? true},
      ${input.threshold === undefined ? "5.00" : input.threshold}::numeric,
      ${input.amount === undefined ? "10.00" : input.amount}::numeric,
      ${input.active ?? true}, ${at(0)}
    )
  `);
  if (customerId === null) return;

  const authorityAttemptId = randomUUID();
  const requestDigest = "a".repeat(64);
  await dbWrite.execute(sql`
    INSERT INTO stripe_customer_attempts (
      id, organization_id, generation, request_digest, caller_intent, idempotency_key
    ) VALUES (
      ${authorityAttemptId}, ${input.id}, 1, ${requestDigest}, 'auto_top_up',
      ${`eliza-customer-attempt:${authorityAttemptId}`}
    )
  `);
  await dbWrite.execute(sql`
    UPDATE stripe_customer_attempts
    SET status = 'provider_started', provider_started_at = ${at(0)}
    WHERE id = ${authorityAttemptId}
  `);
  const receipt = {
    binding_kind: "attempt_created",
    created: 1_700_000_000,
    customer_id: customerId,
    livemode: false,
    metadata: {
      organization_id: input.id,
      eliza_organization_id: input.id,
      eliza_customer_attempt_id: authorityAttemptId,
      eliza_customer_generation: "1",
      eliza_customer_request_digest: requestDigest,
      eliza_customer_provider: "stripe",
    },
  };
  await dbWrite.execute(sql`
    UPDATE stripe_customer_attempts
    SET status = 'bound', provider_customer_id = ${customerId},
        provider_receipt = ${JSON.stringify(receipt)}::jsonb,
        provider_livemode = false, bound_at = ${at(0)}
    WHERE id = ${authorityAttemptId}
  `);
  await dbWrite.execute(sql`
    UPDATE organizations SET stripe_customer_id = ${customerId} WHERE id = ${input.id}
  `);
}

async function claim(
  organizationId = ORG_A,
  now = at(0),
): Promise<import("./auto-top-up-attempts").AutoTopUpAttempt> {
  const result = await repository.claimEligibleAttempt({
    organizationId,
    triggerSource: "cron",
    attemptId: randomUUID(),
    idempotencyKey: `auto-top-up:${organizationId}:${now.getTime()}:${randomUUID()}`,
    now,
  });
  expect(result.outcome).toBe("created");
  if (result.outcome === "not_eligible") throw new Error("expected a created attempt");
  return result.attempt;
}

async function lease(
  attemptId: string,
  leaseToken: string,
  now = at(1_000),
  leaseExpiresAt = at(61_000),
): Promise<import("./auto-top-up-attempts").AutoTopUpAttempt> {
  const attempt = await repository.claimDueLease({ attemptId, leaseToken, now, leaseExpiresAt });
  expect(attempt).not.toBeNull();
  return attempt as import("./auto-top-up-attempts").AutoTopUpAttempt;
}

async function prepareSucceededAttempt(input?: {
  organizationId?: string;
  balance?: string;
  threshold?: string;
  amount?: string;
  paymentIntentId?: string;
}): Promise<{
  attempt: import("./auto-top-up-attempts").AutoTopUpAttempt;
  leaseToken: string;
  paymentIntentId: string;
}> {
  const organizationId = input?.organizationId ?? ORG_A;
  await insertOrganization({
    id: organizationId,
    balance: input?.balance,
    threshold: input?.threshold,
    amount: input?.amount ?? "10.01",
  });
  const claimed = await claim(organizationId);
  const leaseToken = randomUUID();
  await lease(claimed.id, leaseToken);
  const finalized = await repository.finalizeRequest({
    attemptId: claimed.id,
    leaseToken,
    chargeAmountCents: claimed.creditAmountCents + 200,
    requestMetadata: { organization_id: organizationId, source: "pglite" },
    now: at(2_000),
  });
  expect(finalized?.status).toBe("payment_pending");
  const started = await repository.markProviderRequestStarted({
    attemptId: claimed.id,
    leaseToken,
    now: at(3_000),
    recoveryDeadlineAt: at(23 * 60 * 60 * 1_000),
  });
  expect(started?.nextAttemptAt).toEqual(at(3_000));
  const paymentIntentId = input?.paymentIntentId ?? `pi_${claimed.id}`;
  const succeeded = await repository.recordPaymentIntent({
    attemptId: claimed.id,
    leaseToken,
    paymentIntentId,
    providerStatus: "succeeded",
    result: { id: paymentIntentId, status: "succeeded" },
    now: at(4_000),
  });
  expect(succeeded?.status).toBe("payment_succeeded");
  return { attempt: succeeded!, leaseToken, paymentIntentId };
}

async function scalar<T>(query: ReturnType<typeof sql>): Promise<T> {
  const result = await dbWrite.execute(query);
  const row = result.rows[0];
  if (!row) throw new Error("expected one scalar row");
  return row as T;
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } = await import(
    "../client"
  ));
  ({ autoTopUpAttemptsRepository: repository } = await import("./auto-top-up-attempts"));
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
  const migrations = await Promise.all([
    readFile(
      new URL("../migrations/0213_auto_top_up_organization_fence.sql", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../migrations/0214_backfill_auto_top_up_organization_fence.sql", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../migrations/0215_auto_top_up_attempts.sql", import.meta.url), "utf8"),
    readFile(
      new URL("../migrations/0216_auto_top_up_cutover_control.sql", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../migrations/0217_guard_auto_top_up_cutover_lifecycle.sql", import.meta.url),
      "utf8",
    ),
  ]);
  await getPgliteClientForTests().exec(migrations.join("\n"));
  const customerAuthorityMigration = await readFile(
    new URL("../migrations/0267_stripe_customer_attempts.sql", import.meta.url),
    "utf8",
  );
  for (const statement of customerAuthorityMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
}, TIMEOUT);

beforeEach(async () => {
  await getPgliteClientForTests().exec(`
    UPDATE auto_top_up_control
    SET mode = 'durable', legacy_reconciled_through = paused_at
    WHERE singleton = true;
    ALTER TABLE stripe_customer_attempts
      DISABLE TRIGGER stripe_customer_attempt_delete_guard;
    ALTER TABLE stripe_customer_legacy_quarantines
      DISABLE TRIGGER stripe_customer_legacy_quarantine_delete_guard;
    DELETE FROM auto_top_up_attempts;
    DELETE FROM auto_top_up_legacy_payment_quarantine;
    DELETE FROM stripe_customer_legacy_quarantines;
    DELETE FROM stripe_customer_attempts;
    DELETE FROM credit_transactions;
    DELETE FROM organizations;
    ALTER TABLE stripe_customer_attempts
      ENABLE TRIGGER stripe_customer_attempt_delete_guard;
    ALTER TABLE stripe_customer_legacy_quarantines
      ENABLE TRIGGER stripe_customer_legacy_quarantine_delete_guard;
    UPDATE auto_top_up_control
    SET mode = 'paused', paused_at = '${at(0).toISOString()}',
        legacy_reconciled_through = NULL, updated_at = '${at(0).toISOString()}'
    WHERE singleton = true;
  `);
  const activated = await repository.transitionControl({
    expectedMode: "paused",
    targetMode: "durable",
    legacyReconciledThrough: at(1),
    now: at(2),
  });
  expect(activated).toMatchObject({ outcome: "applied", control: { mode: "durable" } });
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("AutoTopUpAttemptsRepository", () => {
  test("keeps every multi-row reconciliation lock in organization-first order", async () => {
    const source = await readFile(new URL("./auto-top-up-attempts.ts", import.meta.url), "utf8");
    const method = (name: string, nextName: string): string => {
      const start = source.indexOf(`async ${name}`);
      const end = source.indexOf(`async ${nextName}`, start + 1);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return source.slice(start, end);
    };

    const claim = method("claimEligibleAttempt", "claimDueLease");
    const claimOrganization = claim.indexOf(".from(organizations)");
    const claimControl = claim.indexOf(".from(autoTopUpControl)");
    expect(claimOrganization).toBeGreaterThan(-1);
    expect(claimOrganization).toBeLessThan(claimControl);
    expect(claim.slice(claimOrganization, claimControl)).toContain('.for("update")');
    expect(claim.slice(claimControl)).toContain('.for("share")');

    const quarantine = method("quarantineLegacyPaymentIntent", "resolveLegacyPaymentIntent");
    const importOrganization = quarantine.indexOf(".from(organizations)");
    const importControl = quarantine.indexOf(".from(autoTopUpControl)");
    const importQuarantine = quarantine.indexOf(".from(autoTopUpLegacyPaymentQuarantine)");
    expect(importOrganization).toBeGreaterThan(-1);
    expect(importOrganization).toBeLessThan(importControl);
    expect(importControl).toBeLessThan(importQuarantine);
    expect(quarantine.slice(importOrganization, importControl)).toContain('.for("update")');
    expect(quarantine.slice(importControl, importQuarantine)).toContain('.for("share")');

    const resolve = method("resolveLegacyPaymentIntent", "findById");
    const observedQuarantine = resolve.indexOf(".from(autoTopUpLegacyPaymentQuarantine)");
    const resolveOrganization = resolve.indexOf(".from(organizations)");
    const lockedQuarantine = resolve.indexOf(
      ".from(autoTopUpLegacyPaymentQuarantine)",
      observedQuarantine + 1,
    );
    const lockedCredit = resolve.indexOf(".from(creditTransactions)");
    expect(observedQuarantine).toBeGreaterThan(-1);
    expect(resolve.slice(observedQuarantine, resolveOrganization)).not.toContain('.for("update")');
    expect(resolveOrganization).toBeLessThan(lockedQuarantine);
    expect(lockedQuarantine).toBeLessThan(lockedCredit);
    expect(resolve.slice(resolveOrganization, lockedQuarantine)).toContain('.for("update")');
    expect(resolve.slice(lockedQuarantine, lockedCredit)).toContain('.for("update")');
  });

  test("uses 0267 receipt authority instead of trusting the organization customer alone", async () => {
    await insertOrganization({ id: ORG_A });
    expect(
      await scalar<{ authoritative: boolean }>(sql`
        SELECT stripe_customer_binding_is_authoritative(${ORG_A}, 'cus_1') AS authoritative
      `),
    ).toEqual({ authoritative: true });

    // Corrupt only the test fixture through a privileged bypass, then restore
    // the immutable-authority guard before exercising the production function.
    await getPgliteClientForTests().exec(
      "ALTER TABLE stripe_customer_attempts DISABLE TRIGGER stripe_customer_attempt_authority_guard",
    );
    await dbWrite.execute(sql`
      UPDATE stripe_customer_attempts
      SET provider_receipt = jsonb_set(
        provider_receipt,
        '{metadata,organization_id}',
        to_jsonb(${ORG_B}::text)
      )
      WHERE organization_id = ${ORG_A}
    `);
    await getPgliteClientForTests().exec(
      "ALTER TABLE stripe_customer_attempts ENABLE TRIGGER stripe_customer_attempt_authority_guard",
    );
    expect(
      await scalar<{ authoritative: boolean }>(sql`
        SELECT stripe_customer_binding_is_authoritative(${ORG_A}, 'cus_1') AS authoritative
      `),
    ).toEqual({ authoritative: false });
  });

  test("starts from an explicit control state and paused mode blocks only new claims", async () => {
    const paused = await repository.transitionControl({
      expectedMode: "durable",
      targetMode: "paused",
      now: at(100),
    });
    expect(paused).toEqual({
      outcome: "applied",
      control: { mode: "paused", pausedAt: at(100), legacyReconciledThrough: null },
    });
    expect(await repository.getControl()).toEqual(paused.control);

    await insertOrganization({ id: ORG_A });
    const blocked = await repository.claimEligibleAttempt({
      organizationId: ORG_A,
      triggerSource: "cron",
      attemptId: randomUUID(),
      idempotencyKey: "paused-claim",
      now: at(101),
    });
    expect(blocked).toMatchObject({ outcome: "not_eligible", reason: "cutover_paused" });
    expect(await repository.listEligibleOrganizationIds({ limit: 100 })).toEqual([]);

    const missingWatermark = await repository.transitionControl({
      expectedMode: "paused",
      targetMode: "durable",
      now: at(102),
    });
    expect(missingWatermark).toMatchObject({
      outcome: "not_applied",
      reason: "legacy_not_reconciled",
    });
    const futureWatermark = await repository.transitionControl({
      expectedMode: "paused",
      targetMode: "durable",
      legacyReconciledThrough: at(104),
      now: at(103),
    });
    expect(futureWatermark).toMatchObject({
      outcome: "not_applied",
      reason: "future_reconciliation_watermark",
    });
    const activated = await repository.transitionControl({
      expectedMode: "paused",
      targetMode: "durable",
      legacyReconciledThrough: at(100),
      now: at(105),
    });
    expect(activated).toMatchObject({ outcome: "applied", control: { mode: "durable" } });
    expect((await claim(ORG_A, at(106))).organizationId).toBe(ORG_A);
  });

  test("linearizes a transition/claim race on the singleton phase lock", async () => {
    await insertOrganization({ id: ORG_A });
    await repository.transitionControl({
      expectedMode: "durable",
      targetMode: "paused",
      now: at(100),
    });

    const [activation, racedClaim] = await Promise.all([
      repository.transitionControl({
        expectedMode: "paused",
        targetMode: "durable",
        legacyReconciledThrough: at(100),
        now: at(101),
      }),
      repository.claimEligibleAttempt({
        organizationId: ORG_A,
        triggerSource: "cron",
        attemptId: randomUUID(),
        idempotencyKey: "phase-race",
        now: at(101),
      }),
    ]);
    expect(activation).toMatchObject({ outcome: "applied", control: { mode: "durable" } });
    expect(
      racedClaim.outcome === "created" ||
        (racedClaim.outcome === "not_eligible" && racedClaim.reason === "cutover_paused"),
    ).toBe(true);

    if (racedClaim.outcome === "not_eligible") await claim(ORG_A, at(102));
    const count = await scalar<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM auto_top_up_attempts WHERE organization_id = ${ORG_A}`,
    );
    expect(count.count).toBe("1");
  });

  test("uses the canonical organization fence for conservative baseline and first claim", async () => {
    await insertOrganization({ id: ORG_A });
    await dbWrite.execute(sql`
      UPDATE organizations
      SET auto_top_up_covered_balance_decrease_revision = balance_decrease_revision
      WHERE id = ${ORG_A}
    `);
    const baseline = await repository.claimEligibleAttempt({
      organizationId: ORG_A,
      triggerSource: "cron",
      attemptId: randomUUID(),
      idempotencyKey: "existing-baseline",
      now: at(100),
    });
    expect(baseline).toMatchObject({ outcome: "not_eligible", reason: "balance_not_rearmed" });

    await dbWrite.execute(sql`UPDATE organizations SET credit_balance = 0.50 WHERE id = ${ORG_A}`);
    expect((await claim(ORG_A, at(101))).organizationId).toBe(ORG_A);

    await insertOrganization({ id: ORG_B });
    const newOrganizationFence = await scalar<{ covered: string | null }>(sql`
      SELECT auto_top_up_covered_balance_decrease_revision::text AS covered
      FROM organizations WHERE id = ${ORG_B}
    `);
    expect(newOrganizationFence.covered).toBeNull();
    expect((await claim(ORG_B, at(102))).organizationId).toBe(ORG_B);

    await insertOrganization({ id: ORG_C });
    await dbWrite.execute(sql`
      UPDATE organizations
      SET auto_top_up_covered_balance_decrease_revision = balance_decrease_revision + 1000
      WHERE id = ${ORG_C}
    `);
    expect(
      await repository.claimEligibleAttempt({
        organizationId: ORG_C,
        triggerSource: "cron",
        attemptId: randomUUID(),
        idempotencyKey: "future-corrupt-fence",
        now: at(103),
      }),
    ).toMatchObject({ outcome: "not_eligible", reason: "balance_not_rearmed" });
    expect(await repository.listEligibleOrganizationIds({ limit: 100 })).toEqual([]);
  });

  test("reads an exact legacy quarantine snapshot without changing its lifecycle", async () => {
    await insertOrganization({ id: ORG_A });
    await repository.transitionControl({
      expectedMode: "durable",
      targetMode: "paused",
      now: at(100),
    });
    const quarantined = await repository.quarantineLegacyPaymentIntent({
      organizationId: ORG_A,
      paymentIntentId: "pi_exact_quarantine_read",
      providerStatus: "processing",
      creditAmountCents: 1000,
      metadata: { inventorySha256: "reviewed-plan" },
      now: at(101),
    });

    expect(
      await repository.findLegacyPaymentByStripePaymentIntentId("pi_exact_quarantine_read"),
    ).toEqual(quarantined);
    expect(await repository.findLegacyPaymentByStripePaymentIntentId("pi_missing")).toBeNull();
    await expect(repository.findLegacyPaymentByStripePaymentIntentId("")).rejects.toThrow(
      "missing or non-canonical",
    );
    expect(
      await repository.findLegacyPaymentByStripePaymentIntentId("pi_exact_quarantine_read"),
    ).toMatchObject({
      status: "unresolved",
      providerStatus: "processing",
      metadata: { inventorySha256: "reviewed-plan" },
      resolvedAt: null,
    });
  });

  test("quarantines only known legacy PIs and verifies credited/canceled/manual-review resolution", async () => {
    await insertOrganization({ id: ORG_A });
    await repository.transitionControl({
      expectedMode: "durable",
      targetMode: "paused",
      now: at(100),
    });
    const quarantined = await repository.quarantineLegacyPaymentIntent({
      organizationId: ORG_A,
      paymentIntentId: "pi_imported_legacy",
      providerStatus: "processing",
      creditAmountCents: 1000,
      metadata: { source: "stripe_reconciliation" },
      now: at(101),
    });
    expect(quarantined).toMatchObject({ status: "unresolved", creditTransactionId: null });
    expect(
      await repository.resolveLegacyPaymentIntent({
        paymentIntentId: "pi_imported_legacy",
        resolution: "credited",
        metadata: { checked: true },
        now: at(102),
      }),
    ).toBeNull();
    expect(
      await repository.quarantineLegacyPaymentIntent({
        organizationId: ORG_A,
        paymentIntentId: "pi_imported_legacy",
        providerStatus: "succeeded",
        creditAmountCents: 1000,
        metadata: { source: "stripe_reconciliation", refreshed: true },
        now: at(103),
      }),
    ).toMatchObject({ providerStatus: "succeeded", status: "unresolved" });
    expect(
      await repository.transitionControl({
        expectedMode: "paused",
        targetMode: "durable",
        legacyReconciledThrough: at(100),
        now: at(104),
      }),
    ).toMatchObject({ outcome: "not_applied", reason: "legacy_quarantine" });

    const inserted = await dbWrite.execute(sql`
      INSERT INTO credit_transactions (
        organization_id, amount, type, metadata, stripe_payment_intent_id
      ) VALUES (
        ${ORG_A}, 10, 'credit', '{"type":"auto_top_up"}'::jsonb, 'pi_imported_legacy'
      ) RETURNING id::text AS id
    `);
    const creditTransactionId = String(inserted.rows[0]?.id);
    expect(
      await repository.resolveLegacyPaymentIntent({
        paymentIntentId: "pi_imported_legacy",
        resolution: "canceled",
        metadata: { checked: true },
        now: at(105),
      }),
    ).toBeNull();
    expect(
      await repository.resolveLegacyPaymentIntent({
        paymentIntentId: "pi_imported_legacy",
        resolution: "credited",
        metadata: { checked: true },
        now: at(106),
      }),
    ).toMatchObject({ status: "credited", creditTransactionId });
    expect(
      await repository.transitionControl({
        expectedMode: "paused",
        targetMode: "durable",
        legacyReconciledThrough: at(100),
        now: at(107),
      }),
    ).toMatchObject({ outcome: "applied" });

    await repository.transitionControl({
      expectedMode: "durable",
      targetMode: "paused",
      now: at(110),
    });
    const review = await repository.quarantineLegacyPaymentIntent({
      organizationId: ORG_A,
      paymentIntentId: "pi_imported_review",
      providerStatus: "unknown",
      creditAmountCents: 1000,
      metadata: {},
      now: at(111),
    });
    expect(review).not.toBeNull();
    expect(
      await repository.resolveLegacyPaymentIntent({
        paymentIntentId: "pi_imported_review",
        resolution: "credited",
        metadata: {},
        now: at(111),
      }),
    ).toBeNull();
    expect(
      await repository.resolveLegacyPaymentIntent({
        paymentIntentId: "pi_imported_review",
        resolution: "canceled",
        metadata: {},
        now: at(111),
      }),
    ).toBeNull();
    expect(
      await repository.resolveLegacyPaymentIntent({
        paymentIntentId: "pi_imported_review",
        resolution: "manual_review",
        metadata: { operator: "required" },
        now: at(112),
      }),
    ).toMatchObject({ status: "manual_review", resolvedAt: null });
    expect(
      await scalar<{ enabled: boolean }>(
        sql`SELECT auto_top_up_enabled AS enabled FROM organizations WHERE id = ${ORG_A}`,
      ),
    ).toEqual({ enabled: false });
    expect(
      await repository.transitionControl({
        expectedMode: "paused",
        targetMode: "durable",
        legacyReconciledThrough: at(110),
        now: at(113),
      }),
    ).toMatchObject({ outcome: "applied" });
    expect(await repository.findBlockingLegacyPaymentByOrganization(ORG_A)).toMatchObject({
      stripePaymentIntentId: "pi_imported_review",
      status: "manual_review",
    });
    await dbWrite.execute(sql`
      UPDATE organizations
      SET auto_top_up_enabled = true,
          auto_top_up_covered_balance_decrease_revision = NULL
      WHERE id = ${ORG_A}
    `);
    expect(await repository.listEligibleOrganizationIds({ limit: 100 })).toEqual([]);
    expect(
      await repository.claimEligibleAttempt({
        organizationId: ORG_A,
        triggerSource: "manual",
        attemptId: randomUUID(),
        idempotencyKey: "manual-review-must-still-block",
        now: at(114),
      }),
    ).toMatchObject({ outcome: "not_eligible", reason: "legacy_payment_unresolved" });
    expect(
      await scalar<{ enabled: boolean }>(
        sql`SELECT auto_top_up_enabled AS enabled FROM organizations WHERE id = ${ORG_A}`,
      ),
    ).toEqual({ enabled: false });
    expect(
      await repository.quarantineLegacyPaymentIntent({
        organizationId: ORG_A,
        paymentIntentId: "pi_must_not_import_after_activation",
        providerStatus: "unknown",
        creditAmountCents: 1000,
        metadata: {},
        now: at(115),
      }),
    ).toBeNull();
  });

  test("unresolved legacy quarantine remains an authoritative claim fence", async () => {
    await insertOrganization({ id: ORG_A });
    await repository.transitionControl({
      expectedMode: "durable",
      targetMode: "paused",
      now: at(100),
    });
    await repository.quarantineLegacyPaymentIntent({
      organizationId: ORG_A,
      paymentIntentId: "pi_still_unresolved",
      providerStatus: "processing",
      creditAmountCents: 1000,
      metadata: { source: "stripe_reconciliation" },
      now: at(101),
    });
    expect(await repository.findBlockingLegacyPaymentByOrganization(ORG_A)).toMatchObject({
      stripePaymentIntentId: "pi_still_unresolved",
      status: "unresolved",
    });
    expect(
      await repository.transitionControl({
        expectedMode: "paused",
        targetMode: "durable",
        legacyReconciledThrough: at(100),
        now: at(102),
      }),
    ).toMatchObject({ outcome: "not_applied", reason: "legacy_quarantine" });

    // Defense in depth: even if the singleton were changed outside the checked
    // CAS, the tenant claim remains the authoritative payment boundary.
    await dbWrite.execute(sql`
      UPDATE auto_top_up_control
      SET mode = 'durable', legacy_reconciled_through = ${at(100)}, updated_at = ${at(103)}
      WHERE singleton = true
    `);
    await dbWrite.execute(sql`
      UPDATE organizations
      SET auto_top_up_enabled = true,
          auto_top_up_covered_balance_decrease_revision = NULL
      WHERE id = ${ORG_A}
    `);
    expect(await repository.listEligibleOrganizationIds({ limit: 100 })).toEqual([]);
    expect(
      await repository.claimEligibleAttempt({
        organizationId: ORG_A,
        triggerSource: "cron",
        attemptId: randomUUID(),
        idempotencyKey: "unresolved-must-still-block",
        now: at(104),
      }),
    ).toMatchObject({ outcome: "not_eligible", reason: "legacy_payment_unresolved" });
    expect(
      await scalar<{ enabled: boolean }>(
        sql`SELECT auto_top_up_enabled AS enabled FROM organizations WHERE id = ${ORG_A}`,
      ),
    ).toEqual({ enabled: false });
    expect(
      await scalar<{ count: string }>(sql`
        SELECT count(*)::text AS count FROM auto_top_up_attempts WHERE organization_id = ${ORG_A}
      `),
    ).toEqual({ count: "0" });
  });

  test("refreshes nonterminal legacy provider status without rewriting identity or terminal state", async () => {
    await insertOrganization({ id: ORG_A });
    await insertOrganization({ id: ORG_B });
    await repository.transitionControl({
      expectedMode: "durable",
      targetMode: "paused",
      now: at(100),
    });
    await repository.quarantineLegacyPaymentIntent({
      organizationId: ORG_A,
      paymentIntentId: "pi_processing_to_canceled",
      providerStatus: "processing",
      creditAmountCents: 1000,
      metadata: { poll: 1 },
      now: at(101),
    });
    await expect(
      repository.quarantineLegacyPaymentIntent({
        organizationId: ORG_B,
        paymentIntentId: "pi_processing_to_canceled",
        providerStatus: "processing",
        creditAmountCents: 1000,
        metadata: {},
        now: at(102),
      }),
    ).rejects.toThrow(/another organization/i);
    await expect(
      repository.quarantineLegacyPaymentIntent({
        organizationId: ORG_A,
        paymentIntentId: "pi_processing_to_canceled",
        providerStatus: "processing",
        creditAmountCents: 1100,
        metadata: {},
        now: at(102),
      }),
    ).rejects.toThrow(/snapshot conflicts/i);

    expect(
      await repository.quarantineLegacyPaymentIntent({
        organizationId: ORG_A,
        paymentIntentId: "pi_processing_to_canceled",
        providerStatus: "canceled",
        creditAmountCents: 1000,
        metadata: { poll: 2 },
        now: at(103),
      }),
    ).toMatchObject({ providerStatus: "canceled", status: "unresolved" });
    expect(
      await repository.resolveLegacyPaymentIntent({
        paymentIntentId: "pi_processing_to_canceled",
        resolution: "canceled",
        metadata: { resolution: "provider_confirmed" },
        now: at(104),
      }),
    ).toMatchObject({ providerStatus: "canceled", status: "canceled" });
    await expect(
      repository.quarantineLegacyPaymentIntent({
        organizationId: ORG_A,
        paymentIntentId: "pi_processing_to_canceled",
        providerStatus: "succeeded",
        creditAmountCents: 1000,
        metadata: {},
        now: at(105),
      }),
    ).rejects.toThrow(/terminal status cannot be rewritten/i);
  });

  test("rejects legacy credit adoption with wrong metadata, amount, or canceled provider state", async () => {
    await insertOrganization({ id: ORG_A });
    await insertOrganization({ id: ORG_B });
    await insertOrganization({ id: ORG_C });
    await repository.transitionControl({
      expectedMode: "durable",
      targetMode: "paused",
      now: at(100),
    });

    await repository.quarantineLegacyPaymentIntent({
      organizationId: ORG_A,
      paymentIntentId: "pi_wrong_credit_metadata",
      providerStatus: "succeeded",
      creditAmountCents: 1000,
      metadata: {},
      now: at(101),
    });
    await dbWrite.execute(sql`
      INSERT INTO credit_transactions (
        organization_id, amount, type, metadata, stripe_payment_intent_id
      ) VALUES (${ORG_A}, 10, 'credit', '{"type":"grant"}'::jsonb, 'pi_wrong_credit_metadata')
    `);
    expect(
      await repository.resolveLegacyPaymentIntent({
        paymentIntentId: "pi_wrong_credit_metadata",
        resolution: "credited",
        metadata: {},
        now: at(102),
      }),
    ).toBeNull();

    await repository.quarantineLegacyPaymentIntent({
      organizationId: ORG_B,
      paymentIntentId: "pi_wrong_credit_amount",
      providerStatus: "succeeded",
      creditAmountCents: 1000,
      metadata: {},
      now: at(103),
    });
    await dbWrite.execute(sql`
      INSERT INTO credit_transactions (
        organization_id, amount, type, metadata, stripe_payment_intent_id
      ) VALUES (${ORG_B}, 9.99, 'credit', '{"type":"auto_top_up"}'::jsonb, 'pi_wrong_credit_amount')
    `);
    expect(
      await repository.resolveLegacyPaymentIntent({
        paymentIntentId: "pi_wrong_credit_amount",
        resolution: "credited",
        metadata: {},
        now: at(104),
      }),
    ).toBeNull();

    await repository.quarantineLegacyPaymentIntent({
      organizationId: ORG_C,
      paymentIntentId: "pi_canceled_with_credit",
      providerStatus: "canceled",
      creditAmountCents: 1000,
      metadata: {},
      now: at(105),
    });
    await dbWrite.execute(sql`
      INSERT INTO credit_transactions (
        organization_id, amount, type, metadata, stripe_payment_intent_id
      ) VALUES (${ORG_C}, 10, 'credit', '{"type":"auto_top_up"}'::jsonb, 'pi_canceled_with_credit')
    `);
    expect(
      await repository.resolveLegacyPaymentIntent({
        paymentIntentId: "pi_canceled_with_credit",
        resolution: "canceled",
        metadata: {},
        now: at(106),
      }),
    ).toBeNull();
    expect(
      await repository.resolveLegacyPaymentIntent({
        paymentIntentId: "pi_canceled_with_credit",
        resolution: "credited",
        metadata: {},
        now: at(107),
      }),
    ).toBeNull();
  });

  test("refreshes existing manual-review PIs after activation but never imports a new PI", async () => {
    await insertOrganization({ id: ORG_A });
    await insertOrganization({ id: ORG_B });
    await repository.transitionControl({
      expectedMode: "durable",
      targetMode: "paused",
      now: at(100),
    });
    for (const [organizationId, paymentIntentId] of [
      [ORG_A, "pi_durable_refresh_succeeded"],
      [ORG_B, "pi_durable_refresh_canceled"],
    ] as const) {
      await repository.quarantineLegacyPaymentIntent({
        organizationId,
        paymentIntentId,
        providerStatus: "processing",
        creditAmountCents: 1000,
        metadata: {},
        now: at(101),
      });
      await repository.resolveLegacyPaymentIntent({
        paymentIntentId,
        resolution: "manual_review",
        metadata: { reason: "awaiting_terminal_provider_status" },
        now: at(102),
      });
    }
    expect(
      await repository.transitionControl({
        expectedMode: "paused",
        targetMode: "durable",
        legacyReconciledThrough: at(100),
        now: at(103),
      }),
    ).toMatchObject({ outcome: "applied" });
    expect(
      await repository.quarantineLegacyPaymentIntent({
        organizationId: ORG_A,
        paymentIntentId: "pi_unknown_after_activation",
        providerStatus: "processing",
        creditAmountCents: 1000,
        metadata: {},
        now: at(104),
      }),
    ).toBeNull();

    expect(
      await repository.quarantineLegacyPaymentIntent({
        organizationId: ORG_A,
        paymentIntentId: "pi_durable_refresh_succeeded",
        providerStatus: "succeeded",
        creditAmountCents: 1000,
        metadata: { poll: "terminal" },
        now: at(105),
      }),
    ).toMatchObject({ status: "manual_review", providerStatus: "succeeded" });
    await dbWrite.execute(sql`
      INSERT INTO credit_transactions (
        organization_id, amount, type, metadata, stripe_payment_intent_id
      ) VALUES (
        ${ORG_A}, 10, 'credit', '{"type":"auto_top_up"}'::jsonb,
        'pi_durable_refresh_succeeded'
      )
    `);
    expect(
      await repository.resolveLegacyPaymentIntent({
        paymentIntentId: "pi_durable_refresh_succeeded",
        resolution: "credited",
        metadata: { reconciled: true },
        now: at(106),
      }),
    ).toMatchObject({ status: "credited", providerStatus: "succeeded" });

    expect(
      await repository.quarantineLegacyPaymentIntent({
        organizationId: ORG_B,
        paymentIntentId: "pi_durable_refresh_canceled",
        providerStatus: "canceled",
        creditAmountCents: 1000,
        metadata: { poll: "terminal" },
        now: at(107),
      }),
    ).toMatchObject({ status: "manual_review", providerStatus: "canceled" });
    expect(
      await repository.resolveLegacyPaymentIntent({
        paymentIntentId: "pi_durable_refresh_canceled",
        resolution: "canceled",
        metadata: { reconciled: true },
        now: at(108),
      }),
    ).toMatchObject({ status: "canceled", providerStatus: "canceled" });
  });

  test("linearizes concurrent claims and reuses the durable provider snapshot", async () => {
    await insertOrganization({ id: ORG_A, amount: "10.01" });
    const firstId = randomUUID();
    const secondId = randomUUID();
    const [first, second] = await Promise.all([
      repository.claimEligibleAttempt({
        organizationId: ORG_A,
        triggerSource: "cron",
        attemptId: firstId,
        idempotencyKey: "claim-race-first",
        now: at(0),
      }),
      repository.claimEligibleAttempt({
        organizationId: ORG_A,
        triggerSource: "credit_deduction",
        attemptId: secondId,
        idempotencyKey: "claim-race-second",
        now: at(0),
      }),
    ]);

    expect([first.outcome, second.outcome].sort()).toEqual(["created", "reused"]);
    if (first.outcome === "not_eligible" || second.outcome === "not_eligible") {
      throw new Error("concurrent eligible claims must create or reuse");
    }
    expect(second.attempt.id).toBe(first.attempt.id);
    expect(first.attempt.creditAmountCents).toBe(1001);
    const count = await scalar<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM auto_top_up_attempts`,
    );
    expect(count.count).toBe("1");

    // Model out-of-band publication drift without weakening the real 0267
    // guard for the rest of the suite. The replay must retain its persisted
    // provider snapshot even if a privileged repair changes the organization.
    await getPgliteClientForTests().exec(
      "ALTER TABLE organizations DISABLE TRIGGER organization_stripe_customer_publication_guard",
    );
    await dbWrite.execute(sql`
      UPDATE organizations
      SET auto_top_up_amount = 20, stripe_customer_id = 'cus_changed'
      WHERE id = ${ORG_A}
    `);
    await getPgliteClientForTests().exec(
      "ALTER TABLE organizations ENABLE TRIGGER organization_stripe_customer_publication_guard",
    );
    const replay = await repository.claimEligibleAttempt({
      organizationId: ORG_A,
      triggerSource: "manual",
      attemptId: randomUUID(),
      idempotencyKey: "claim-after-settings-change",
      now: at(2_000),
    });
    expect(replay.outcome).toBe("reused");
    if (replay.outcome !== "not_eligible") {
      expect(replay.attempt.creditAmountCents).toBe(1001);
      expect(replay.attempt.stripeCustomerId).toBe("cus_1");
    }
  });

  test("fails closed on out-of-domain amounts and accepts a canonical signed balance", async () => {
    await insertOrganization({ id: ORG_A, balance: "-1.250000" });
    await insertOrganization({ id: ORG_B, threshold: "1000.01" });
    await insertOrganization({ id: ORG_C, amount: "0.99" });
    await insertOrganization({ id: ORG_D, customerId: null });
    await insertOrganization({ id: ORG_E, paymentMethodId: " " });
    await insertOrganization({ id: ORG_F, balance: "NaN" });
    await insertOrganization({ id: ORG_G, balance: "5.00", threshold: "5.00" });

    const signed = await repository.claimEligibleAttempt({
      organizationId: ORG_A,
      triggerSource: "cron",
      attemptId: randomUUID(),
      idempotencyKey: "signed-balance",
      now: at(0),
    });
    expect(signed.outcome).toBe("created");

    const badThreshold = await repository.claimEligibleAttempt({
      organizationId: ORG_B,
      triggerSource: "cron",
      attemptId: randomUUID(),
      idempotencyKey: "bad-threshold",
      now: at(1_000),
    });
    expect(badThreshold).toMatchObject({ outcome: "not_eligible", reason: "invalid_threshold" });

    const subMinimum = await repository.claimEligibleAttempt({
      organizationId: ORG_C,
      triggerSource: "cron",
      attemptId: randomUUID(),
      idempotencyKey: "sub-minimum",
      now: at(1_000),
    });
    expect(subMinimum).toMatchObject({ outcome: "not_eligible", reason: "invalid_amount" });

    const missingCustomer = await repository.claimEligibleAttempt({
      organizationId: ORG_D,
      triggerSource: "cron",
      attemptId: randomUUID(),
      idempotencyKey: "missing-customer",
      now: at(1_000),
    });
    expect(missingCustomer).toMatchObject({
      outcome: "not_eligible",
      reason: "missing_customer",
    });

    const missingPaymentMethod = await repository.claimEligibleAttempt({
      organizationId: ORG_E,
      triggerSource: "cron",
      attemptId: randomUUID(),
      idempotencyKey: "missing-payment-method",
      now: at(1_000),
    });
    expect(missingPaymentMethod).toMatchObject({
      outcome: "not_eligible",
      reason: "missing_payment_method",
    });

    const invalidBalance = await repository.claimEligibleAttempt({
      organizationId: ORG_F,
      triggerSource: "cron",
      attemptId: randomUUID(),
      idempotencyKey: "invalid-balance",
      now: at(1_000),
    });
    expect(invalidBalance).toMatchObject({ outcome: "not_eligible", reason: "invalid_balance" });

    const atThreshold = await repository.claimEligibleAttempt({
      organizationId: ORG_G,
      triggerSource: "cron",
      attemptId: randomUUID(),
      idempotencyKey: "at-threshold",
      now: at(2_000),
    });
    expect(atThreshold).toMatchObject({
      outcome: "not_eligible",
      reason: "balance_at_or_above_threshold",
    });

    const enabledRows = await dbWrite.execute(sql`
      SELECT id, auto_top_up_enabled AS enabled, updated_at
      FROM organizations
      WHERE id IN (${ORG_A}, ${ORG_B}, ${ORG_C}, ${ORG_D}, ${ORG_E}, ${ORG_F}, ${ORG_G})
      ORDER BY id
    `);
    expect(enabledRows.rows).toEqual([
      { id: ORG_A, enabled: true, updated_at: "2026-08-17 12:00:00" },
      { id: ORG_B, enabled: false, updated_at: "2026-08-17 12:00:01" },
      { id: ORG_C, enabled: false, updated_at: "2026-08-17 12:00:01" },
      { id: ORG_D, enabled: false, updated_at: "2026-08-17 12:00:01" },
      { id: ORG_E, enabled: false, updated_at: "2026-08-17 12:00:01" },
      { id: ORG_F, enabled: false, updated_at: "2026-08-17 12:00:01" },
      { id: ORG_G, enabled: true, updated_at: "2026-08-17 12:00:00" },
    ]);
  });

  test("keeps finalized charge metadata immutable and makes stamped work due after lease expiry", async () => {
    await insertOrganization({ id: ORG_A });
    const attempt = await claim();
    const leaseToken = randomUUID();
    await lease(attempt.id, leaseToken);
    const metadata = { stable: true, nested: { fee_cents: 200 } };
    const finalized = await repository.finalizeRequest({
      attemptId: attempt.id,
      leaseToken,
      chargeAmountCents: 1200,
      requestMetadata: metadata,
      now: at(2_000),
    });
    expect(finalized?.chargeAmountCents).toBe(1200);
    expect(
      await repository.finalizeRequest({
        attemptId: attempt.id,
        leaseToken,
        chargeAmountCents: 1200,
        requestMetadata: metadata,
        now: at(2_500),
      }),
    ).not.toBeNull();
    expect(
      await repository.finalizeRequest({
        attemptId: attempt.id,
        leaseToken,
        chargeAmountCents: 1300,
        requestMetadata: metadata,
        now: at(2_500),
      }),
    ).toBeNull();

    const started = await repository.markProviderRequestStarted({
      attemptId: attempt.id,
      leaseToken,
      now: at(3_000),
      recoveryDeadlineAt: at(23 * 60 * 60 * 1_000),
    });
    expect(started?.nextAttemptAt).toEqual(at(3_000));
    expect(await repository.listDue({ now: at(30_000), limit: 10 })).toEqual([]);
    expect((await repository.listDue({ now: at(62_000), limit: 10 })).map((row) => row.id)).toEqual(
      [attempt.id],
    );
  });

  test("fences stale terminal leases and disables only with a live cancel or review lease", async () => {
    await insertOrganization({ id: ORG_A });
    const attempt = await claim();
    const staleToken = randomUUID();
    await lease(attempt.id, staleToken, at(1_000), at(10_000));
    expect(
      await repository.markCanceled({
        attemptId: attempt.id,
        leaseToken: staleToken,
        error: "declined",
        now: at(11_000),
      }),
    ).toBeNull();
    expect(
      (
        await scalar<{ auto_top_up_enabled: boolean }>(
          sql`SELECT auto_top_up_enabled FROM organizations WHERE id = ${ORG_A}`,
        )
      ).auto_top_up_enabled,
    ).toBe(true);

    const liveToken = randomUUID();
    await lease(attempt.id, liveToken, at(11_000), at(30_000));
    expect(
      await repository.finalizeRequest({
        attemptId: attempt.id,
        leaseToken: staleToken,
        chargeAmountCents: 1000,
        requestMetadata: {},
        now: at(12_000),
      }),
    ).toBeNull();
    const canceled = await repository.markCanceled({
      attemptId: attempt.id,
      leaseToken: liveToken,
      error: "requires_payment_method",
      result: { status: "requires_payment_method" },
      now: at(12_000),
    });
    expect(canceled?.status).toBe("canceled");
    expect(
      (
        await scalar<{ auto_top_up_enabled: boolean }>(
          sql`SELECT auto_top_up_enabled FROM organizations WHERE id = ${ORG_A}`,
        )
      ).auto_top_up_enabled,
    ).toBe(false);

    await insertOrganization({ id: ORG_B });
    const reviewAttempt = await claim(ORG_B);
    const staleReviewToken = randomUUID();
    await lease(reviewAttempt.id, staleReviewToken, at(13_000), at(20_000));
    expect(
      await repository.markManualReview({
        attemptId: reviewAttempt.id,
        leaseToken: staleReviewToken,
        error: "ambiguous provider state",
        now: at(21_000),
      }),
    ).toBeNull();
    expect(
      (
        await scalar<{ auto_top_up_enabled: boolean }>(
          sql`SELECT auto_top_up_enabled FROM organizations WHERE id = ${ORG_B}`,
        )
      ).auto_top_up_enabled,
    ).toBe(true);

    const liveReviewToken = randomUUID();
    await lease(reviewAttempt.id, liveReviewToken, at(21_000), at(40_000));
    const reviewed = await repository.markManualReview({
      attemptId: reviewAttempt.id,
      leaseToken: liveReviewToken,
      error: "ambiguous provider state",
      result: { requires_operator: true },
      now: at(22_000),
    });
    expect(reviewed).toMatchObject({
      status: "manual_review",
      nextAttemptAt: null,
      leaseToken: null,
    });
    expect(
      (
        await scalar<{ auto_top_up_enabled: boolean }>(
          sql`SELECT auto_top_up_enabled FROM organizations WHERE id = ${ORG_B}`,
        )
      ).auto_top_up_enabled,
    ).toBe(false);
  });

  test("refuses to cancel provider-started work without an authoritative canceled PI", async () => {
    await insertOrganization({ id: ORG_A });
    const attempt = await claim();
    const leaseToken = randomUUID();
    await lease(attempt.id, leaseToken, at(1_000), at(60_000));
    await repository.finalizeRequest({
      attemptId: attempt.id,
      leaseToken,
      chargeAmountCents: 1000,
      requestMetadata: {},
      now: at(2_000),
    });
    await repository.markProviderRequestStarted({
      attemptId: attempt.id,
      leaseToken,
      now: at(3_000),
      recoveryDeadlineAt: at(23 * 60 * 60 * 1_000),
    });

    expect(
      await repository.markCanceled({
        attemptId: attempt.id,
        leaseToken,
        error: "ambiguous provider boundary",
        now: at(4_000),
      }),
    ).toBeNull();
    expect(await repository.findById(attempt.id)).toMatchObject({
      status: "payment_pending",
      stripePaymentIntentId: null,
      providerRequestStartedAt: at(3_000),
    });
    expect(
      await scalar<{ enabled: boolean }>(sql`
        SELECT auto_top_up_enabled AS enabled FROM organizations WHERE id = ${ORG_A}
      `),
    ).toEqual({ enabled: true });
    expect(
      await repository.markManualReview({
        attemptId: attempt.id,
        leaseToken,
        error: "ambiguous provider boundary",
        now: at(5_000),
      }),
    ).toMatchObject({ status: "manual_review" });
  });

  test("reopens a late signed success from manual review but never from canceled", async () => {
    await insertOrganization({ id: ORG_A });
    const reviewedAttempt = await claim();
    const reviewLeaseToken = randomUUID();
    await lease(reviewedAttempt.id, reviewLeaseToken);
    await repository.finalizeRequest({
      attemptId: reviewedAttempt.id,
      leaseToken: reviewLeaseToken,
      chargeAmountCents: 1000,
      requestMetadata: { source: "late-webhook" },
      now: at(2_000),
    });
    await repository.markProviderRequestStarted({
      attemptId: reviewedAttempt.id,
      leaseToken: reviewLeaseToken,
      now: at(3_000),
      recoveryDeadlineAt: at(23 * 60 * 60 * 1_000),
    });
    const reviewed = await repository.markManualReview({
      attemptId: reviewedAttempt.id,
      leaseToken: reviewLeaseToken,
      error: "provider outcome unknown",
      now: at(4_000),
    });
    expect(reviewed).toMatchObject({ status: "manual_review", manualReviewAt: at(4_000) });

    const reopened = await repository.reopenManualReviewForSucceededPayment({
      attemptId: reviewedAttempt.id,
      paymentIntentId: "pi_late_signed_success",
      result: { id: "pi_late_signed_success", status: "succeeded" },
      now: at(5_000),
    });
    expect(reopened).toMatchObject({
      status: "payment_succeeded",
      stripePaymentIntentId: "pi_late_signed_success",
      providerStatus: "succeeded",
      leaseToken: null,
      nextAttemptAt: at(5_000),
      manualReviewAt: at(4_000),
    });
    expect((await repository.listDue({ now: at(5_000), limit: 10 })).map((row) => row.id)).toEqual([
      reviewedAttempt.id,
    ]);
    expect(
      await repository.reopenManualReviewForSucceededPayment({
        attemptId: reviewedAttempt.id,
        paymentIntentId: "pi_late_signed_success",
        result: { duplicate: true },
        now: at(5_500),
      }),
    ).toMatchObject({ status: "payment_succeeded", paymentSucceededAt: at(5_000) });

    const recoveryLeaseToken = randomUUID();
    await lease(reviewedAttempt.id, recoveryLeaseToken, at(6_000), at(60_000));
    expect(
      await repository.settleSucceededAttempt({
        attemptId: reviewedAttempt.id,
        leaseToken: recoveryLeaseToken,
        now: at(7_000),
      }),
    ).toMatchObject({ outcome: "applied" });
    expect(
      (
        await scalar<{ auto_top_up_enabled: boolean }>(
          sql`SELECT auto_top_up_enabled FROM organizations WHERE id = ${ORG_A}`,
        )
      ).auto_top_up_enabled,
    ).toBe(false);

    await insertOrganization({ id: ORG_B });
    const canceledAttempt = await claim(ORG_B);
    const cancelLeaseToken = randomUUID();
    await lease(canceledAttempt.id, cancelLeaseToken);
    await repository.finalizeRequest({
      attemptId: canceledAttempt.id,
      leaseToken: cancelLeaseToken,
      chargeAmountCents: 1000,
      requestMetadata: {},
      now: at(2_000),
    });
    await repository.markProviderRequestStarted({
      attemptId: canceledAttempt.id,
      leaseToken: cancelLeaseToken,
      now: at(3_000),
      recoveryDeadlineAt: at(23 * 60 * 60 * 1_000),
    });
    await repository.recordPaymentIntent({
      attemptId: canceledAttempt.id,
      leaseToken: cancelLeaseToken,
      paymentIntentId: "pi_must_stay_canceled",
      providerStatus: "canceled",
      result: { status: "canceled" },
      now: at(3_500),
    });
    await repository.markCanceled({
      attemptId: canceledAttempt.id,
      leaseToken: cancelLeaseToken,
      error: "terminal decline",
      now: at(4_000),
    });
    expect(
      await repository.reopenManualReviewForSucceededPayment({
        attemptId: canceledAttempt.id,
        paymentIntentId: "pi_must_stay_canceled",
        result: { status: "succeeded" },
        now: at(5_000),
      }),
    ).toBeNull();
    expect(await repository.findById(canceledAttempt.id)).toMatchObject({ status: "canceled" });
  });

  test("bounds unknown-PI retry by recovery deadline but preserves known-PI retry", async () => {
    await insertOrganization({ id: ORG_A });
    const unknown = await claim();
    const unknownToken = randomUUID();
    await lease(unknown.id, unknownToken, at(1_000), at(120_000));
    await repository.finalizeRequest({
      attemptId: unknown.id,
      leaseToken: unknownToken,
      chargeAmountCents: 1000,
      requestMetadata: {},
      now: at(2_000),
    });
    const deadline = at(30_000);
    await repository.markProviderRequestStarted({
      attemptId: unknown.id,
      leaseToken: unknownToken,
      now: at(3_000),
      recoveryDeadlineAt: deadline,
    });
    const unknownFailed = await repository.recordFailure({
      attemptId: unknown.id,
      leaseToken: unknownToken,
      error: "response lost",
      nextAttemptAt: at(40_000),
      now: at(4_000),
    });
    expect(unknownFailed?.nextAttemptAt).toEqual(deadline);

    await insertOrganization({ id: ORG_B });
    const known = await claim(ORG_B, at(6_000));
    const knownToken = randomUUID();
    await lease(known.id, knownToken, at(7_000), at(120_000));
    await repository.finalizeRequest({
      attemptId: known.id,
      leaseToken: knownToken,
      chargeAmountCents: 1000,
      requestMetadata: {},
      now: at(8_000),
    });
    await repository.markProviderRequestStarted({
      attemptId: known.id,
      leaseToken: knownToken,
      now: at(9_000),
      recoveryDeadlineAt: at(30_000),
    });
    await repository.recordPaymentIntent({
      attemptId: known.id,
      leaseToken: knownToken,
      paymentIntentId: "pi_processing",
      providerStatus: "processing",
      result: { status: "processing" },
      now: at(10_000),
    });
    const knownFailed = await repository.recordFailure({
      attemptId: known.id,
      leaseToken: knownToken,
      error: "still processing",
      nextAttemptAt: at(40_000),
      now: at(11_000),
    });
    expect(knownFailed?.nextAttemptAt).toEqual(at(40_000));
  });

  test("recovers a crash after credit application without double-crediting", async () => {
    const { attempt, leaseToken } = await prepareSucceededAttempt({ amount: "10.01" });
    await dbWrite.execute(
      sql`UPDATE organizations SET credit_balance='1.234567' WHERE id=${ORG_A}`,
    );
    const applied = await repository.settleSucceededAttempt({
      attemptId: attempt.id,
      leaseToken,
      now: at(5_000),
    });
    expect(applied).toMatchObject({ outcome: "applied", newBalance: "11.244567" });
    expect(applied?.attempt.status).toBe("payment_succeeded");
    expect(applied?.attempt.creditTransactionId).not.toBeNull();

    // Simulate process death/cache invalidation failure: do not markCredited.
    const recoveryToken = randomUUID();
    await lease(attempt.id, recoveryToken, at(62_000), at(122_000));
    const recovered = await repository.settleSucceededAttempt({
      attemptId: attempt.id,
      leaseToken: recoveryToken,
      now: at(63_000),
    });
    expect(recovered).toMatchObject({ outcome: "already_applied", newBalance: "11.244567" });
    const counts = await scalar<{ count: string; amount: string }>(sql`
      SELECT count(*)::text AS count, sum(amount)::text AS amount
      FROM credit_transactions WHERE stripe_payment_intent_id = ${attempt.stripePaymentIntentId}
    `);
    expect(counts).toEqual({ count: "1", amount: "10.010000" });

    // The service would await cache invalidation here, then terminalize.
    const credited = await repository.markCredited({
      attemptId: attempt.id,
      leaseToken: recoveryToken,
      now: at(64_000),
    });
    expect(credited).toMatchObject({ status: "credited", nextAttemptAt: null, leaseToken: null });
    expect(await repository.listDue({ now: at(200_000), limit: 10 })).toEqual([]);
  });

  test("blocks repeat top-ups until a later balance decrease and ignores refunds", async () => {
    const { attempt, leaseToken } = await prepareSucceededAttempt({
      balance: "1.00",
      threshold: "5.00",
      amount: "1.00",
    });
    const settled = await repository.settleSucceededAttempt({
      attemptId: attempt.id,
      leaseToken,
      now: at(5_000),
    });
    expect(settled).toMatchObject({
      outcome: "applied",
      newBalance: "2.000000",
      attempt: { coveredBalanceDecreaseRevision: 0 },
    });
    expect(
      await repository.markCredited({
        attemptId: attempt.id,
        leaseToken,
        now: at(6_000),
      }),
    ).toMatchObject({ status: "credited", coveredBalanceDecreaseRevision: 0 });

    const repeated = await repository.claimEligibleAttempt({
      organizationId: ORG_A,
      triggerSource: "cron",
      attemptId: randomUUID(),
      idempotencyKey: "not-rearmed-after-success",
      now: at(7_000),
    });
    expect(repeated).toMatchObject({ outcome: "not_eligible", reason: "balance_not_rearmed" });
    expect(await repository.listEligibleOrganizationIds({ limit: 100 })).toEqual([]);

    await dbWrite.execute(
      sql`UPDATE organizations SET credit_balance = credit_balance + 1 WHERE id = ${ORG_A}`,
    );
    const afterRefund = await repository.claimEligibleAttempt({
      organizationId: ORG_A,
      triggerSource: "cron",
      attemptId: randomUUID(),
      idempotencyKey: "not-rearmed-after-refund",
      now: at(8_000),
    });
    expect(afterRefund).toMatchObject({
      outcome: "not_eligible",
      reason: "balance_not_rearmed",
    });
    expect(
      await scalar<{ revision: string }>(sql`
        SELECT balance_decrease_revision::text AS revision
        FROM organizations WHERE id = ${ORG_A}
      `),
    ).toEqual({ revision: "0" });
  });

  test("covers every balance decrease observed before settlement", async () => {
    const { attempt, leaseToken } = await prepareSucceededAttempt({
      balance: "1.00",
      threshold: "5.00",
      amount: "1.00",
    });
    await dbWrite.execute(sql`UPDATE organizations SET credit_balance = 0.50 WHERE id = ${ORG_A}`);
    const revision = await scalar<{ revision: string }>(sql`
      SELECT balance_decrease_revision::text AS revision
      FROM organizations WHERE id = ${ORG_A}
    `);
    expect(Number(revision.revision)).toBeGreaterThan(0);

    const settled = await repository.settleSucceededAttempt({
      attemptId: attempt.id,
      leaseToken,
      now: at(5_000),
    });
    expect(settled?.attempt.coveredBalanceDecreaseRevision).toBe(Number(revision.revision));
    await repository.markCredited({ attemptId: attempt.id, leaseToken, now: at(6_000) });

    const repeated = await repository.claimEligibleAttempt({
      organizationId: ORG_A,
      triggerSource: "cron",
      attemptId: randomUUID(),
      idempotencyKey: "pre-settlement-debit-covered",
      now: at(7_000),
    });
    expect(repeated).toMatchObject({ outcome: "not_eligible", reason: "balance_not_rearmed" });
  });

  test("rearms after a balance decrease that follows settlement", async () => {
    const { attempt, leaseToken } = await prepareSucceededAttempt({
      balance: "1.00",
      threshold: "5.00",
      amount: "1.00",
    });
    const settled = await repository.settleSucceededAttempt({
      attemptId: attempt.id,
      leaseToken,
      now: at(5_000),
    });
    expect(settled?.attempt.coveredBalanceDecreaseRevision).toBe(0);

    await dbWrite.execute(sql`UPDATE organizations SET credit_balance = 1.50 WHERE id = ${ORG_A}`);
    await repository.markCredited({ attemptId: attempt.id, leaseToken, now: at(6_000) });
    expect(await repository.listEligibleOrganizationIds({ limit: 100 })).toEqual([ORG_A]);

    const rearmed = await repository.claimEligibleAttempt({
      organizationId: ORG_A,
      triggerSource: "credit_deduction",
      attemptId: randomUUID(),
      idempotencyKey: "post-settlement-debit-rearmed",
      now: at(7_000),
    });
    expect(rearmed.outcome).toBe("created");
  });

  test("does not cover a debit that lands after credit application during recovery", async () => {
    const { attempt, leaseToken } = await prepareSucceededAttempt({
      balance: "1.00",
      threshold: "5.00",
      amount: "1.00",
    });
    const applied = await repository.settleSucceededAttempt({
      attemptId: attempt.id,
      leaseToken,
      now: at(5_000),
    });
    expect(applied?.attempt.coveredBalanceDecreaseRevision).toBe(0);

    // Credit is durable, but the process dies before cache invalidation and
    // markCredited. A later debit must rearm the next logical top-up.
    await dbWrite.execute(sql`UPDATE organizations SET credit_balance = 1.50 WHERE id = ${ORG_A}`);
    const recoveryToken = randomUUID();
    await lease(attempt.id, recoveryToken, at(62_000), at(122_000));
    const recovered = await repository.settleSucceededAttempt({
      attemptId: attempt.id,
      leaseToken: recoveryToken,
      now: at(63_000),
    });
    expect(recovered).toMatchObject({
      outcome: "already_applied",
      attempt: { coveredBalanceDecreaseRevision: 0 },
    });
    await repository.markCredited({
      attemptId: attempt.id,
      leaseToken: recoveryToken,
      now: at(64_000),
    });

    const rearmed = await repository.claimEligibleAttempt({
      organizationId: ORG_A,
      triggerSource: "credit_deduction",
      attemptId: randomUUID(),
      idempotencyKey: "post-credit-pre-terminal-debit-rearmed",
      now: at(65_000),
    });
    expect(rearmed.outcome).toBe("created");
  });

  test("moves a mismatched pre-existing provider credit to blocking manual review", async () => {
    const { attempt, leaseToken, paymentIntentId } = await prepareSucceededAttempt();
    await dbWrite.execute(sql`
      INSERT INTO credit_transactions (
        organization_id, amount, type, metadata, stripe_payment_intent_id
      ) VALUES (${ORG_A}, '9.99', 'credit', '{}'::jsonb, ${paymentIntentId})
    `);
    const settled = await repository.settleSucceededAttempt({
      attemptId: attempt.id,
      leaseToken,
      now: at(5_000),
    });
    expect(settled?.outcome).toBe("manual_review");
    expect(settled?.attempt.status).toBe("manual_review");
    expect(
      (
        await scalar<{ auto_top_up_enabled: boolean }>(
          sql`SELECT auto_top_up_enabled FROM organizations WHERE id = ${ORG_A}`,
        )
      ).auto_top_up_enabled,
    ).toBe(false);
    expect(await repository.listDue({ now: at(100_000), limit: 10 })).toEqual([]);

    const claimAgain = await repository.claimEligibleAttempt({
      organizationId: ORG_A,
      triggerSource: "cron",
      attemptId: randomUUID(),
      idempotencyKey: "blocked-by-review",
      now: at(6_000),
    });
    expect(claimAgain.outcome).toBe("reused");
    if (claimAgain.outcome !== "not_eligible") {
      expect(claimAgain.attempt.status).toBe("manual_review");
    }
    expect(await repository.listEligibleOrganizationIds({ limit: 100 })).toEqual([]);
  });

  test("never adopts matching provider credit with non-auto-top-up metadata or a stale fence", async () => {
    const { attempt, leaseToken, paymentIntentId } = await prepareSucceededAttempt({
      balance: "1.00",
      threshold: "5.00",
      amount: "1.00",
    });
    await dbWrite.execute(sql`
      UPDATE organizations
      SET auto_top_up_covered_balance_decrease_revision = balance_decrease_revision
      WHERE id = ${ORG_A}
    `);
    await dbWrite.execute(sql`
      INSERT INTO credit_transactions (
        organization_id, amount, type, metadata, stripe_payment_intent_id
      ) VALUES (
        ${ORG_A}, '1.00', 'credit', '{"type":"grant"}'::jsonb, ${paymentIntentId}
      )
    `);
    await dbWrite.execute(
      sql`UPDATE organizations SET credit_balance = credit_balance + 1 WHERE id = ${ORG_A}`,
    );
    await dbWrite.execute(
      sql`UPDATE organizations SET credit_balance = credit_balance - 0.25 WHERE id = ${ORG_A}`,
    );
    const beforeSettlement = await scalar<{ covered: string; current: string }>(sql`
      SELECT auto_top_up_covered_balance_decrease_revision::text AS covered,
        balance_decrease_revision::text AS current
      FROM organizations WHERE id = ${ORG_A}
    `);
    expect(beforeSettlement.covered).not.toBe(beforeSettlement.current);

    expect(
      await repository.settleSucceededAttempt({
        attemptId: attempt.id,
        leaseToken,
        now: at(5_000),
      }),
    ).toMatchObject({
      outcome: "manual_review",
      attempt: {
        status: "manual_review",
        creditTransactionId: null,
        coveredBalanceDecreaseRevision: null,
      },
    });
    expect(
      await scalar<{ enabled: boolean }>(sql`
        SELECT auto_top_up_enabled AS enabled FROM organizations WHERE id = ${ORG_A}
      `),
    ).toEqual({ enabled: false });
  });

  test("blocks rolling-deploy credit adoption when its covered revision is unknowable", async () => {
    const { attempt, leaseToken, paymentIntentId } = await prepareSucceededAttempt({
      balance: "1.00",
      threshold: "5.00",
      amount: "1.00",
    });
    const inserted = await dbWrite.execute(sql`
      INSERT INTO credit_transactions (
        organization_id, amount, type, metadata, stripe_payment_intent_id
      ) VALUES (
        ${ORG_A}, '1.00', 'credit',
        ${JSON.stringify({ type: "auto_top_up", auto_top_up_attempt_id: attempt.id })}::jsonb,
        ${paymentIntentId}
      )
      RETURNING id::text AS id
    `);
    const creditTransactionId = String(inserted.rows[0]?.id);
    // Model a rolling-deploy credit that predates the organization fence
    // backfill even though its ledger metadata is otherwise authoritative.
    await dbWrite.execute(sql`
      UPDATE organizations
      SET auto_top_up_covered_balance_decrease_revision = NULL
      WHERE id = ${ORG_A}
    `);
    await dbWrite.execute(
      sql`UPDATE organizations SET credit_balance = credit_balance + 1 WHERE id = ${ORG_A}`,
    );
    await dbWrite.execute(
      sql`UPDATE organizations SET credit_balance = credit_balance - 0.25 WHERE id = ${ORG_A}`,
    );

    const settled = await repository.settleSucceededAttempt({
      attemptId: attempt.id,
      leaseToken,
      now: at(5_000),
    });

    expect(settled).toMatchObject({
      outcome: "manual_review",
      attempt: {
        status: "manual_review",
        creditTransactionId,
        coveredBalanceDecreaseRevision: null,
        lastError: "Existing credit timing cannot be reconciled safely",
      },
    });
    expect(
      await repository.reopenManualReviewForSucceededPayment({
        attemptId: attempt.id,
        paymentIntentId,
        result: { status: "succeeded" },
        now: at(6_000),
      }),
    ).toBeNull();
    expect(
      (
        await scalar<{ auto_top_up_enabled: boolean }>(
          sql`SELECT auto_top_up_enabled FROM organizations WHERE id = ${ORG_A}`,
        )
      ).auto_top_up_enabled,
    ).toBe(false);
  });
});
