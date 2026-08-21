/**
 * Exercises the durable auto-top-up service against real PGlite transactions
 * with a hermetic idempotent Stripe boundary. The harness proves concurrent
 * cron single-flight and fresh-isolate recovery at each persisted phase. A
 * fresh service/repository instance models Worker process loss; provider state
 * stays in the hermetic Stripe boundary so idempotency can be asserted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type Stripe from "stripe";
import type {
  StripeCustomerCandidate,
  StripeCustomerLookup,
  StripeCustomerProvider,
} from "../stripe-customer-authority";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const findOrganizationById = mock(async () => null);
const getBillingAttributionForOrganization = mock(async () => ({
  userId: null,
  affiliateCode: null,
}));

mock.module("../../../db/repositories", () => ({
  affiliatesRepository: { getBillingAttributionForOrganization },
  autoTopUpAttemptsRepository: {},
  organizationsRepository: {
    findById: findOrganizationById,
    update: mock(async () => undefined),
  },
  usersRepository: { listByOrganization: mock(async () => []) },
}));

const onCreditMutation = mock(async () => undefined);
const onOrganizationUpdated = mock(async () => undefined);
mock.module("../../cache/invalidation", () => ({
  CacheInvalidation: { onCreditMutation, onOrganizationUpdated },
}));

const invalidateOrganizationCache = mock(async () => undefined);
mock.module("../../cache/organizations-cache", () => ({ invalidateOrganizationCache }));

const invalidateOrgTierCache = mock(async () => undefined);
mock.module("../org-rate-limits", () => ({ invalidateOrgTierCache }));

mock.module("../email", () => ({
  emailService: {
    sendAutoTopUpSuccessEmail: mock(async () => true),
    sendAutoTopUpDisabledEmail: mock(async () => true),
  },
}));

mock.module("../../utils/logger", () => ({
  logger: {
    debug: mock(),
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

const { closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } = await import(
  "../../../db/client"
);
const { AutoTopUpAttemptsRepository } = await import(
  "../../../db/repositories/auto-top-up-attempts"
);
const { AutoTopUpService } = await import("../auto-top-up");
const { StripeCustomerAuthorityService } = await import("../stripe-customer-authority");

const TIMEOUT = 60_000;
const BASE_TIME = Date.parse("2026-08-17T12:00:00.000Z");
const ORGANIZATION_ID = "52000000-0000-4000-8000-000000000001";
const CUSTOMER_ATTEMPT_ID = "52000000-0000-4000-8000-000000000002";
const ensureStripeCustomer = mock(async () => "cus_pglite");
const customerAuthority = { ensure: ensureStripeCustomer };

type CrashPoint =
  | "before_provider_call"
  | "after_payment_intent_persisted"
  | "after_credit_applied";
type RealRepository = InstanceType<typeof AutoTopUpAttemptsRepository>;

class SimulatedProcessCrash extends Error {
  constructor(point: CrashPoint) {
    super(`simulated process crash: ${point}`);
    this.name = "SimulatedProcessCrash";
  }
}

class CustomerProviderHarness implements StripeCustomerProvider {
  readonly candidates: StripeCustomerCandidate[] = [];
  createCalls = 0;
  retrieveCalls = 0;
  createDelayMs = 0;
  absentReason?: "missing" | "deleted";
  wrongTenant = false;
  failRetrieve = false;

  async searchByAttemptId(attemptId: string): Promise<StripeCustomerCandidate[]> {
    return this.candidates.filter(
      (candidate) => candidate.metadata.eliza_customer_attempt_id === attemptId,
    );
  }

  async retrieve(customerId: string): Promise<StripeCustomerLookup> {
    this.retrieveCalls += 1;
    if (this.failRetrieve) throw new Error("customer lookup unavailable");
    if (this.absentReason) return { kind: "absent", customerId, reason: this.absentReason };
    return {
      kind: "found",
      candidate: {
        id: customerId,
        metadata: {
          organization_id: this.wrongTenant
            ? "52000000-0000-4000-8000-000000000099"
            : ORGANIZATION_ID,
        },
        created: 1_690_000_000,
        livemode: false,
      },
    };
  }

  async create(
    params: Stripe.CustomerCreateParams,
    _idempotencyKey: string,
  ): Promise<StripeCustomerCandidate> {
    this.createCalls += 1;
    if (this.createDelayMs) await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    const candidate = {
      id: `cus_replacement_${this.createCalls}`,
      metadata: params.metadata as Record<string, string>,
      created: 1_700_000_000,
      livemode: false,
    };
    this.candidates.push(candidate);
    return candidate;
  }
}

class ConcurrentClaimBarrierRepository extends AutoTopUpAttemptsRepository {
  arrivals = 0;
  private releaseBarrier!: () => void;
  private readonly barrier = new Promise<void>((resolve) => {
    this.releaseBarrier = resolve;
  });

  override async claimEligibleAttempt(
    input: Parameters<RealRepository["claimEligibleAttempt"]>[0],
  ) {
    this.arrivals += 1;
    if (this.arrivals === 2) this.releaseBarrier();
    await this.barrier;
    return super.claimEligibleAttempt(input);
  }
}

class AuthorizationBarrierRepository extends AutoTopUpAttemptsRepository {
  private releaseAuthorization!: () => void;
  private signalAuthorizationEntered!: () => void;
  readonly authorizationEntered: Promise<void>;
  private readonly authorizationReleased: Promise<void>;

  constructor() {
    super();
    this.authorizationEntered = new Promise<void>((resolve) => {
      this.signalAuthorizationEntered = resolve;
    });
    this.authorizationReleased = new Promise<void>((resolve) => {
      this.releaseAuthorization = resolve;
    });
  }

  release(): void {
    this.releaseAuthorization();
  }

  override async authorizeProviderRequest(
    input: Parameters<RealRepository["authorizeProviderRequest"]>[0],
  ) {
    this.signalAuthorizationEntered();
    await this.authorizationReleased;
    return super.authorizeProviderRequest(input);
  }
}

class CrashOnceAutoTopUpRepository extends AutoTopUpAttemptsRepository {
  didCrash = false;

  constructor(private readonly crashPoint: CrashPoint) {
    super();
  }

  override async authorizeProviderRequest(
    input: Parameters<RealRepository["authorizeProviderRequest"]>[0],
  ) {
    const result = await super.authorizeProviderRequest(input);
    if (
      this.crashPoint === "before_provider_call" &&
      !this.didCrash &&
      result.outcome === "authorized"
    ) {
      this.didCrash = true;
      throw new SimulatedProcessCrash(this.crashPoint);
    }
    return result;
  }

  override async recordPaymentIntent(input: Parameters<RealRepository["recordPaymentIntent"]>[0]) {
    const result = await super.recordPaymentIntent(input);
    if (this.crashPoint === "after_payment_intent_persisted" && !this.didCrash && result) {
      this.didCrash = true;
      throw new SimulatedProcessCrash(this.crashPoint);
    }
    return result;
  }

  override async settleSucceededAttempt(
    input: Parameters<RealRepository["settleSucceededAttempt"]>[0],
  ) {
    const result = await super.settleSucceededAttempt(input);
    if (this.crashPoint === "after_credit_applied" && !this.didCrash && result) {
      this.didCrash = true;
      throw new SimulatedProcessCrash(this.crashPoint);
    }
    return result;
  }
}

function paymentIntentFromCreate(
  id: string,
  params: Stripe.PaymentIntentCreateParams,
  metadata: Record<string, string>,
): Stripe.PaymentIntent {
  if (typeof params.customer !== "string" || typeof params.payment_method !== "string") {
    throw new Error("fake Stripe requires string customer and payment method snapshots");
  }
  return {
    id,
    object: "payment_intent",
    status: "succeeded",
    amount: params.amount,
    amount_capturable: 0,
    amount_details: { tip: {} },
    amount_received: params.amount,
    application: null,
    application_fee_amount: null,
    automatic_payment_methods: null,
    canceled_at: null,
    cancellation_reason: null,
    capture_method: "automatic_async",
    client_secret: null,
    confirmation_method: "automatic",
    created: Math.floor(BASE_TIME / 1_000),
    currency: params.currency,
    customer: params.customer,
    description: params.description ?? null,
    excluded_payment_method_types: null,
    last_payment_error: null,
    latest_charge: null,
    livemode: false,
    metadata,
    next_action: null,
    on_behalf_of: null,
    payment_method: params.payment_method,
    payment_method_configuration_details: null,
    payment_method_options: {},
    payment_method_types: ["card"],
    processing: null,
    receipt_email: null,
    review: null,
    setup_future_usage: null,
    shipping: null,
    source: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    transfer_data: null,
    transfer_group: null,
  };
}

function stripeHarness() {
  const intentsByKey = new Map<string, Stripe.PaymentIntent>();
  const intentsById = new Map<string, Stripe.PaymentIntent>();
  const createKeys: string[] = [];
  const create = mock<Stripe.PaymentIntentsResource["create"]>();
  const retrieve = mock<Stripe.PaymentIntentsResource["retrieve"]>();
  const cancel = mock<Stripe.PaymentIntentsResource["cancel"]>();
  const retrievePaymentMethod = mock<Stripe.PaymentMethodsResource["retrieve"]>();

  create.mockImplementation(async (params, options) => {
    const idempotencyKey = options?.idempotencyKey;
    if (!idempotencyKey) throw new Error("fake Stripe requires an idempotency key");
    createKeys.push(idempotencyKey);
    const existing = intentsByKey.get(idempotencyKey);
    if (existing) return existing;

    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(params.metadata ?? {})) {
      if (typeof value !== "string") {
        throw new Error("fake Stripe accepts only persisted string metadata");
      }
      metadata[key] = value;
    }
    const intent = paymentIntentFromCreate(`pi_fake_${intentsByKey.size + 1}`, params, metadata);
    intentsByKey.set(idempotencyKey, intent);
    intentsById.set(intent.id, intent);
    return intent;
  });
  retrieve.mockImplementation(async (paymentIntentId) => {
    const intent = intentsById.get(paymentIntentId);
    if (!intent) throw new Error(`unknown fake PaymentIntent: ${paymentIntentId}`);
    return intent;
  });

  const client = {
    paymentIntents: { create, retrieve, cancel },
    paymentMethods: { retrieve: retrievePaymentMethod },
  } as Pick<Stripe, "paymentIntents" | "paymentMethods">;

  return {
    client: client as Stripe,
    create,
    createKeys,
    get logicalIntentCount() {
      return intentsByKey.size;
    },
  };
}

async function insertEligibleOrganization(): Promise<void> {
  await dbWrite.execute(sql`
    INSERT INTO organizations (
      id, name, slug, credit_balance, settings,
      stripe_default_payment_method, auto_top_up_enabled,
      auto_top_up_threshold, auto_top_up_amount, is_active, updated_at
    ) VALUES (
      ${ORGANIZATION_ID}, 'PGlite Recovery Org', 'pglite-recovery-org',
      '1.000000'::numeric, '{}'::jsonb, 'pm_pglite', true,
      '5.00'::numeric, '10.00'::numeric, true, ${new Date(BASE_TIME)}
    )
  `);
  const digest = "a".repeat(64);
  await dbWrite.execute(sql`INSERT INTO stripe_customer_attempts
    (id, organization_id, generation, request_digest, caller_intent, idempotency_key)
    VALUES (${CUSTOMER_ATTEMPT_ID}, ${ORGANIZATION_ID}, 1, ${digest}, 'auto_top_up',
      ${`eliza-customer-attempt:${CUSTOMER_ATTEMPT_ID}`})`);
  await dbWrite.execute(sql`UPDATE stripe_customer_attempts SET status='provider_started',
    provider_started_at=${new Date(BASE_TIME)} WHERE id=${CUSTOMER_ATTEMPT_ID}`);
  const receipt = {
    binding_kind: "attempt_created",
    created: 1_700_000_000,
    customer_id: "cus_pglite",
    livemode: false,
    metadata: {
      organization_id: ORGANIZATION_ID,
      eliza_organization_id: ORGANIZATION_ID,
      eliza_customer_attempt_id: CUSTOMER_ATTEMPT_ID,
      eliza_customer_generation: "1",
      eliza_customer_request_digest: digest,
      eliza_customer_provider: "stripe",
    },
  };
  await dbWrite.execute(sql`UPDATE stripe_customer_attempts SET status='bound',
    provider_customer_id='cus_pglite', provider_receipt=${JSON.stringify(receipt)}::jsonb,
    provider_livemode=false, bound_at=${new Date(BASE_TIME)} WHERE id=${CUSTOMER_ATTEMPT_ID}`);
  await dbWrite.execute(sql`UPDATE organizations SET stripe_customer_id='cus_pglite'
    WHERE id=${ORGANIZATION_ID}`);
}

async function insertLegacyEligibleOrganization(customerId = "cus_legacy_auto"): Promise<void> {
  await dbWrite.execute(sql`INSERT INTO organizations (
    id, name, slug, credit_balance, settings, stripe_default_payment_method,
    auto_top_up_enabled, auto_top_up_threshold, auto_top_up_amount, is_active, updated_at
  ) VALUES (${ORGANIZATION_ID}, 'Legacy Auto Org', 'legacy-auto-org', '1.000000', '{}',
    'pm_pglite', true, '5.00', '10.00', true, ${new Date(BASE_TIME)})`);
  await getPgliteClientForTests().exec(
    "ALTER TABLE organizations DISABLE TRIGGER organization_stripe_customer_publication_guard",
  );
  await dbWrite.execute(sql`UPDATE organizations SET stripe_customer_id=${customerId}
    WHERE id=${ORGANIZATION_ID}`);
  await getPgliteClientForTests().exec(
    "ALTER TABLE organizations ENABLE TRIGGER organization_stripe_customer_publication_guard",
  );
  await dbWrite.execute(sql`INSERT INTO stripe_customer_legacy_quarantines
    (organization_id, stripe_customer_id) VALUES (${ORGANIZATION_ID}, ${customerId})`);
}

async function autoAttemptCount(): Promise<number> {
  const result = await dbWrite.execute(
    sql`SELECT count(*)::int AS count FROM auto_top_up_attempts`,
  );
  return Number(result.rows[0]?.count);
}

function autoService(
  repository: RealRepository,
  stripe: ReturnType<typeof stripeHarness>,
  authority: {
    ensure(input: { organizationId: string; callerIntent: "auto_top_up" }): Promise<string>;
  },
) {
  return new AutoTopUpService({
    repository,
    stripe: () => stripe.client,
    now: () => new Date(BASE_TIME),
    randomUUID,
    rolloutEnabled: () => true,
    customerAuthority: authority,
  });
}

async function onlyAttempt(repository: RealRepository) {
  const result = await dbWrite.execute(sql`SELECT id::text AS id FROM auto_top_up_attempts`);
  expect(result.rows).toHaveLength(1);
  const id = result.rows[0]?.id;
  if (typeof id !== "string") throw new Error("expected one durable attempt id");
  const attempt = await repository.findById(id);
  if (!attempt) throw new Error("expected one durable attempt");
  return attempt;
}

async function creditSummary(): Promise<{ count: string; amount: string | null }> {
  const result = await dbWrite.execute(sql`
    SELECT count(*)::text AS count, sum(amount)::text AS amount
    FROM credit_transactions
  `);
  const row = result.rows[0];
  if (!row) throw new Error("expected a credit summary row");
  return {
    count: String(row.count),
    amount: row.amount === null ? null : String(row.amount),
  };
}

beforeAll(async () => {
  await getPgliteClientForTests().exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      credit_balance numeric(12,6) NOT NULL DEFAULT 0,
      balance_revision bigint NOT NULL DEFAULT 0,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      stripe_customer_id text,
      billing_email text,
      stripe_default_payment_method text,
      auto_top_up_enabled boolean NOT NULL DEFAULT false,
      auto_top_up_threshold numeric(10,2),
      auto_top_up_amount numeric(10,2),
      is_active boolean NOT NULL DEFAULT true,
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX organizations_stripe_customer_authority_unique
      ON organizations(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
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
      organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL
    );
  `);
  for (const migrationName of [
    "0213_auto_top_up_organization_fence.sql",
    "0214_backfill_auto_top_up_organization_fence.sql",
    "0215_auto_top_up_attempts.sql",
    "0216_auto_top_up_cutover_control.sql",
    "0217_guard_auto_top_up_cutover_lifecycle.sql",
  ]) {
    const migration = await readFile(
      new URL(`../../../db/migrations/${migrationName}`, import.meta.url),
      "utf8",
    );
    await getPgliteClientForTests().exec(migration);
  }
  const customerMigration = await readFile(
    new URL("../../../db/migrations/0267_stripe_customer_attempts.sql", import.meta.url),
    "utf8",
  );
  for (const statement of customerMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
}, TIMEOUT);

beforeEach(async () => {
  await getPgliteClientForTests().exec(`
    ALTER TABLE stripe_customer_attempts DISABLE TRIGGER stripe_customer_attempt_delete_guard;
    ALTER TABLE stripe_customer_legacy_quarantines DISABLE TRIGGER stripe_customer_legacy_quarantine_delete_guard;
    DELETE FROM auto_top_up_legacy_payment_quarantine;
    DELETE FROM auto_top_up_attempts;
    DELETE FROM stripe_customer_legacy_quarantines;
    DELETE FROM stripe_customer_attempts;
    DELETE FROM credit_transactions;
    DELETE FROM organizations;
    ALTER TABLE stripe_customer_attempts ENABLE TRIGGER stripe_customer_attempt_delete_guard;
    ALTER TABLE stripe_customer_legacy_quarantines ENABLE TRIGGER stripe_customer_legacy_quarantine_delete_guard;
    UPDATE auto_top_up_control
    SET mode = 'durable', legacy_reconciled_through = paused_at, updated_at = now()
    WHERE singleton = true;
  `);
  for (const fn of [
    findOrganizationById,
    getBillingAttributionForOrganization,
    onCreditMutation,
    onOrganizationUpdated,
    invalidateOrganizationCache,
    invalidateOrgTierCache,
  ]) {
    fn.mockClear();
  }
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("AutoTopUpService PGlite recovery", () => {
  test(
    "fails closed before attempt or PaymentIntent when legacy Customer lookup is unresolved",
    async () => {
      await insertLegacyEligibleOrganization();
      const customers = new CustomerProviderHarness();
      customers.failRetrieve = true;
      const authority = new StripeCustomerAuthorityService(customers, { waitMs: 100 });
      const stripe = stripeHarness();
      const result = await autoService(
        new AutoTopUpAttemptsRepository(),
        stripe,
        authority,
      ).executeAutoTopUpForOrganization(ORGANIZATION_ID, { source: "manual" });

      expect(result.status).toBe("unavailable");
      expect(await autoAttemptCount()).toBe(0);
      expect(stripe.create).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  test.each(["missing", "deleted", "wrong_tenant"] as const)(
    "provider-verifies %s legacy Customer before claiming and charging replacement",
    async (outcome) => {
      await insertLegacyEligibleOrganization();
      const customers = new CustomerProviderHarness();
      if (outcome === "wrong_tenant") customers.wrongTenant = true;
      else customers.absentReason = outcome;
      const authority = new StripeCustomerAuthorityService(customers, { waitMs: 500 });
      const stripe = stripeHarness();
      const repository = new AutoTopUpAttemptsRepository();
      const result = await autoService(
        repository,
        stripe,
        authority,
      ).executeAutoTopUpForOrganization(ORGANIZATION_ID, { source: "manual" });

      expect(result.status).toBe("credited");
      const attempt = await onlyAttempt(repository);
      expect(attempt.stripeCustomerId).toBe("cus_replacement_1");
      expect(stripe.create).toHaveBeenCalledTimes(1);
      expect(customers.retrieveCalls).toBe(1);
      expect(customers.createCalls).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "DB claim guard rejects organization customer drift with zero attempt or PaymentIntent",
    async () => {
      await insertEligibleOrganization();
      const stripe = stripeHarness();
      const driftingAuthority = {
        ensure: async () => {
          await getPgliteClientForTests().exec(
            "ALTER TABLE organizations DISABLE TRIGGER organization_stripe_customer_publication_guard",
          );
          await dbWrite.execute(sql`UPDATE organizations SET stripe_customer_id='cus_drifted'
          WHERE id=${ORGANIZATION_ID}`);
          await getPgliteClientForTests().exec(
            "ALTER TABLE organizations ENABLE TRIGGER organization_stripe_customer_publication_guard",
          );
          return "cus_pglite";
        },
      };
      const result = await autoService(
        new AutoTopUpAttemptsRepository(),
        stripe,
        driftingAuthority,
      ).executeAutoTopUpForOrganization(ORGANIZATION_ID, { source: "manual" });

      expect(result.status).toBe("canceled");
      expect(result.error).toMatch(/authority/i);
      expect(await autoAttemptCount()).toBe(0);
      expect(stripe.create).not.toHaveBeenCalled();
      await expect(
        Promise.resolve(
          dbWrite.execute(sql`INSERT INTO auto_top_up_attempts
            (id, organization_id, trigger_source, credit_amount_cents, charge_amount_cents,
             stripe_customer_id_snapshot, stripe_payment_method_id_snapshot, idempotency_key)
            VALUES ('52000000-0000-4000-8000-000000000088', ${ORGANIZATION_ID}, 'manual',
              1000, 1000, 'cus_drifted', 'pm_pglite', 'drift-forgery')`),
        ),
      ).rejects.toThrow();
      expect(await autoAttemptCount()).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "concurrent legacy reconciliation and attempt claims converge on one Customer and PI",
    async () => {
      await insertLegacyEligibleOrganization();
      const customers = new CustomerProviderHarness();
      customers.absentReason = "missing";
      customers.createDelayMs = 75;
      const authority = new StripeCustomerAuthorityService(customers, { waitMs: 2_000 });
      const stripe = stripeHarness();
      const repository = new ConcurrentClaimBarrierRepository();
      const service = autoService(repository, stripe, authority);

      const results = await Promise.all([
        service.executeAutoTopUpForOrganization(ORGANIZATION_ID, { source: "cron" }),
        service.executeAutoTopUpForOrganization(ORGANIZATION_ID, { source: "cron" }),
      ]);

      expect(results.filter((result) => result.success)).toHaveLength(1);
      expect(customers.createCalls).toBe(1);
      expect(stripe.create).toHaveBeenCalledTimes(1);
      expect(await autoAttemptCount()).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "recovery re-fences provider-started attempt after organization customer drift with zero PI I/O",
    async () => {
      await insertEligibleOrganization();
      const stripe = stripeHarness();
      const crashingRepository = new CrashOnceAutoTopUpRepository("before_provider_call");
      const initial = autoService(crashingRepository, stripe, customerAuthority);
      await initial.checkAndExecuteAutoTopUps({ source: "cron", limit: 1 });
      const started = await onlyAttempt(crashingRepository);
      expect(started.providerRequestStartedAt).not.toBeNull();
      expect(stripe.create).not.toHaveBeenCalled();

      await getPgliteClientForTests().exec(
        "ALTER TABLE organizations DISABLE TRIGGER organization_stripe_customer_publication_guard",
      );
      await dbWrite.execute(sql`UPDATE organizations SET stripe_customer_id='cus_recovery_drift'
        WHERE id=${ORGANIZATION_ID}`);
      await getPgliteClientForTests().exec(
        "ALTER TABLE organizations ENABLE TRIGGER organization_stripe_customer_publication_guard",
      );

      let recoveryNow = BASE_TIME + 2 * 60 * 1000 + 1;
      const recoveryRepository = new AutoTopUpAttemptsRepository();
      const recovery = new AutoTopUpService({
        repository: recoveryRepository,
        stripe: () => stripe.client,
        now: () => new Date(recoveryNow),
        randomUUID,
        rolloutEnabled: () => true,
        customerAuthority,
      });
      const result = await recovery.executeAutoTopUpForOrganization(ORGANIZATION_ID, {
        source: "recovery",
      });
      recoveryNow += 1;

      expect(result.status).toBe("manual_review");
      expect((await onlyAttempt(recoveryRepository)).status).toBe("manual_review");
      expect(stripe.create).not.toHaveBeenCalled();
      expect(stripe.client.paymentIntents.retrieve).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  test(
    "concurrent customer drift before the final provider fence durably rejects with zero PI I/O",
    async () => {
      await insertEligibleOrganization();
      const stripe = stripeHarness();
      const repository = new AuthorizationBarrierRepository();
      const pending = autoService(
        repository,
        stripe,
        customerAuthority,
      ).executeAutoTopUpForOrganization(ORGANIZATION_ID, { source: "manual" });
      await repository.authorizationEntered;
      await getPgliteClientForTests().exec(
        "ALTER TABLE organizations DISABLE TRIGGER organization_stripe_customer_publication_guard",
      );
      await dbWrite.execute(sql`UPDATE organizations SET stripe_customer_id='cus_concurrent_drift'
        WHERE id=${ORGANIZATION_ID}`);
      await getPgliteClientForTests().exec(
        "ALTER TABLE organizations ENABLE TRIGGER organization_stripe_customer_publication_guard",
      );
      repository.release();
      const result = await pending;

      expect(result.status).toBe("manual_review");
      expect((await onlyAttempt(repository)).status).toBe("manual_review");
      expect(stripe.create).not.toHaveBeenCalled();
      expect(stripe.client.paymentIntents.retrieve).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  test(
    "single-flights concurrent cron sweeps through one provider intent and one credit",
    async () => {
      await insertEligibleOrganization();
      const repository = new ConcurrentClaimBarrierRepository();
      const stripe = stripeHarness();
      const service = new AutoTopUpService({
        repository,
        stripe: () => stripe.client,
        now: () => new Date(BASE_TIME),
        randomUUID,
        rolloutEnabled: () => true,
        customerAuthority,
      });

      const sweeps = await Promise.all([
        service.checkAndExecuteAutoTopUps({ source: "cron", limit: 1 }),
        service.checkAndExecuteAutoTopUps({ source: "cron", limit: 1 }),
      ]);

      const attempt = await onlyAttempt(repository);
      expect(attempt).toMatchObject({
        status: "credited",
        stripePaymentIntentId: "pi_fake_1",
      });
      expect(attempt.idempotencyKey).toBe(`auto_top_up:v1:${attempt.id}`);
      expect(sweeps.reduce((total, sweep) => total + sweep.successful, 0)).toBe(1);
      expect(repository.arrivals).toBe(2);
      expect(stripe.create).toHaveBeenCalledTimes(1);
      expect(stripe.createKeys).toEqual([attempt.idempotencyKey]);
      expect(stripe.logicalIntentCount).toBe(1);
      expect(await creditSummary()).toEqual({ count: "1", amount: "10.000000" });
    },
    TIMEOUT,
  );

  test.each([
    ["before the provider call", "before_provider_call", "payment_pending", 0],
    [
      "after the PaymentIntent is persisted",
      "after_payment_intent_persisted",
      "payment_succeeded",
      0,
    ],
    ["after the credit is applied", "after_credit_applied", "payment_succeeded", 1],
  ] as const)(
    "converges after a crash %s",
    async (_label, crashPoint, intermediateStatus, intermediateCredits) => {
      await insertEligibleOrganization();
      const repository = new CrashOnceAutoTopUpRepository(crashPoint);
      const stripe = stripeHarness();
      let nowMs = BASE_TIME;
      const service = new AutoTopUpService({
        repository,
        stripe: () => stripe.client,
        now: () => new Date(nowMs),
        randomUUID,
        rolloutEnabled: () => true,
        customerAuthority,
      });

      await service.checkAndExecuteAutoTopUps({ source: "cron", limit: 1 });

      expect(repository.didCrash).toBe(true);
      const interrupted = await onlyAttempt(repository);
      const durableKey = interrupted.idempotencyKey;
      expect(interrupted.status).toBe(intermediateStatus);
      expect(durableKey).toBe(`auto_top_up:v1:${interrupted.id}`);
      expect((await creditSummary()).count).toBe(String(intermediateCredits));

      nowMs += 2 * 60 * 1_000 + 1;
      // A fresh service and repository instance model a new Worker isolate;
      // recovery authority comes only from PGlite + provider idempotency.
      const recoveryRepository = new AutoTopUpAttemptsRepository();
      const recoveryService = new AutoTopUpService({
        repository: recoveryRepository,
        stripe: () => stripe.client,
        now: () => new Date(nowMs),
        randomUUID,
        rolloutEnabled: () => true,
        customerAuthority,
      });
      const recovered = await recoveryService.checkAndExecuteAutoTopUps({
        source: "cron",
        limit: 1,
      });

      const credited = await onlyAttempt(recoveryRepository);
      expect(recovered.successful).toBe(1);
      expect(recovered.recovered).toBe(1);
      expect(credited).toMatchObject({
        id: interrupted.id,
        status: "credited",
        idempotencyKey: durableKey,
        stripePaymentIntentId: "pi_fake_1",
      });
      expect(stripe.create).toHaveBeenCalledTimes(1);
      expect(stripe.createKeys).toEqual([durableKey]);
      expect(stripe.logicalIntentCount).toBe(1);
      expect(await creditSummary()).toEqual({ count: "1", amount: "10.000000" });
    },
    TIMEOUT,
  );
});
