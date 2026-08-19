/** Hermetic state-machine coverage for durable, single-flight auto top-ups. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type Stripe from "stripe";
import type { Organization } from "../../../db/repositories";
import type { AutoTopUpAttempt } from "../../../db/repositories/auto-top-up-attempts";

const NOW = new Date("2026-08-17T00:00:00.000Z");
const ATTEMPT_ID = "attempt-1";
const ORG_ID = "org-1";

interface BillingAttributionFixture {
  userId: string | null;
  affiliateCode: {
    id: string;
    user_id: string;
    markup_percent: string;
  } | null;
}

const findOrganizationById = mock(async (): Promise<Organization | undefined> => undefined);
const updateOrganization = mock(async (): Promise<Organization | undefined> => undefined);
const getControl = mock(async () => ({
  mode: "durable" as const,
  pausedAt: NOW,
  legacyReconciledThrough: NOW,
}));
const findBlockingByOrganization = mock(async () => null);
const findBlockingLegacyPaymentByOrganization = mock(async () => null);
const listUsersByOrganization = mock(async () => []);
const getBillingAttributionForOrganization = mock(
  async (): Promise<BillingAttributionFixture> => ({
    userId: null,
    affiliateCode: null,
  }),
);

mock.module("../../../db/repositories", () => ({
  affiliatesRepository: {
    getBillingAttributionForOrganization,
  },
  autoTopUpAttemptsRepository: {
    getControl,
    findBlockingByOrganization,
    findBlockingLegacyPaymentByOrganization,
  },
  organizationsRepository: {
    findById: findOrganizationById,
    update: updateOrganization,
  },
  usersRepository: {
    listByOrganization: listUsersByOrganization,
  },
}));

const onCreditMutation = mock(async () => undefined);
const onOrganizationUpdated = mock(async () => undefined);
mock.module("../../cache/invalidation", () => ({
  CacheInvalidation: {
    onCreditMutation,
    onOrganizationUpdated,
  },
}));

const invalidateOrganizationCache = mock(async () => undefined);
mock.module("../../cache/organizations-cache", () => ({
  invalidateOrganizationCache,
}));

const invalidateOrgTierCache = mock(async () => undefined);
mock.module("../org-rate-limits", () => ({
  invalidateOrgTierCache,
}));

const sendAutoTopUpSuccessEmail = mock(async () => true);
const sendAutoTopUpDisabledEmail = mock(async () => true);
mock.module("../email", () => ({
  emailService: {
    sendAutoTopUpSuccessEmail,
    sendAutoTopUpDisabledEmail,
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

const ensureStripeCustomer = mock(async () => "cus_123");
mock.module("../stripe-customer-authority", () => ({
  stripeCustomerAuthorityService: { ensure: ensureStripeCustomer },
}));

const { AutoTopUpService, CorruptAutoTopUpNumberError, parseAutoTopUpNumber } = await import(
  "../auto-top-up"
);
const { runWithCloudBindingsAsync } = await import("../../runtime/cloud-bindings");

type ServiceDependencies = ConstructorParameters<typeof AutoTopUpService>[0];
type RepositoryDependency = NonNullable<ServiceDependencies["repository"]>;
type AutoTopUpOrganization = Parameters<AutoTopUpService["executeAutoTopUp"]>[0];

function makeOrganization(overrides: Partial<AutoTopUpOrganization> = {}): AutoTopUpOrganization {
  return {
    id: ORG_ID,
    name: "Acme Cloud",
    auto_top_up_enabled: true,
    auto_top_up_amount: "10.00",
    auto_top_up_threshold: "5.00",
    stripe_default_payment_method: "pm_123",
    ...overrides,
  } as AutoTopUpOrganization;
}

function requestMetadata(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    organization_id: ORG_ID,
    credits: "10.00",
    type: "auto_top_up",
    auto_top_up_attempt_id: ATTEMPT_ID,
    base_amount: "10.00",
    total_charged: "10.00",
    platform_fee_amount: "0.00",
    fees_included: "true",
    ...overrides,
  };
}

function attempt(overrides: Partial<AutoTopUpAttempt> = {}): AutoTopUpAttempt {
  return {
    id: ATTEMPT_ID,
    organizationId: ORG_ID,
    triggerSource: "manual",
    status: "payment_pending",
    creditAmountCents: 1000,
    chargeAmountCents: 1000,
    currency: "usd",
    stripeCustomerId: "cus_123",
    stripePaymentMethodId: "pm_123",
    requestMetadata: requestMetadata(),
    idempotencyKey: `auto_top_up:v1:${ATTEMPT_ID}`,
    stripePaymentIntentId: null,
    creditTransactionId: null,
    coveredBalanceDecreaseRevision: null,
    providerStatus: null,
    attemptCount: 1,
    nextAttemptAt: NOW,
    leaseToken: null,
    leaseExpiresAt: null,
    providerRequestStartedAt: new Date(NOW.getTime() - 60_000),
    recoveryDeadlineAt: new Date(NOW.getTime() + 60 * 60_000),
    lastError: null,
    result: null,
    paymentSucceededAt: null,
    creditedAt: null,
    canceledAt: null,
    manualReviewAt: null,
    createdAt: new Date(NOW.getTime() - 60_000),
    updatedAt: NOW,
    ...overrides,
  };
}

function paymentIntent(
  durableAttempt: AutoTopUpAttempt,
  status: Stripe.PaymentIntent.Status,
  overrides: Partial<Stripe.PaymentIntent> = {},
): Stripe.PaymentIntent {
  return {
    id: durableAttempt.stripePaymentIntentId ?? "pi_123",
    object: "payment_intent",
    status,
    amount: durableAttempt.chargeAmountCents,
    amount_capturable: 0,
    amount_details: { tip: {} },
    amount_received: status === "succeeded" ? durableAttempt.chargeAmountCents : 0,
    application: null,
    application_fee_amount: null,
    automatic_payment_methods: null,
    canceled_at: null,
    cancellation_reason: null,
    capture_method: "automatic_async",
    client_secret: null,
    confirmation_method: "automatic",
    created: Math.floor(NOW.getTime() / 1000),
    currency: durableAttempt.currency,
    customer: durableAttempt.stripeCustomerId,
    description: null,
    excluded_payment_method_types: null,
    last_payment_error: null,
    latest_charge: null,
    livemode: false,
    metadata: durableAttempt.requestMetadata as Record<string, string>,
    next_action: null,
    on_behalf_of: null,
    payment_method: durableAttempt.stripePaymentMethodId,
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
    ...overrides,
  };
}

function repository(overrides: Partial<RepositoryDependency> = {}): RepositoryDependency {
  return {
    getControl: mock(async () => ({
      mode: "durable" as const,
      pausedAt: NOW,
      legacyReconciledThrough: NOW,
    })),
    findById: mock(async () => null),
    findBlockingByOrganization: mock(async () => null),
    findByPaymentIntentId: mock(async () => null),
    customerReconciliationMayBeNeeded: mock(async () => true),
    customerSnapshotHasAuthority: mock(async () => true),
    authorizeProviderRequest: mock(async ({ leaseToken, recoveryDeadlineAt }) => ({
      outcome: "authorized" as const,
      attempt: attempt({
        leaseToken,
        leaseExpiresAt: new Date(NOW.getTime() + 120_000),
        recoveryDeadlineAt,
      }),
    })),
    claimEligibleAttempt: mock(async () => ({
      outcome: "not_eligible" as const,
      organizationId: ORG_ID,
      reason: "disabled" as const,
    })),
    claimDueLease: mock(async () => null),
    finalizeRequest: mock(async () => null),
    markProviderRequestStarted: mock(async () => null),
    recordPaymentIntent: mock(async () => null),
    recordFailure: mock(async () => null),
    markCanceled: mock(async () => null),
    markManualReview: mock(async () => null),
    reopenManualReviewForSucceededPayment: mock(async () => null),
    listDue: mock(async () => []),
    listDueAttempts: mock(async () => []),
    listEligibleOrganizationIds: mock(async () => []),
    settleSucceededAttempt: mock(async () => null),
    markCredited: mock(async () => null),
    ...overrides,
  } as RepositoryDependency;
}

function stripeHarness() {
  const create = mock<Stripe.PaymentIntentsResource["create"]>();
  const retrieve = mock<Stripe.PaymentIntentsResource["retrieve"]>();
  const cancel = mock<Stripe.PaymentIntentsResource["cancel"]>();
  const retrievePaymentMethod = mock<Stripe.PaymentMethodsResource["retrieve"]>();
  const client = {
    paymentIntents: { create, retrieve, cancel },
    paymentMethods: { retrieve: retrievePaymentMethod },
  } as Pick<Stripe, "paymentIntents" | "paymentMethods">;
  const provide = mock(() => client as Stripe);
  return { create, retrieve, cancel, retrievePaymentMethod, provide };
}

function service(
  durableRepository: RepositoryDependency,
  stripe: ReturnType<typeof stripeHarness>,
  ids: string[] = ["candidate-id", "lease-token"],
  rolloutEnabled: () => boolean = () => true,
): InstanceType<typeof AutoTopUpService> {
  let index = 0;
  return new AutoTopUpService({
    repository: durableRepository,
    stripe: stripe.provide,
    now: () => new Date(NOW),
    randomUUID: () => ids[index++] ?? `generated-${index}`,
    rolloutEnabled,
  });
}

function processingRepository(
  durableAttempt: AutoTopUpAttempt,
  events?: string[],
): RepositoryDependency {
  const leased = attempt({
    ...durableAttempt,
    leaseToken: "lease-token",
    leaseExpiresAt: new Date(NOW.getTime() + 120_000),
  });
  const recorded = attempt({
    ...leased,
    stripePaymentIntentId: durableAttempt.stripePaymentIntentId ?? "pi_123",
    providerStatus: "processing",
  });
  const failed = attempt({
    ...recorded,
    leaseToken: null,
    leaseExpiresAt: null,
    nextAttemptAt: new Date(NOW.getTime() + 60_000),
    lastError: "Payment processing",
  });
  return repository({
    claimEligibleAttempt: mock(async () => ({ outcome: "reused", attempt: durableAttempt })),
    claimDueLease: mock(async () => {
      events?.push("lease-due");
      return leased;
    }),
    authorizeProviderRequest: mock(async () => ({
      outcome: "authorized" as const,
      attempt: leased,
    })),
    recordPaymentIntent: mock(async () => {
      events?.push("record-payment-intent");
      return recorded;
    }),
    recordFailure: mock(async () => {
      events?.push("schedule-retry");
      return failed;
    }),
  });
}

beforeEach(() => {
  for (const fn of [
    findOrganizationById,
    updateOrganization,
    getControl,
    findBlockingByOrganization,
    findBlockingLegacyPaymentByOrganization,
    listUsersByOrganization,
    getBillingAttributionForOrganization,
    onCreditMutation,
    onOrganizationUpdated,
    invalidateOrganizationCache,
    invalidateOrgTierCache,
    sendAutoTopUpSuccessEmail,
    sendAutoTopUpDisabledEmail,
  ]) {
    fn.mockClear();
  }
  findOrganizationById.mockResolvedValue(undefined);
  updateOrganization.mockResolvedValue(undefined);
  getControl.mockResolvedValue({
    mode: "durable",
    pausedAt: NOW,
    legacyReconciledThrough: NOW,
  });
  findBlockingByOrganization.mockResolvedValue(null);
  findBlockingLegacyPaymentByOrganization.mockResolvedValue(null);
  listUsersByOrganization.mockResolvedValue([]);
  getBillingAttributionForOrganization.mockResolvedValue({
    userId: null,
    affiliateCode: null,
  });
  onCreditMutation.mockResolvedValue(undefined);
  onOrganizationUpdated.mockResolvedValue(undefined);
  invalidateOrganizationCache.mockResolvedValue(undefined);
  invalidateOrgTierCache.mockResolvedValue(undefined);
});

describe("AutoTopUpService durable provider recovery", () => {
  test("enables new claims only for the exact Worker binding value true", async () => {
    const durableRepository = repository();
    const stripe = stripeHarness();
    const autoTopUp = new AutoTopUpService({
      repository: durableRepository,
      stripe: stripe.provide,
      now: () => new Date(NOW),
      randomUUID: () => "candidate-id",
    });

    const paused = await runWithCloudBindingsAsync({ AUTO_TOP_UP_DURABLE_ENABLED: "TRUE" }, () =>
      autoTopUp.executeAutoTopUpForOrganization(ORG_ID, { source: "manual" }),
    );
    expect(paused.status).toBe("unavailable");
    expect(durableRepository.claimEligibleAttempt).not.toHaveBeenCalled();

    const enabled = await runWithCloudBindingsAsync({ AUTO_TOP_UP_DURABLE_ENABLED: "true" }, () =>
      autoTopUp.executeAutoTopUpForOrganization(ORG_ID, { source: "manual" }),
    );
    expect(enabled.status).toBe("canceled");
    expect(durableRepository.claimEligibleAttempt).toHaveBeenCalledTimes(1);
  });

  test("blocks a new manual claim while the cross-version rollout gate is closed", async () => {
    const durableRepository = repository();
    const stripe = stripeHarness();

    const result = await service(
      durableRepository,
      stripe,
      ["unused"],
      () => false,
    ).executeAutoTopUpForOrganization(ORG_ID, { source: "manual" });

    expect(result).toEqual({
      organizationId: ORG_ID,
      success: false,
      error: "Durable auto top-up activation is paused during the safe rollout window",
      status: "unavailable",
      recovered: false,
    });
    expect(durableRepository.claimEligibleAttempt).not.toHaveBeenCalled();
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test("keeps recovery active but skips new discovery while the rollout gate is closed", async () => {
    const durableRepository = repository({
      listDueAttempts: mock(async () => []),
      listEligibleOrganizationIds: mock(async () => {
        throw new Error("new discovery must remain disabled");
      }),
    });
    const stripe = stripeHarness();

    const result = await service(
      durableRepository,
      stripe,
      ["unused"],
      () => false,
    ).checkAndExecuteAutoTopUps({ source: "cron", limit: 10 });

    expect(result).toEqual({
      timestamp: NOW,
      rolloutPaused: true,
      cutoverPaused: false,
      controlMode: "durable",
      organizationsChecked: 0,
      organizationsProcessed: 0,
      successful: 0,
      failed: 0,
      recovered: 0,
      claimed: 0,
      skipped: 0,
      results: [],
    });
    expect(durableRepository.listDueAttempts).toHaveBeenCalledWith({ now: NOW, limit: 7 });
    expect(durableRepository.listEligibleOrganizationIds).not.toHaveBeenCalled();
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test("recovers existing durable work while the secondary rollout gate is closed", async () => {
    const durable = attempt({ stripePaymentIntentId: "pi_existing" });
    const durableRepository = processingRepository(durable);
    durableRepository.findBlockingByOrganization = mock(async () => durable);
    const stripe = stripeHarness();
    stripe.retrieve.mockResolvedValue(paymentIntent(durable, "processing", { id: "pi_existing" }));

    const result = await service(
      durableRepository,
      stripe,
      ["recovery-lease"],
      () => false,
    ).executeAutoTopUpForOrganization(ORG_ID, { source: "credit_deduction" });

    expect(result.status).toBe("payment_pending");
    expect(result.recovered).toBe(true);
    expect(stripe.retrieve).toHaveBeenCalledWith("pi_existing");
    expect(durableRepository.claimEligibleAttempt).not.toHaveBeenCalled();
  });

  test("re-reads primary state after a fenced CAS miss instead of returning a stale attempt", async () => {
    const candidate = attempt({ status: "payment_pending" });
    const credited = attempt({
      status: "credited",
      stripePaymentIntentId: "pi_concurrent",
      creditTransactionId: "credit-concurrent",
      creditedAt: NOW,
    });
    const durableRepository = repository({
      claimEligibleAttempt: mock(async () => ({ outcome: "reused" as const, attempt: candidate })),
      claimDueLease: mock(async () => null),
      findById: mock(async () => credited),
    });
    const stripe = stripeHarness();

    const result = await service(durableRepository, stripe).executeAutoTopUpForOrganization(
      ORG_ID,
      { source: "manual" },
    );

    expect(result).toMatchObject({
      success: true,
      status: "credited",
      attemptId: ATTEMPT_ID,
    });
    expect(durableRepository.findById).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test("reports unavailable when the fenced-state re-read itself fails", async () => {
    const candidate = attempt({ status: "payment_pending" });
    const durableRepository = repository({
      claimEligibleAttempt: mock(async () => ({ outcome: "reused" as const, attempt: candidate })),
      claimDueLease: mock(async () => null),
      findById: mock(async () => {
        throw new Error("primary unavailable");
      }),
    });
    const stripe = stripeHarness();

    const result = await service(durableRepository, stripe).executeAutoTopUpForOrganization(
      ORG_ID,
      { source: "manual" },
    );

    expect(result.status).toBe("unavailable");
    expect(result.error).toBe("Auto top-up state is unavailable");
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test("reports DB cutover and secondary rollout pause independently", async () => {
    const durableRepository = repository({
      getControl: mock(async () => ({
        mode: "paused" as const,
        pausedAt: NOW,
        legacyReconciledThrough: null,
      })),
    });
    const stripe = stripeHarness();

    const result = await service(durableRepository, stripe).checkAndExecuteAutoTopUps({
      source: "cron",
      limit: 1,
    });

    expect(result).toMatchObject({
      rolloutPaused: true,
      cutoverPaused: true,
      controlMode: "paused",
    });
    expect(durableRepository.listEligibleOrganizationIds).not.toHaveBeenCalled();
  });

  test.each([
    ["cutover_paused", "unavailable"],
    ["legacy_payment_unresolved", "manual_review"],
  ] as const)("maps PR1 claim blocker %s without provider work", async (reason, status) => {
    const durableRepository = repository({
      claimEligibleAttempt: mock(async () => ({
        outcome: "not_eligible" as const,
        organizationId: ORG_ID,
        reason,
      })),
    });
    const stripe = stripeHarness();

    const result = await service(durableRepository, stripe).executeAutoTopUpForOrganization(
      ORG_ID,
      { source: "manual" },
    );

    expect(result.status).toBe(status);
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test("reuses identical Stripe parameters and idempotency key after a lost response", async () => {
    let durable = attempt({
      status: "claimed",
      chargeAmountCents: 1000,
      requestMetadata: {},
      attemptCount: 0,
      providerRequestStartedAt: null,
      recoveryDeadlineAt: null,
    });
    let claims = 0;
    const durableRepository = repository({
      claimEligibleAttempt: mock(async () => {
        claims += 1;
        return { outcome: claims === 1 ? "created" : "reused", attempt: durable };
      }),
      claimDueLease: mock(async ({ leaseToken, leaseExpiresAt }) => {
        durable = attempt({
          ...durable,
          leaseToken,
          leaseExpiresAt,
          attemptCount: durable.attemptCount + 1,
        });
        return durable;
      }),
      finalizeRequest: mock(async ({ chargeAmountCents, requestMetadata }) => {
        durable = attempt({
          ...durable,
          status: "payment_pending",
          chargeAmountCents,
          requestMetadata,
        });
        return durable;
      }),
      authorizeProviderRequest: mock(async ({ now, recoveryDeadlineAt }) => {
        durable = attempt({
          ...durable,
          providerRequestStartedAt: now,
          recoveryDeadlineAt,
        });
        return { outcome: "authorized" as const, attempt: durable };
      }),
      recordPaymentIntent: mock(async ({ paymentIntentId, providerStatus }) => {
        durable = attempt({
          ...durable,
          stripePaymentIntentId: paymentIntentId,
          providerStatus,
        });
        return durable;
      }),
      recordFailure: mock(async ({ error, nextAttemptAt }) => {
        durable = attempt({
          ...durable,
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: error,
          nextAttemptAt,
        });
        return durable;
      }),
    });
    const stripe = stripeHarness();
    stripe.create
      .mockRejectedValueOnce(new Error("connection reset after provider accepted request"))
      .mockImplementationOnce(async () => paymentIntent(durable, "processing"));
    const autoTopUp = service(durableRepository, stripe, [
      ATTEMPT_ID,
      "lease-one",
      "discarded-candidate",
      "lease-two",
    ]);

    const first = await autoTopUp.executeAutoTopUpForOrganization(ORG_ID, { source: "manual" });
    const second = await autoTopUp.executeAutoTopUpForOrganization(ORG_ID, { source: "manual" });

    expect(first.status).toBe("payment_pending");
    expect(second.status).toBe("payment_pending");
    expect(stripe.create).toHaveBeenCalledTimes(2);
    expect(stripe.create.mock.calls[1]).toEqual(stripe.create.mock.calls[0]);
    expect(stripe.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        amount: 1000,
        currency: "usd",
        customer: "cus_123",
        payment_method: "pm_123",
        metadata: requestMetadata(),
      }),
    );
    expect(stripe.create.mock.calls[0][1]).toEqual({
      idempotencyKey: `auto_top_up:v1:${ATTEMPT_ID}`,
    });
    expect(durableRepository.finalizeRequest).toHaveBeenCalledTimes(1);
    expect(durableRepository.authorizeProviderRequest).toHaveBeenCalledTimes(2);
    expect(getBillingAttributionForOrganization).toHaveBeenCalledTimes(1);
  });

  test("snapshots exact primary affiliate attribution before provider work", async () => {
    const claimed = attempt({
      status: "claimed",
      requestMetadata: {},
      attemptCount: 0,
      providerRequestStartedAt: null,
      recoveryDeadlineAt: null,
    });
    const leased = attempt({
      ...claimed,
      leaseToken: "lease-token",
      leaseExpiresAt: new Date(NOW.getTime() + 120_000),
      attemptCount: 1,
    });
    const finalizeRequest = mock(async () => null);
    const durableRepository = repository({
      claimEligibleAttempt: mock(async () => ({ outcome: "created", attempt: claimed })),
      claimDueLease: mock(async () => leased),
      finalizeRequest,
    });
    getBillingAttributionForOrganization.mockResolvedValueOnce({
      userId: "billing-user",
      affiliateCode: {
        id: "affiliate-code",
        user_id: "affiliate-owner",
        markup_percent: "10",
      },
    });
    const stripe = stripeHarness();

    await service(durableRepository, stripe).executeAutoTopUpForOrganization(ORG_ID, {
      source: "manual",
    });

    expect(getBillingAttributionForOrganization).toHaveBeenCalledWith(ORG_ID);
    expect(finalizeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        chargeAmountCents: 1300,
        requestMetadata: {
          ...requestMetadata({
            user_id: "billing-user",
            total_charged: "13.00",
            platform_fee_amount: "2.00",
            affiliate_fee_amount: "1.00",
            affiliate_owner_id: "affiliate-owner",
            affiliate_code_id: "affiliate-code",
          }),
        },
      }),
    );
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test("finalizes a base-only request when primary affiliate attribution fails", async () => {
    const claimed = attempt({
      status: "claimed",
      requestMetadata: {},
      attemptCount: 0,
      providerRequestStartedAt: null,
      recoveryDeadlineAt: null,
    });
    const leased = attempt({
      ...claimed,
      leaseToken: "lease-token",
      leaseExpiresAt: new Date(NOW.getTime() + 120_000),
      attemptCount: 1,
    });
    const finalizeRequest = mock(async () => null);
    const durableRepository = repository({
      claimEligibleAttempt: mock(async () => ({ outcome: "created", attempt: claimed })),
      claimDueLease: mock(async () => leased),
      finalizeRequest,
    });
    getBillingAttributionForOrganization.mockRejectedValueOnce(
      new Error("primary attribution unavailable"),
    );
    const stripe = stripeHarness();

    await service(durableRepository, stripe).executeAutoTopUpForOrganization(ORG_ID, {
      source: "manual",
    });

    expect(finalizeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        chargeAmountCents: 1000,
        requestMetadata: requestMetadata(),
      }),
    );
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test("retrieves a known PaymentIntent even after the unknown-response deadline", async () => {
    const durable = attempt({
      stripePaymentIntentId: "pi_known",
      recoveryDeadlineAt: new Date(NOW.getTime() - 1),
    });
    const durableRepository = processingRepository(durable);
    const stripe = stripeHarness();
    stripe.retrieve.mockResolvedValue(paymentIntent(durable, "processing", { id: "pi_known" }));

    const result = await service(durableRepository, stripe).executeAutoTopUpForOrganization(
      ORG_ID,
      { source: "recovery" },
    );

    expect(result.status).toBe("payment_pending");
    expect(result.recovered).toBe(true);
    expect(stripe.retrieve).toHaveBeenCalledWith("pi_known");
    expect(stripe.create).not.toHaveBeenCalled();
    expect(durableRepository.markManualReview).not.toHaveBeenCalled();
  });

  test("retries a concurrent in-flight Stripe idempotency request without disabling", async () => {
    const durable = attempt();
    const durableRepository = processingRepository(durable);
    const stripe = stripeHarness();
    stripe.create.mockRejectedValue(
      Object.assign(new Error("A request with the same idempotency key is in flight"), {
        type: "StripeIdempotencyError",
        code: "idempotency_key_in_use",
      }),
    );

    const result = await service(durableRepository, stripe).executeAutoTopUpForOrganization(
      ORG_ID,
      { source: "recovery" },
    );

    expect(result.status).toBe("payment_pending");
    expect(durableRepository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        result: {
          providerErrorType: "StripeIdempotencyError",
          providerErrorCode: "idempotency_key_in_use",
        },
      }),
    );
    expect(durableRepository.markManualReview).not.toHaveBeenCalled();
    expect(durableRepository.markCanceled).not.toHaveBeenCalled();
  });

  test("treats a partial PaymentIntent attached to a provider error as retryable", async () => {
    const durable = attempt();
    const durableRepository = processingRepository(durable);
    const stripe = stripeHarness();
    stripe.create.mockRejectedValue(
      Object.assign(new Error("provider returned a partial error payload"), {
        type: "StripeAPIError",
        payment_intent: { id: "pi_partial", status: "processing" },
      }),
    );

    const result = await service(durableRepository, stripe).executeAutoTopUpForOrganization(
      ORG_ID,
      { source: "recovery" },
    );

    expect(result.status).toBe("payment_pending");
    expect(durableRepository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        result: { providerErrorType: "StripeAPIError" },
      }),
    );
    expect(durableRepository.recordPaymentIntent).not.toHaveBeenCalled();
    expect(durableRepository.markManualReview).not.toHaveBeenCalled();
  });

  test("settles, invalidates all entitlement caches, then marks credited", async () => {
    const events: string[] = [];
    const durable = attempt();
    const leased = attempt({
      ...durable,
      leaseToken: "lease-token",
      leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    });
    const paid = attempt({
      ...leased,
      status: "payment_succeeded",
      stripePaymentIntentId: "pi_123",
      providerStatus: "succeeded",
      paymentSucceededAt: NOW,
    });
    const credited = attempt({
      ...paid,
      status: "credited",
      creditTransactionId: "credit-tx-1",
      leaseToken: null,
      leaseExpiresAt: null,
      creditedAt: NOW,
    });
    const durableRepository = repository({
      claimEligibleAttempt: mock(async () => ({ outcome: "created", attempt: durable })),
      claimDueLease: mock(async () => leased),
      recordPaymentIntent: mock(async () => paid),
      settleSucceededAttempt: mock(async () => ({
        outcome: "applied",
        attempt: paid,
        creditTransactionId: "credit-tx-1",
        newBalance: "15.00",
      })),
      markCredited: mock(async () => {
        events.push("mark-credited");
        return credited;
      }),
    });
    onCreditMutation.mockImplementationOnce(async () => {
      events.push("credits-cache");
    });
    invalidateOrganizationCache.mockImplementationOnce(async () => {
      events.push("organization-cache");
    });
    invalidateOrgTierCache.mockImplementationOnce(async () => {
      events.push("tier-cache");
    });
    const stripe = stripeHarness();
    stripe.create.mockResolvedValue(paymentIntent(durable, "succeeded"));

    const result = await service(durableRepository, stripe).executeAutoTopUpForOrganization(
      ORG_ID,
      { source: "manual" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        organizationId: ORG_ID,
        success: true,
        status: "credited",
        amount: 10,
        previousBalance: 5,
        newBalance: 15,
      }),
    );
    expect(events).toEqual(["credits-cache", "organization-cache", "tier-cache", "mark-credited"]);
    expect(durableRepository.settleSucceededAttempt).toHaveBeenCalledTimes(1);
    expect(durableRepository.markCredited).toHaveBeenCalledTimes(1);
  });

  test("leaves payment_succeeded recoverable when any cache invalidation fails", async () => {
    const durable = attempt();
    const leased = attempt({
      ...durable,
      leaseToken: "lease-token",
      leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    });
    const paid = attempt({
      ...leased,
      status: "payment_succeeded",
      stripePaymentIntentId: "pi_123",
      providerStatus: "succeeded",
    });
    const durableRepository = repository({
      claimEligibleAttempt: mock(async () => ({ outcome: "reused", attempt: durable })),
      claimDueLease: mock(async () => leased),
      recordPaymentIntent: mock(async () => paid),
      settleSucceededAttempt: mock(async () => ({
        outcome: "applied",
        attempt: paid,
        creditTransactionId: "credit-tx-1",
        newBalance: "15.00",
      })),
    });
    invalidateOrgTierCache.mockRejectedValueOnce(new Error("Redis unavailable"));
    const stripe = stripeHarness();
    stripe.create.mockResolvedValue(paymentIntent(durable, "succeeded"));

    const result = await service(durableRepository, stripe).executeAutoTopUpForOrganization(
      ORG_ID,
      { source: "recovery" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: "payment_succeeded",
        error: "Credit applied; cache synchronization will be retried",
      }),
    );
    expect(onCreditMutation).toHaveBeenCalledTimes(1);
    expect(invalidateOrganizationCache).toHaveBeenCalledTimes(1);
    expect(invalidateOrgTierCache).toHaveBeenCalledTimes(1);
    expect(durableRepository.markCredited).not.toHaveBeenCalled();
  });

  test("moves a mismatched provider receipt to manual review without settling", async () => {
    const durable = attempt();
    const leased = attempt({
      ...durable,
      leaseToken: "lease-token",
      leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    });
    const reviewed = attempt({
      ...leased,
      status: "manual_review",
      lastError: "Provider payment metadata does not match the durable attempt",
      manualReviewAt: NOW,
    });
    const durableRepository = repository({
      claimEligibleAttempt: mock(async () => ({ outcome: "created", attempt: durable })),
      claimDueLease: mock(async () => leased),
      markManualReview: mock(async () => reviewed),
    });
    const stripe = stripeHarness();
    stripe.create.mockResolvedValue(
      paymentIntent(durable, "succeeded", {
        metadata: requestMetadata({ organization_id: "another-org" }),
      }),
    );

    const result = await service(durableRepository, stripe).executeAutoTopUpForOrganization(
      ORG_ID,
      { source: "manual" },
    );

    expect(result.status).toBe("manual_review");
    expect(result.error).toBe("Provider payment metadata does not match the durable attempt");
    expect(durableRepository.markManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        error: "Provider payment metadata does not match the durable attempt",
      }),
    );
    expect(durableRepository.recordPaymentIntent).not.toHaveBeenCalled();
    expect(durableRepository.settleSucceededAttempt).not.toHaveBeenCalled();
    expect(durableRepository.markCredited).not.toHaveBeenCalled();
  });

  test.each(["requires_payment_method", "requires_confirmation"] as const)(
    "atomically cancels and disables auto top-up for provider state %s",
    async (providerStatus) => {
      const durable = attempt();
      const leased = attempt({
        ...durable,
        leaseToken: "lease-token",
        leaseExpiresAt: new Date(NOW.getTime() + 120_000),
      });
      const recorded = attempt({
        ...leased,
        stripePaymentIntentId: "pi_123",
        providerStatus,
      });
      const canceled = attempt({
        ...recorded,
        status: "canceled",
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: `Payment ${providerStatus}`,
        canceledAt: NOW,
      });
      const durableRepository = repository({
        claimEligibleAttempt: mock(async () => ({ outcome: "created", attempt: durable })),
        claimDueLease: mock(async () => leased),
        recordPaymentIntent: mock(async () => recorded),
        markCanceled: mock(async () => canceled),
      });
      const stripe = stripeHarness();
      stripe.create.mockResolvedValue(paymentIntent(durable, providerStatus));
      stripe.cancel.mockResolvedValue(paymentIntent(durable, "canceled"));

      const result = await service(durableRepository, stripe).executeAutoTopUpForOrganization(
        ORG_ID,
        { source: "manual" },
      );

      expect(result.status).toBe("canceled");
      expect(durableRepository.recordPaymentIntent).toHaveBeenCalledTimes(1);
      expect(stripe.cancel).toHaveBeenCalledWith("pi_123");
      expect(durableRepository.markCanceled).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptId: ATTEMPT_ID,
          error: `Payment ${providerStatus}`,
        }),
      );
      expect(invalidateOrganizationCache).toHaveBeenCalledWith(ORG_ID);
      expect(onOrganizationUpdated).toHaveBeenCalledWith(ORG_ID);
      expect(durableRepository.settleSucceededAttempt).not.toHaveBeenCalled();
    },
  );

  test("moves an ambiguous provider cancellation to manual review", async () => {
    const durable = attempt();
    const leased = attempt({
      ...durable,
      leaseToken: "lease-token",
      leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    });
    const recorded = attempt({
      ...leased,
      stripePaymentIntentId: "pi_123",
      providerStatus: "requires_action",
    });
    const reviewed = attempt({
      ...recorded,
      status: "manual_review",
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: "Provider payment could not be safely canceled",
      manualReviewAt: NOW,
    });
    const durableRepository = repository({
      claimEligibleAttempt: mock(async () => ({ outcome: "created", attempt: durable })),
      claimDueLease: mock(async () => leased),
      recordPaymentIntent: mock(async () => recorded),
      markManualReview: mock(async () => reviewed),
    });
    const stripe = stripeHarness();
    stripe.create.mockResolvedValue(paymentIntent(durable, "requires_action"));
    stripe.cancel.mockRejectedValue(new Error("provider cancellation timeout"));

    const result = await service(durableRepository, stripe).executeAutoTopUpForOrganization(
      ORG_ID,
      { source: "manual" },
    );

    expect(stripe.cancel).toHaveBeenCalledWith("pi_123");
    expect(result).toEqual(
      expect.objectContaining({
        status: "manual_review",
        error: "Provider payment could not be safely canceled",
      }),
    );
    expect(durableRepository.markManualReview).toHaveBeenCalledTimes(1);
    expect(durableRepository.markCanceled).not.toHaveBeenCalled();
  });

  test("records processing state and releases the lease for a bounded retry", async () => {
    const durable = attempt();
    const durableRepository = processingRepository(durable);
    const stripe = stripeHarness();
    stripe.create.mockResolvedValue(paymentIntent(durable, "processing"));

    const result = await service(durableRepository, stripe).executeAutoTopUpForOrganization(
      ORG_ID,
      { source: "manual" },
    );

    expect(result.status).toBe("payment_pending");
    expect(durableRepository.recordPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_123",
        providerStatus: "processing",
      }),
    );
    expect(durableRepository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Payment processing",
        nextAttemptAt: new Date(NOW.getTime() + 60_000),
      }),
    );
    expect(durableRepository.markCanceled).not.toHaveBeenCalled();
    expect(durableRepository.markManualReview).not.toHaveBeenCalled();
  });

  test("processes due recovery attempts before discovering new organizations", async () => {
    const events: string[] = [];
    const due = attempt({ stripePaymentIntentId: "pi_due" });
    const durableRepository = processingRepository(due, events);
    durableRepository.listDueAttempts = mock(async () => {
      events.push("list-due");
      return [due];
    });
    durableRepository.listEligibleOrganizationIds = mock(async () => {
      events.push("list-eligible");
      return ["org-new"];
    });
    durableRepository.claimEligibleAttempt = mock(async ({ organizationId }) => {
      events.push(`claim-${organizationId}`);
      return {
        outcome: "not_eligible" as const,
        organizationId,
        reason: "balance_at_or_above_threshold" as const,
      };
    });
    const stripe = stripeHarness();
    stripe.retrieve.mockImplementation(async () => {
      events.push("retrieve-known-pi");
      return paymentIntent(due, "processing", { id: "pi_due" });
    });

    const result = await service(durableRepository, stripe).checkAndExecuteAutoTopUps({
      source: "cron",
      limit: 2,
    });

    expect(events).toEqual([
      "list-due",
      "lease-due",
      "retrieve-known-pi",
      "record-payment-intent",
      "schedule-retry",
      "list-eligible",
      "claim-org-new",
    ]);
    expect(durableRepository.listEligibleOrganizationIds).toHaveBeenCalledWith({ limit: 1 });
    expect(result.organizationsChecked).toBe(2);
    expect(result.recovered).toBe(1);
    expect(result.skipped).toBe(2);
  });
});

describe("AutoTopUpService signed webhook reconciliation", () => {
  test("settles a matching succeeded webhook when no worker owns the lease", async () => {
    const candidate = attempt();
    const leased = attempt({
      ...candidate,
      leaseToken: "webhook-lease",
      leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    });
    const paid = attempt({
      ...leased,
      status: "payment_succeeded",
      stripePaymentIntentId: "pi_123",
      providerStatus: "succeeded",
      paymentSucceededAt: NOW,
    });
    const credited = attempt({
      ...paid,
      status: "credited",
      creditTransactionId: "credit-tx-1",
      leaseToken: null,
      leaseExpiresAt: null,
      creditedAt: NOW,
    });
    const durableRepository = repository({
      findById: mock(async () => candidate),
      claimDueLease: mock(async () => leased),
      recordPaymentIntent: mock(async () => paid),
      settleSucceededAttempt: mock(async () => ({
        outcome: "applied",
        attempt: paid,
        creditTransactionId: "credit-tx-1",
        newBalance: "15.00",
      })),
      markCredited: mock(async () => credited),
    });
    const stripe = stripeHarness();

    const reconciliation = await service(
      durableRepository,
      stripe,
      ["webhook-lease"],
      () => false,
    ).reconcileSucceededPaymentIntent(paymentIntent(candidate, "succeeded"));

    expect(reconciliation.disposition).toBe("settled");
    expect(reconciliation.result).toEqual(
      expect.objectContaining({
        success: true,
        status: "credited",
        recovered: true,
      }),
    );
    expect(durableRepository.recordPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        paymentIntentId: "pi_123",
        providerStatus: "succeeded",
      }),
    );
    expect(durableRepository.settleSucceededAttempt).toHaveBeenCalledTimes(1);
    expect(durableRepository.markCredited).toHaveBeenCalledTimes(1);
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test("defers a valid succeeded webhook while another worker owns the lease", async () => {
    const candidate = attempt({
      leaseToken: "active-owner",
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    });
    const durableRepository = repository({
      findById: mock(async () => candidate),
      claimDueLease: mock(async () => null),
    });
    const stripe = stripeHarness();

    const reconciliation = await service(durableRepository, stripe).reconcileSucceededPaymentIntent(
      paymentIntent(candidate, "succeeded"),
    );

    expect(reconciliation.disposition).toBe("validated_deferred");
    expect(reconciliation.result.status).toBe("payment_pending");
    expect(durableRepository.findById).toHaveBeenCalledTimes(2);
    expect(durableRepository.recordPaymentIntent).not.toHaveBeenCalled();
    expect(durableRepository.settleSucceededAttempt).not.toHaveBeenCalled();
    expect(durableRepository.markCredited).not.toHaveBeenCalled();
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test("reports unavailable when a fenced webhook attempt disappears before the re-read", async () => {
    const candidate = attempt({
      leaseToken: "active-owner",
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    });
    const findById = mock(async (): Promise<AutoTopUpAttempt | null> => candidate);
    findById.mockResolvedValueOnce(candidate).mockResolvedValueOnce(null);
    const durableRepository = repository({
      findById,
      claimDueLease: mock(async () => null),
    });

    const reconciliation = await service(
      durableRepository,
      stripeHarness(),
    ).reconcileSucceededPaymentIntent(paymentIntent(candidate, "succeeded"));

    expect(reconciliation).toEqual({
      disposition: "validated_deferred",
      result: {
        organizationId: ORG_ID,
        success: false,
        error: "Auto top-up state is unavailable",
        attemptId: ATTEMPT_ID,
        status: "unavailable",
        recovered: true,
      },
    });
    expect(findById).toHaveBeenCalledTimes(2);
    expect(durableRepository.recordPaymentIntent).not.toHaveBeenCalled();
  });

  test("reopens a matching manual review, leases it, and settles the signed success", async () => {
    const events: string[] = [];
    const reviewed = attempt({
      status: "manual_review",
      nextAttemptAt: null,
      lastError: "Provider request requires operator review",
      manualReviewAt: new Date(NOW.getTime() - 60_000),
    });
    const reopened = attempt({
      ...reviewed,
      status: "payment_succeeded",
      stripePaymentIntentId: "pi_123",
      providerStatus: "succeeded",
      nextAttemptAt: NOW,
      lastError: null,
      paymentSucceededAt: NOW,
    });
    const leased = attempt({
      ...reopened,
      leaseToken: "reopened-lease",
      leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    });
    const credited = attempt({
      ...leased,
      status: "credited",
      creditTransactionId: "credit-tx-1",
      leaseToken: null,
      leaseExpiresAt: null,
      creditedAt: NOW,
    });
    const durableRepository = repository({
      findById: mock(async () => reviewed),
      reopenManualReviewForSucceededPayment: mock(async () => {
        events.push("reopen");
        return reopened;
      }),
      claimDueLease: mock(async () => {
        events.push("lease");
        return leased;
      }),
      recordPaymentIntent: mock(async () => {
        events.push("record");
        return leased;
      }),
      settleSucceededAttempt: mock(async () => {
        events.push("settle");
        return {
          outcome: "applied",
          attempt: leased,
          creditTransactionId: "credit-tx-1",
          newBalance: "15.00",
        };
      }),
      markCredited: mock(async () => {
        events.push("credited");
        return credited;
      }),
    });
    const stripe = stripeHarness();

    const reconciliation = await service(durableRepository, stripe, [
      "reopened-lease",
    ]).reconcileSucceededPaymentIntent(paymentIntent(reviewed, "succeeded"));

    expect(reconciliation.disposition).toBe("settled");
    expect(reconciliation.result).toEqual(
      expect.objectContaining({ success: true, status: "credited", recovered: true }),
    );
    expect(events).toEqual(["reopen", "lease", "record", "settle", "credited"]);
    expect(durableRepository.reopenManualReviewForSucceededPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        paymentIntentId: "pi_123",
      }),
    );
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test("keeps a matching canceled attempt rejected and never reopens it", async () => {
    const canceled = attempt({
      status: "canceled",
      stripePaymentIntentId: "pi_123",
      providerStatus: "canceled",
      nextAttemptAt: null,
      lastError: "Payment canceled",
      canceledAt: new Date(NOW.getTime() - 60_000),
    });
    const durableRepository = repository({
      findById: mock(async () => canceled),
    });
    const stripe = stripeHarness();

    const reconciliation = await service(durableRepository, stripe).reconcileSucceededPaymentIntent(
      paymentIntent(canceled, "succeeded"),
    );

    expect(reconciliation.disposition).toBe("rejected");
    expect(reconciliation.result).toEqual(
      expect.objectContaining({ status: "canceled", error: "Payment canceled", recovered: true }),
    );
    expect(durableRepository.reopenManualReviewForSucceededPayment).not.toHaveBeenCalled();
    expect(durableRepository.claimDueLease).not.toHaveBeenCalled();
    expect(durableRepository.recordPaymentIntent).not.toHaveBeenCalled();
    expect(durableRepository.settleSucceededAttempt).not.toHaveBeenCalled();
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test.each([
    [
      "an extra metadata field",
      (metadata: Record<string, string>) => ({ ...metadata, forged: "true" }),
    ],
    [
      "a tampered affiliate owner",
      (metadata: Record<string, string>) => ({
        ...metadata,
        affiliate_owner_id: "attacker",
      }),
    ],
  ])("rejects %s without any settlement or provider call", async (_label, tamper) => {
    const affiliateMetadata = requestMetadata({
      user_id: "billing-user",
      total_charged: "13.00",
      platform_fee_amount: "2.00",
      affiliate_fee_amount: "1.00",
      affiliate_owner_id: "affiliate-owner",
      affiliate_code_id: "affiliate-code",
    });
    const candidate = attempt({
      chargeAmountCents: 1300,
      requestMetadata: affiliateMetadata,
    });
    const leased = attempt({
      ...candidate,
      leaseToken: "rejection-lease",
      leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    });
    const reviewed = attempt({
      ...leased,
      status: "manual_review",
      lastError: "Provider payment metadata does not match the durable attempt",
      manualReviewAt: NOW,
    });
    const durableRepository = repository({
      findById: mock(async () => candidate),
      claimDueLease: mock(async () => leased),
      markManualReview: mock(async () => reviewed),
    });
    const stripe = stripeHarness();
    const observed = paymentIntent(candidate, "succeeded", {
      metadata: tamper(affiliateMetadata),
    });

    const reconciliation = await service(durableRepository, stripe, [
      "rejection-lease",
    ]).reconcileSucceededPaymentIntent(observed);

    expect(reconciliation.disposition).toBe("rejected");
    expect(reconciliation.result.status).toBe("manual_review");
    expect(reconciliation.result.error).toBe(
      "Provider payment metadata does not match the durable attempt",
    );
    expect(durableRepository.markManualReview).toHaveBeenCalledTimes(1);
    expect(durableRepository.recordPaymentIntent).not.toHaveBeenCalled();
    expect(durableRepository.settleSucceededAttempt).not.toHaveBeenCalled();
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test("treats a matching credited replay as already settled", async () => {
    const credited = attempt({
      status: "credited",
      stripePaymentIntentId: "pi_123",
      creditTransactionId: "credit-tx-1",
      providerStatus: "succeeded",
      paymentSucceededAt: new Date(NOW.getTime() - 60_000),
      creditedAt: new Date(NOW.getTime() - 30_000),
    });
    const durableRepository = repository({
      findById: mock(async () => credited),
    });
    const stripe = stripeHarness();

    const reconciliation = await service(durableRepository, stripe).reconcileSucceededPaymentIntent(
      paymentIntent(credited, "succeeded"),
    );

    expect(reconciliation.disposition).toBe("settled");
    expect(reconciliation.result).toEqual(
      expect.objectContaining({ success: true, status: "credited", recovered: true }),
    );
    expect(durableRepository.claimDueLease).not.toHaveBeenCalled();
    expect(durableRepository.recordPaymentIntent).not.toHaveBeenCalled();
    expect(durableRepository.settleSucceededAttempt).not.toHaveBeenCalled();
    expect(durableRepository.markCredited).not.toHaveBeenCalled();
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test.each([
    ["an absent amount_received", null],
    ["a mismatched amount_received", 999],
  ])("rejects a succeeded webhook with %s", async (_label, amountReceived) => {
    const candidate = attempt();
    const leased = attempt({
      ...candidate,
      leaseToken: "rejection-lease",
      leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    });
    const reviewed = attempt({
      ...leased,
      status: "manual_review",
      lastError: "Provider received amount does not match the durable attempt",
      manualReviewAt: NOW,
    });
    const durableRepository = repository({
      findById: mock(async () => candidate),
      claimDueLease: mock(async () => leased),
      markManualReview: mock(async () => reviewed),
    });
    const stripe = stripeHarness();
    const observed = paymentIntent(candidate, "succeeded");
    if (amountReceived === null) {
      Reflect.deleteProperty(observed, "amount_received");
    } else {
      observed.amount_received = amountReceived;
    }

    const reconciliation = await service(durableRepository, stripe, [
      "rejection-lease",
    ]).reconcileSucceededPaymentIntent(observed);

    expect(reconciliation.disposition).toBe("rejected");
    expect(reconciliation.result.status).toBe("manual_review");
    expect(reconciliation.result.error).toBe(
      "Provider received amount does not match the durable attempt",
    );
    expect(durableRepository.recordPaymentIntent).not.toHaveBeenCalled();
    expect(durableRepository.settleSucceededAttempt).not.toHaveBeenCalled();
    expect(stripe.provide).not.toHaveBeenCalled();
  });
});

describe("AutoTopUpService persisted request validation and fairness", () => {
  test.each([
    ["empty metadata", () => attempt({ requestMetadata: {} })],
    [
      "incoherent base credits",
      () => attempt({ requestMetadata: requestMetadata({ credits: "9.99" }) }),
    ],
    [
      "affiliate fees above the charge delta",
      () =>
        attempt({
          chargeAmountCents: 1200,
          requestMetadata: requestMetadata({
            total_charged: "12.00",
            platform_fee_amount: "0.00",
            affiliate_fee_amount: "3.00",
            affiliate_owner_id: "affiliate-owner",
            affiliate_code_id: "affiliate-code",
          }),
        }),
    ],
    [
      "a coherent but policy-invalid platform overcharge",
      () =>
        attempt({
          chargeAmountCents: 10_000,
          requestMetadata: requestMetadata({
            total_charged: "100.00",
            platform_fee_amount: "90.00",
          }),
        }),
    ],
  ])("moves %s to manual review before Stripe", async (_label, buildAttempt) => {
    const candidate = buildAttempt();
    const leased = attempt({
      ...candidate,
      leaseToken: "lease-token",
      leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    });
    const reviewed = attempt({
      ...leased,
      status: "manual_review",
      lastError: "Durable provider metadata is invalid",
      manualReviewAt: NOW,
    });
    const durableRepository = repository({
      claimEligibleAttempt: mock(async () => ({ outcome: "reused", attempt: candidate })),
      claimDueLease: mock(async () => leased),
      markManualReview: mock(async () => reviewed),
    });
    const stripe = stripeHarness();

    const result = await service(durableRepository, stripe).executeAutoTopUpForOrganization(
      ORG_ID,
      { source: "recovery" },
    );

    expect(result.status).toBe("manual_review");
    expect(result.error).toBe("Durable provider metadata is invalid");
    expect(durableRepository.markProviderRequestStarted).not.toHaveBeenCalled();
    expect(durableRepository.recordPaymentIntent).not.toHaveBeenCalled();
    expect(durableRepository.settleSucceededAttempt).not.toHaveBeenCalled();
    expect(stripe.create).not.toHaveBeenCalled();
    expect(stripe.retrieve).not.toHaveBeenCalled();
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test("reserves 25% of a full cron backlog for newly eligible organizations", async () => {
    const backlog = Array.from({ length: 4 }, (_, index) =>
      attempt({
        id: `due-${index + 1}`,
        organizationId: `org-due-${index + 1}`,
        idempotencyKey: `auto_top_up:v1:due-${index + 1}`,
      }),
    );
    const listDueAttempts = mock(async ({ limit }: { limit: number }) => backlog.slice(0, limit));
    const durableRepository = repository({
      listDueAttempts,
      claimDueLease: mock(async () => null),
      findById: mock(async (attemptId) => backlog.find((row) => row.id === attemptId) ?? null),
      listEligibleOrganizationIds: mock(async () => ["org-new"]),
      claimEligibleAttempt: mock(async ({ organizationId }) => ({
        outcome: "not_eligible" as const,
        organizationId,
        reason: "balance_at_or_above_threshold" as const,
      })),
    });
    const stripe = stripeHarness();

    const result = await service(durableRepository, stripe).checkAndExecuteAutoTopUps({
      source: "cron",
      limit: 4,
    });

    expect(listDueAttempts).toHaveBeenCalledWith({ now: NOW, limit: 3 });
    expect(durableRepository.claimDueLease).toHaveBeenCalledTimes(3);
    expect(durableRepository.listEligibleOrganizationIds).toHaveBeenCalledWith({ limit: 1 });
    expect(durableRepository.claimEligibleAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-new", triggerSource: "cron" }),
    );
    expect(result.organizationsChecked).toBe(4);
    expect(result.recovered).toBe(3);
    expect(result.skipped).toBe(4);
    expect(stripe.provide).not.toHaveBeenCalled();
  });

  test("re-reads durable recovery state after partial progress throws", async () => {
    const stale = attempt({
      status: "payment_pending",
      stripePaymentIntentId: "pi_committed",
      providerStatus: "processing",
    });
    const paid = attempt({
      status: "payment_succeeded",
      stripePaymentIntentId: "pi_committed",
      providerStatus: "succeeded",
      paymentSucceededAt: NOW,
    });
    const durableRepository = repository({
      listDueAttempts: mock(async () => [stale]),
      claimDueLease: mock(async () => {
        throw new Error("worker terminated after provider success");
      }),
      findById: mock(async () => paid),
    });
    const stripe = stripeHarness();

    const result = await service(durableRepository, stripe).checkAndExecuteAutoTopUps({
      source: "cron",
      limit: 1,
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        organizationId: ORG_ID,
        attemptId: ATTEMPT_ID,
        status: "payment_succeeded",
        recovered: true,
        error: "Auto top-up recovery is pending",
      }),
    ]);
    expect(result.failed).toBe(0);
    expect(durableRepository.findById).toHaveBeenCalledWith(ATTEMPT_ID);
  });

  test("reports the durable attempt state when new-org processing throws", async () => {
    const paid = attempt({
      status: "payment_succeeded",
      stripePaymentIntentId: "pi_committed",
      providerStatus: "succeeded",
      paymentSucceededAt: NOW,
    });
    const durableRepository = repository({
      listDueAttempts: mock(async () => []),
      listEligibleOrganizationIds: mock(async () => [ORG_ID]),
      claimEligibleAttempt: mock(async () => ({ outcome: "reused", attempt: paid })),
      claimDueLease: mock(async () => {
        throw new Error("worker terminated after provider success");
      }),
      findBlockingByOrganization: mock(async () => paid),
    });
    const stripe = stripeHarness();

    const result = await service(durableRepository, stripe).checkAndExecuteAutoTopUps({
      source: "cron",
      limit: 1,
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        organizationId: ORG_ID,
        attemptId: ATTEMPT_ID,
        status: "payment_succeeded",
        recovered: true,
        error: "Auto top-up recovery is pending",
      }),
    ]);
    expect(result.failed).toBe(0);
    expect(durableRepository.findBlockingByOrganization).toHaveBeenCalledWith(ORG_ID);
  });

  test("uses an explicit unavailable state when no durable failure state can be read", async () => {
    const durableRepository = repository({
      listDueAttempts: mock(async () => []),
      listEligibleOrganizationIds: mock(async () => [ORG_ID]),
      claimEligibleAttempt: mock(async () => {
        throw new Error("database unavailable before claim");
      }),
      findBlockingByOrganization: mock(async () => null),
    });
    const stripe = stripeHarness();

    const result = await service(durableRepository, stripe).checkAndExecuteAutoTopUps({
      source: "cron",
      limit: 1,
    });

    expect(result.results).toEqual([
      {
        organizationId: ORG_ID,
        success: false,
        error: "Auto top-up state is unavailable",
        status: "unavailable",
        recovered: false,
      },
    ]);
    expect(result.failed).toBe(1);
  });
});

describe("parseAutoTopUpNumber fail-closed boundary", () => {
  test("parses finite canonical numeric inputs", () => {
    expect(parseAutoTopUpNumber("auto_top_up_amount", "10.00")).toBe(10);
    expect(parseAutoTopUpNumber("markup_percent", 5)).toBe(5);
    expect(parseAutoTopUpNumber("markup_percent", "0")).toBe(0);
  });

  test.each([null, undefined, "", "   ", "abc", "NaN", Number.POSITIVE_INFINITY])(
    "rejects corrupt monetary input %p",
    (value) => {
      expect(() => parseAutoTopUpNumber("auto_top_up_amount", value)).toThrow(
        CorruptAutoTopUpNumberError,
      );
    },
  );
});

describe("AutoTopUpService.validateSettings", () => {
  const autoTopUp = new AutoTopUpService();

  test("accepts inclusive boundaries", () => {
    expect(() => autoTopUp.validateSettings(1, 0)).not.toThrow();
    expect(() => autoTopUp.validateSettings(1000, 1000)).not.toThrow();
  });

  test.each([
    [0.5, 5, /at least \$1/],
    [1001, 5, /cannot exceed \$1000/],
    [10, -1, /threshold must be at least/],
    [10, 1001, /threshold cannot exceed/],
  ] as const)("rejects invalid settings amount=%p threshold=%p", (amount, threshold, message) => {
    expect(() => autoTopUp.validateSettings(amount, threshold)).toThrow(message);
  });
});
describe("AutoTopUpService settings compatibility", () => {
  beforeEach(() => {
    findOrganizationById.mockResolvedValue(makeOrganization());
  });
  test("reads the existing billing settings without unsealing charging", async () => {
    const result = await new AutoTopUpService().getSettings("org-1");

    expect(result).toEqual({
      enabled: true,
      amount: 10,
      threshold: 5,
      hasPaymentMethod: true,
    });
  });

  test("preserves zero defaults for normally unconfigured settings", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: null,
        auto_top_up_threshold: null,
      }),
    );

    await expect(new AutoTopUpService().getSettings("org-1")).resolves.toEqual({
      enabled: false,
      amount: 0,
      threshold: 0,
      hasPaymentMethod: true,
    });
  });

  test("reports genuinely corrupt disabled settings as null without fabricating values", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: "NaN",
        auto_top_up_threshold: "not-a-number",
      }),
    );

    await expect(new AutoTopUpService().getSettings("org-1")).resolves.toEqual({
      enabled: false,
      amount: null,
      threshold: null,
      hasPaymentMethod: true,
    });
  });

  test("persists validated decimal settings", async () => {
    await new AutoTopUpService().updateSettings("org-1", {
      enabled: true,
      amount: 25,
      threshold: 10,
    });

    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        auto_top_up_enabled: true,
        auto_top_up_amount: "25.00",
        auto_top_up_threshold: "10.00",
        updated_at: expect.any(Date),
      }),
    );
  });

  test("rejects enabling without a payment method", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({ stripe_default_payment_method: null }),
    );

    await expect(new AutoTopUpService().updateSettings("org-1", { enabled: true })).rejects.toThrow(
      "Cannot enable auto top-up without a default payment method",
    );
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  test("rejects re-enabling while an earlier provider payment requires reconciliation", async () => {
    findBlockingLegacyPaymentByOrganization.mockResolvedValueOnce({
      id: "legacy-review-1",
      status: "manual_review",
    });

    await expect(new AutoTopUpService().updateSettings("org-1", { enabled: true })).rejects.toThrow(
      "Cannot enable auto top-up while an earlier card payment requires reconciliation",
    );
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  test("rejects re-enabling while a durable attempt requires manual review", async () => {
    findBlockingByOrganization.mockResolvedValueOnce({
      id: "durable-review-1",
      status: "manual_review",
    });

    await expect(new AutoTopUpService().updateSettings("org-1", { enabled: true })).rejects.toThrow(
      "Cannot enable auto top-up while an earlier card payment requires reconciliation",
    );
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  test("requires an explicit value for every corrupt setting when enabling", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: "NaN",
        auto_top_up_threshold: "not-a-number",
      }),
    );

    await expect(
      new AutoTopUpService().updateSettings("org-1", { enabled: true, amount: 25 }),
    ).rejects.toThrow("Valid auto top-up values are required to replace corrupt settings");
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  test("repairs only a corrupt amount while reusing a valid persisted threshold", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: "NaN",
        auto_top_up_threshold: "8.00",
      }),
    );

    await new AutoTopUpService().updateSettings("org-1", {
      enabled: true,
      amount: 25,
    });

    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        auto_top_up_enabled: true,
        auto_top_up_amount: "25.00",
      }),
    );
    expect(updateOrganization.mock.calls[0]?.[1]).not.toHaveProperty("auto_top_up_threshold");
  });

  test("repairs only a corrupt threshold while reusing a valid persisted amount", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: "25.00",
        auto_top_up_threshold: "not-a-number",
      }),
    );

    await new AutoTopUpService().updateSettings("org-1", {
      enabled: true,
      threshold: 8,
    });

    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        auto_top_up_enabled: true,
        auto_top_up_threshold: "8.00",
      }),
    );
    expect(updateOrganization.mock.calls[0]?.[1]).not.toHaveProperty("auto_top_up_amount");
  });

  test("repairs corrupt settings when enabling with explicit valid values", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: "NaN",
        auto_top_up_threshold: "not-a-number",
      }),
    );

    await new AutoTopUpService().updateSettings("org-1", {
      enabled: true,
      amount: 25,
      threshold: 10,
    });

    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        auto_top_up_enabled: true,
        auto_top_up_amount: "25.00",
        auto_top_up_threshold: "10.00",
      }),
    );
  });

  test("rejects enabling normally unconfigured settings through safe range validation", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: null,
        auto_top_up_threshold: null,
      }),
    );

    await expect(new AutoTopUpService().updateSettings("org-1", { enabled: true })).rejects.toThrow(
      "Auto top-up amount must be at least $1",
    );
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  test("persists the legacy zero threshold when enabling from SQL NULL", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: "10.00",
        auto_top_up_threshold: null,
      }),
    );

    await new AutoTopUpService().updateSettings("org-1", { enabled: true });

    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        auto_top_up_enabled: true,
        auto_top_up_threshold: "0.00",
      }),
    );
  });

  test("uses the legacy zero fallback for a partial update on unconfigured settings", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: null,
        auto_top_up_threshold: null,
      }),
    );

    await new AutoTopUpService().updateSettings("org-1", { amount: 10 });

    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ auto_top_up_amount: "10.00" }),
    );
  });

  test("rejects a partial update whose missing counterpart is corrupt", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_enabled: false,
        auto_top_up_amount: "10.00",
        auto_top_up_threshold: "not-a-number",
      }),
    );

    await expect(new AutoTopUpService().updateSettings("org-1", { amount: 25 })).rejects.toThrow(
      "Valid auto top-up values are required to replace corrupt settings",
    );
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  test("allows fail-closed disable even when persisted amount fields are corrupt", async () => {
    findOrganizationById.mockResolvedValueOnce(
      makeOrganization({
        auto_top_up_amount: "NaN",
        auto_top_up_threshold: "not-a-number",
      }),
    );

    await new AutoTopUpService().updateSettings("org-1", { enabled: false });

    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ auto_top_up_enabled: false }),
    );
  });
});
