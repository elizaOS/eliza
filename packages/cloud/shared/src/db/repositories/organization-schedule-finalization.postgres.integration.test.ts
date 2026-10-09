/** Real PostgreSQL cleanup authority; provider traffic is synthetic. */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { seedOrganizationDowngradeTestAccount } from "./organization-downgrade-test-fixture";
import { installOrganizationUpgradeTestSchema } from "./organization-upgrade-test-fixture";

let stripeMock: unknown;
mock.module(resolve(import.meta.dir, "../../lib/stripe.ts"), () => ({
  requireStripe: () => stripeMock,
  createStripeRecoveryClient: () => stripeMock,
}));
const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `schedule_configured_finalizer_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
let close: typeof import("../client").closeDatabaseConnectionsForTests;
let repo: typeof import("./organization-schedule-effects");
async function seed(validityMs = 60000, period?: { start: Date; end: Date }) {
  const f = await seedOrganizationDowngradeTestAccount(
    (q, v) => db.query(q, v),
    validityMs,
    period,
  );
  const { prepareOrganizationDowngrade } = await import("./organization-downgrade-commands");
  const prepared = await prepareOrganizationDowngrade({
    ...f.input,
    quoteId: f.quote.id,
    idempotencyKey: randomUUID(),
  });
  const identity = {
    organizationId: f.input.organizationId,
    actorId: f.input.actorId,
    commandId: prepared.command.id,
  };
  return { ...f, identity };
}
async function claimed(validityMs = 60000, period?: { start: Date; end: Date }) {
  const f = await seed(validityMs, period),
    result = await repo.claimOrganizationSchedule(f.identity);
  if (!result) throw new Error("Fixture claim unavailable");
  return { ...f, ...result };
}

(url ? describe : describe.skip)("original configuration finalization", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await installOrganizationUpgradeTestSchema((q) => db.query(q));
    const originalMigration = await readFile(
      new URL("../migrations/0530_subscription_invoice_event_evidence.sql", import.meta.url),
      "utf8",
    );
    for (const statement of originalMigration.split("--> statement-breakpoint"))
      if (statement.trim()) await db.query(statement);
    const reconciliationMigration = await readFile(
      new URL("../migrations/0385_subscription_reconciliation.sql", import.meta.url),
      "utf8",
    );
    for (const statement of reconciliationMigration.split("--> statement-breakpoint"))
      if (statement.trim()) await db.query(statement);
    // Test-only logical time spans a real calendar month without rewriting retained evidence.
    // Production and the other PostgreSQL suites keep their unmodified database clock.
    await db.query(`CREATE TABLE fixture_clock (offset_seconds double precision NOT NULL);
      INSERT INTO fixture_clock VALUES (0);
      CREATE FUNCTION ${schema}.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS
      'SELECT pg_catalog.clock_timestamp() + offset_seconds * interval ''1 second'' FROM ${schema}.fixture_clock'`);
    await db.query(`SET search_path TO ${schema},pg_catalog,public`);
    const target = new URL(url!);
    target.searchParams.set("options", `-c search_path=${schema},pg_catalog,public`);
    process.env.DATABASE_URL = target.toString();
    process.env.TEST_DATABASE_URL = target.toString();
    process.env.ENVIRONMENT = "local";
    repo = await import("./organization-schedule-effects");
    ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
  }, 120000);
  afterAll(async () => {
    if (!db) return;
    await close?.();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });
  async function providerCreated(period?: { start: Date; end: Date }, record = true) {
    const f = await claimed(60000, period);
    const { originalScheduleTestInput } = await import(
      "../../lib/services/organization-schedule-provider-test-fixture"
    );
    const { completeScheduleSubscriptionTestObservation, scheduleCustomerTestObservation } =
      await import("../../lib/services/organization-schedule-test-fixture");
    const start = record
      ? await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id)
      : f.effect;
    const rawCreate = structuredClone(originalScheduleTestInput().rawCurrentSchedule);
    rawCreate.id = "sub_sched_owned";
    rawCreate.default_settings.description = null;
    rawCreate.customer = f.source.stripe_customer_id;
    rawCreate.subscription = f.source.stripe_subscription_id;
    rawCreate.created = Math.floor((start.started_at ?? new Date()).getTime() / 1000);
    rawCreate.current_phase = {
      start_date: f.source.current_period_start.getTime() / 1000,
      end_date: f.source.current_period_end.getTime() / 1000,
    };
    rawCreate.phases[0]!.start_date = rawCreate.current_phase.start_date;
    rawCreate.phases[0]!.end_date = rawCreate.current_phase.end_date;
    function transport(raw: object, requestId: string, key: string) {
      return Object.defineProperty(raw, "lastResponse", {
        value: { requestId, idempotencyKey: key, apiVersion: "2024-11-20.acacia", statusCode: 200 },
      });
    }
    const createEvidence = {
      kind: "response" as const,
      raw: transport(rawCreate, "req_create", start.provider_idempotency_key),
    };
    if (record)
      await repo.recordAuthenticatedOrganizationScheduleEvidence(
        f.identity,
        f.claim,
        start.id,
        createEvidence,
      );
    return {
      ...f,
      rawCreate,
      createEvidence,
      transport,
      createKey: start.provider_idempotency_key,
      rawSubscription: completeScheduleSubscriptionTestObservation(f.provider),
      rawCustomer: scheduleCustomerTestObservation(f.source.stripe_customer_id),
    };
  }
  async function configured(
    recordReceipt = true,
    markDispatch = true,
    period?: { start: Date; end: Date },
  ) {
    const f = await providerCreated(period);
    const { mapOrganizationDowngradeSchedulePhases } = await import(
      "../../lib/services/organization-schedule-phase-mapping"
    );
    const { oneMonthlySchedulePhaseEnd } = await import(
      "../../lib/services/organization-schedule-configuration-proof"
    );
    const rawSubscription = { ...f.rawSubscription, schedule: f.rawCreate.id };
    const create = (
      await db.query(
        "SELECT * FROM organization_schedule_effects WHERE command_id=$1 AND kind='schedule_create'",
        [f.identity.commandId],
      )
    ).rows[0];
    const request = mapOrganizationDowngradeSchedulePhases({
      originalReceipt: create.receipt,
      originalRequest: {
        request: create.request_payload,
        providerIdempotencyKey: create.provider_idempotency_key,
        customerId: create.customer_id,
        subscriptionId: create.subscription_id,
        livemode: create.livemode,
        startedAt: create.started_at,
      },
      evidence: f.createEvidence,
      rawCurrentSchedule: f.rawCreate,
      rawSubscription,
      rawCustomer: f.rawCustomer,
      originalTerms: f.retainedTerms,
      observedAt: new Date(),
      targetPriceId: f.providerBinding.targetPriceId,
    });
    if (request.kind !== "schedule_configure") throw Error("Expected configuration");
    const prepared = await repo.prepareOrganizationScheduleConfiguration(
      f.identity,
      f.claim,
      request,
    );
    const started = markDispatch
      ? await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, prepared.id)
      : prepared;
    const snapshot = {
      ...structuredClone(f.rawCreate),
      phases: request.params.phases.map((p, i) => ({
        ...f.rawCreate.phases[0],
        ...p,
        end_date: i === 0 ? p.end_date : oneMonthlySchedulePhaseEnd(p.start_date),
        items: p.items.map((item) => ({
          ...(f.rawCreate.phases[0]!.items as Record<string, unknown>[])[0],
          ...item,
          plan: item.price,
        })),
      })),
    };
    for (const phase of snapshot.phases) Reflect.deleteProperty(phase, "iterations");
    const configurationEvidence = {
      kind: "response" as const,
      raw: f.transport(
        structuredClone(snapshot),
        "req_configured",
        started.provider_idempotency_key,
      ),
    };
    if (recordReceipt)
      await repo.recordAuthenticatedOrganizationScheduleEvidence(
        f.identity,
        f.claim,
        started.id,
        configurationEvidence,
      );
    const input = {
      ...f.identity,
      leaseToken: f.claim.leaseToken,
      executionGeneration: f.claim.generation,
      createEvidence: f.createEvidence,
      configurationEvidence,
      rawCurrentSchedule: snapshot,
      rawSubscription,
      rawCustomer: f.rawCustomer,
    };
    const { finalizeConfiguredOrganizationSchedule: finalize } = await import(
      "./organization-schedule-finalization"
    );
    return { ...f, input, finalize, configurationEffect: started };
  }
  async function state(f: Awaited<ReturnType<typeof configured>>) {
    const source = (
      await db.query("SELECT * FROM billing_subscriptions WHERE id=$1", [f.captured.source.id])
    ).rows[0];
    const projection = (
      await db.query(
        "SELECT * FROM organization_entitlements WHERE organization_id=$1 AND billing_scope_id IS NULL",
        [f.identity.organizationId],
      )
    ).rows[0];
    const allowance = (
      await db.query(
        "SELECT to_jsonb(t) AS value FROM subscription_allowance_transactions t WHERE organization_id=$1 ORDER BY id",
        [f.identity.organizationId],
      )
    ).rows;
    const periods = (
      await db.query(
        "SELECT to_jsonb(t) AS value FROM subscription_allowance_periods t WHERE organization_id=$1 ORDER BY id",
        [f.identity.organizationId],
      )
    ).rows;
    const command = (
      await db.query("SELECT * FROM billing_subscription_commands WHERE id=$1", [
        f.identity.commandId,
      ])
    ).rows[0];
    if (!source || !projection || !command) throw new Error("Fixture authority row missing");
    return { source, projection, allowance, periods, command };
  }
  test("deferred target invoice resolves reviewed terms without a paid target revision or grant", async () => {
    const f = await configured();
    await f.finalize(f.input);
    const { checkoutContractSchema, checkoutContractDigest } = await import(
      "../../lib/services/subscription-checkout-contract"
    );
    const source = f.captured.source;
    const metadata = {
      app: "eliza-cloud",
      organization_id: source.organization_id,
      command_id: source.id,
    };
    const payload = checkoutContractSchema.parse({
      version: 1,
      catalogVersion: "v1",
      planKey: "pro_monthly",
      accountId: "acct_original",
      expectedLivemode: false,
      priceId: f.providerBinding.sourcePriceId,
      productId: f.providerBinding.sourceProductId,
      presentation: "embedded",
      params: {
        mode: "subscription",
        currency: "usd",
        customer: source.stripe_customer_id,
        client_reference_id: source.id,
        line_items: [{ price: f.providerBinding.sourcePriceId, quantity: 1 }],
        payment_method_types: ["card"],
        allow_promotion_codes: false,
        automatic_tax: { enabled: false },
        metadata,
        subscription_data: { metadata },
        ui_mode: "embedded",
        redirect_on_completion: "never",
        expires_at: 1800000000,
      },
    });
    await db.query(
      `INSERT INTO billing_subscription_commands(id,organization_id,requested_by_user_id,kind,target_plan_key,idempotency_key,provider_idempotency_key,request_digest,status,execution_generation,provider_started_at,provider_response_digest,completed_at,applied_at,result_subscription_id,checkout_contract)
      VALUES($1,$2,$3,'checkout','pro_monthly',$4,$4,$5,'APPLIED',1,clock_timestamp(),$5,clock_timestamp(),clock_timestamp(),$1,$6::jsonb)`,
      [
        source.id,
        source.organization_id,
        f.identity.actorId,
        randomUUID(),
        "a".repeat(64),
        JSON.stringify({ payload, digest: checkoutContractDigest(payload) }),
      ],
    );
    const { invoiceEventFixture } = await import(
      "../../lib/services/test-support/subscription-invoice-event-fixture"
    );
    const { createSubscriptionInvoiceEventEvidence } = await import(
      "../../lib/services/subscription-invoice-event-evidence"
    );
    const { findOriginalInvoiceCommercialOrigin } = await import(
      "./subscription-invoice-commercial-origin"
    );
    const original = invoiceEventFixture();
    const scope = {
      ...original.scope,
      organizationId: source.organization_id,
      subscriptionId: source.id,
      providerAccountId: "acct_original",
      customerId: source.stripe_customer_id,
      providerSubscriptionId: source.stripe_subscription_id,
    };
    const phase = f.input.rawCurrentSchedule.phases[1]!;
    Object.assign(original.invoice, {
      customer: scope.customerId,
      subscription: scope.providerSubscriptionId,
      total: 3000,
      subtotal: 3000,
      ending_balance: 3000,
    });
    const line = original.invoice.lines.data[0]!;
    Object.assign(line, {
      subscription: scope.providerSubscriptionId,
      subscription_item: source.stripe_subscription_item_id,
      amount: 3000,
      period: { start: phase.start_date, end: phase.end_date },
      price: { id: f.providerBinding.targetPriceId, product: f.providerBinding.targetProductId },
    });
    original.event.created = phase.start_date + 1;
    original.invoice.status_transitions.paid_at = original.event.created;
    const retained = () => createSubscriptionInvoiceEventEvidence(original.event, scope);
    const before = await state(f);
    const terms = await findOriginalInvoiceCommercialOrigin(retained(), f.identity.commandId);
    expect(terms.planKey).toBe("plus_monthly");
    expect(terms.allowanceAmountUsd).toBe("25.000000");
    expect(terms.originKind).toBe("downgrade");
    expect(terms.periodStart).toBe(phase.start_date);
    const { assertReceiptCommercialSelection } = await import(
      "./test-support/subscription-commercial-selection"
    );
    await assertReceiptCommercialSelection({
      query: (q, v) => db.query(q, v),
      original: retained(),
      commandId: f.identity.commandId,
    });
    expect(await findOriginalInvoiceCommercialOrigin(retained(), f.identity.commandId)).toEqual(
      terms,
    );
    expect(await state(f)).toEqual(before);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM billing_subscription_revisions WHERE subscription_id=$1 AND plan_key='plus_monthly'",
          [source.id],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    for (const change of [
      { price: { ...line.price, id: "price_foreign" } },
      { subscription_item: "si_foreign" },
      { period: { start: phase.start_date - 1, end: phase.end_date } },
      { amount: 2999 },
    ]) {
      const saved = structuredClone(line);
      Object.assign(line, change);
      await expect(
        findOriginalInvoiceCommercialOrigin(retained(), f.identity.commandId),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE" });
      Object.assign(line, saved);
    }
    await expect(findOriginalInvoiceCommercialOrigin(retained(), source.id)).rejects.toMatchObject({
      code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
    });
    const foreign = createSubscriptionInvoiceEventEvidence(original.event, {
      ...scope,
      providerAccountId: "acct_foreign",
    });
    await expect(
      findOriginalInvoiceCommercialOrigin(foreign, f.identity.commandId),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE" });
    expect(await state(f)).toEqual(before);
  });
  test("original configuration atomically publishes only a pending plan and immutable replay", async () => {
    const f = await configured();
    const before = await state(f);
    const result = await f.finalize(f.input);
    const after = await state(f);
    expect(result.command.status).toBe("APPLIED");
    expect(result.replayed).toBeFalse();
    const snapshot = result.command.organization_schedule_configuration_snapshot;
    expect(snapshot).toEqual(JSON.parse(JSON.stringify(f.input.rawCurrentSchedule)));
    const { settlementDigest } = await import("../../lib/services/settlement-digest");
    expect(settlementDigest(snapshot)).toBe(
      result.command.organization_schedule_configuration_evidence!.snapshotDigest,
    );
    expect(snapshot).not.toHaveProperty("lastResponse");
    expect(after.command.organization_schedule_configuration_snapshot).toEqual(snapshot);
    expect(after.source.plan_key).toBe("pro_monthly");
    expect(after.source.pending_plan_key).toBe("plus_monthly");
    expect(Number(after.source.lifecycle_revision)).toBe(
      Number(before.source.lifecycle_revision) + 1,
    );
    expect(after.projection.plan_key).toBe("pro_monthly");
    expect(after.projection.source_subscription_revision).toBe(after.source.lifecycle_revision);
    expect(after.allowance).toEqual(before.allowance);
    expect(after.periods).toEqual(before.periods);
    const replay = await f.finalize({
      ...f.input,
      rawCurrentSchedule: null,
      rawSubscription: null,
      rawCustomer: null,
    });
    expect(replay.replayed).toBeTrue();
    expect((await state(f)).source).toEqual(after.source);
    await expect(
      db.query(
        "UPDATE billing_subscription_commands SET organization_schedule_configuration_evidence=NULL WHERE id=$1",
        [f.identity.commandId],
      ),
    ).rejects.toThrow("immutable");
  });
  test("management offers configured cancellation only from original published schedule proof", async () => {
    const f = await configured();
    await f.finalize(f.input);
    const { dbWrite } = await import("../helpers");
    const { readPrimaryOrganizationSubscription } = await import(
      "./account-billing-snapshot-subscription"
    );
    const { buildOrganizationSubscriptionSnapshot } = await import(
      "../../lib/services/account-subscription-snapshot"
    );
    const primary = await dbWrite.transaction(
      (tx) => readPrimaryOrganizationSubscription(tx, f.identity.organizationId),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    expect(primary.state).toBe("current");
    if (primary.state !== "current") throw new Error("Expected published authority");
    expect(primary.configuredCancellation).toBe(true);
    const reader = {
      authMethod: "session" as const,
      role: "owner",
      userActive: true,
      userAnonymous: false,
      organizationActive: true,
    };
    const observed = new Date().toISOString();
    const funding = { status: "unavailable" as const, code: "test_not_spendable" };
    const view = buildOrganizationSubscriptionSnapshot(primary, observed, funding, reader);
    expect(view.status).toBe("available");
    if (view.status !== "available") throw new Error("Expected projected authority");
    expect(view.value.planKey).toBe("pro_monthly");
    expect(view.value.pendingPlanKey).toBe("plus_monthly");
    expect(view.value.cancellationControl).toMatchObject({
      eligible: true,
      blockers: [],
      action: "cancel",
    });
    const denied = buildOrganizationSubscriptionSnapshot(primary, observed, funding, {
      ...reader,
      role: "member",
    });
    if (denied.status !== "available") throw new Error("Expected member projection");
    expect(denied.value.cancellationControl.eligible).toBe(false);
    expect(denied.value.cancellationControl.blockers).toContain("owner_or_admin_role_required");
    const unproven = buildOrganizationSubscriptionSnapshot(
      { ...primary, configuredCancellation: false },
      observed,
      funding,
      reader,
    );
    if (unproven.status !== "available") throw new Error("Expected unproven projection");
    expect(unproven.value.cancellationControl.blockers).toContain("subscription_state_unsupported");
    // No provider call or command mutation is used to project management authority.
    expect((await state(f)).command.status).toBe("APPLIED");
  });
  for (const lostResponse of [false, true])
    test(`configured cancellation preserves paid phase and recovers without redispatch: lost=${lostResponse}`, async () => {
      process.env.STRIPE_SECRET_KEY = ["sk", "test", "schedulepublication"].join("_");
      process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
      process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
      process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
      process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
      const f = await configured();
      await f.finalize(f.input);
      const before = await state(f);
      let schedule = structuredClone(f.input.rawCurrentSchedule);
      let subscription = structuredClone(f.input.rawSubscription);
      let writes = 0;
      const requests: unknown[] = [];
      const previews: unknown[] = [];
      const provider = {
        invoices: {
          createPreview: async (params: unknown) => {
            previews.push(params);
            return {
              id: "upcoming_in_configured",
              object: "invoice",
              status: "draft",
              livemode: false,
              customer: subscription.customer,
              subscription: subscription.id,
              currency: "usd",
              collection_method: "charge_automatically",
              on_behalf_of: null,
              transfer_data: null,
              application_fee_amount: null,
              automatic_tax: { enabled: false, status: null },
              amount_due: 10000,
              subtotal: 10000,
              total: 10000,
              tax: null,
              starting_balance: 0,
              total_discount_amounts: [],
              total_tax_amounts: [],
              lines: {
                has_more: false,
                data: [
                  {
                    type: "subscription",
                    subscription: subscription.id,
                    subscription_item: subscription.items.data[0]!.id,
                    proration: false,
                    currency: "usd",
                    quantity: 1,
                    amount: 10000,
                    price: { id: "price_pro" },
                    period: {
                      start: subscription.current_period_end,
                      end: subscription.current_period_end + 30 * 86400,
                    },
                  },
                ],
              },
            };
          },
        },
        customers: { retrieve: async () => f.rawCustomer },
        subscriptions: {
          retrieve: async () => subscription,
          update: async () => {
            throw Error("Subscription update forbidden for a schedule");
          },
        },
        subscriptionSchedules: {
          retrieve: async () => schedule,
          update: async (
            _id: string,
            params: { end_behavior: string; phases: unknown[] },
            options: { idempotencyKey: string },
          ) => {
            writes++;
            requests.push({ params, options });
            schedule = {
              ...schedule,
              end_behavior: params.end_behavior,
              phases: [schedule.phases[0]!],
            };
            subscription = {
              ...subscription,
              cancel_at: params.end_behavior === "cancel" ? subscription.current_period_end : null,
              cancel_at_period_end: false,
            };
            if (lostResponse) throw Error("Lost accepted response");
            return schedule;
          },
        },
      };
      const { startScheduleWireFixture } = await import(
        "./test-support/subscription-schedule-wire-test-fixture"
      );
      const wire = await startScheduleWireFixture(async (request) => {
        if (request.apiVersion !== "2024-11-20.acacia") throw Error("Wrong API contract");
        if (request.method === "GET" && request.path === `/v1/customers/${subscription.customer}`)
          return provider.customers.retrieve();
        if (request.method === "GET" && request.path === `/v1/subscriptions/${subscription.id}`)
          return provider.subscriptions.retrieve();
        if (
          request.method === "GET" &&
          request.path === `/v1/subscription_schedules/${schedule.id}`
        )
          return provider.subscriptionSchedules.retrieve();
        if (request.method === "POST" && request.path === "/v1/invoices/create_preview")
          return provider.invoices.createPreview(Object.fromEntries(request.body));
        if (
          request.method === "POST" &&
          request.path === `/v1/subscription_schedules/${schedule.id}`
        )
          return provider.subscriptionSchedules.update(
            schedule.id,
            { end_behavior: request.body.get("end_behavior")!, phases: [] },
            { idempotencyKey: request.idempotencyKey! },
          );
        throw Error("Unexpected wire request");
      });
      stripeMock = wire.stripe;
      try {
        const {
          submitOrganizationSubscriptionCancellation: submit,
          recoverOrganizationSubscriptionCancellations: recover,
        } = await import("../../lib/services/subscription-cancellation");
        const input = {
          ...f.identity,
          subscriptionId: before.source.id,
          expectedSubscriptionRevision: Number(before.source.lifecycle_revision),
          idempotencyKey: randomUUID(),
        };
        const result = await submit(input, async () => {});
        expect(result.status).toBe(lostResponse ? "OUTCOME_UNKNOWN" : "APPLIED");
        if (lostResponse) {
          expect((await state(f)).source.pending_plan_key).toBe("plus_monthly");
          const recovered = await recover(100);
          expect(recovered.applied).toBeGreaterThanOrEqual(1);
        }
        async function reconcileActiveSchedule(expected: "ok" | "degraded" = "ok") {
          await db.query(
            `INSERT INTO subscription_reconciliation_scans (organization_id,subscription_id,next_due_at)
          SELECT organization_id,id,CASE WHEN id=$1 THEN clock_timestamp() ELSE clock_timestamp()+interval '1 hour' END FROM billing_subscriptions
          ON CONFLICT (organization_id,subscription_id) DO UPDATE SET next_due_at=EXCLUDED.next_due_at`,
            [before.source.id],
          );
          const snapshot = await state(f),
            requestCount = wire.requests.length;
          const { recoverMissedSubscriptionEvents } = await import(
            "../../lib/services/subscription-reconciliation"
          );
          const result = await recoverMissedSubscriptionEvents();
          expect(result.status).toBe(expected);
          expect(result.attempts).toHaveLength(1);
          expect(result.attempts[0]?.disposition).toBe(
            expected === "ok" ? "no_change" : "unavailable",
          );
          expect(await state(f)).toEqual(snapshot);
          expect(wire.requests.slice(requestCount).every((r) => r.method === "GET")).toBeTrue();
        }
        await reconcileActiveSchedule();
        const after = await state(f);
        expect(writes).toBe(1);
        expect(after.source.pending_plan_key).toBeNull();
        expect(after.source.cancel_at_period_end).toBeTrue();
        expect(after.source.plan_key).toBe(before.source.plan_key);
        expect(after.source.current_period_end).toEqual(before.source.current_period_end);
        expect(after.allowance).toEqual(before.allowance);
        expect(after.periods).toEqual(before.periods);
        expect((await submit(input, async () => {})).status).toBe("APPLIED");
        expect(writes).toBe(1);
        const { readCancellationUndoReviewSource } = await import("./subscription-cancellation");
        const undo = await readCancellationUndoReviewSource({
          ...input,
          expectedSubscriptionRevision: Number(after.source.lifecycle_revision),
        });
        expect(undo.configuredCancellation?.originalPending).toBeFalse();
        expect(undo.configuredCancellation?.scheduleId).toBe(schedule.id);
        expect(requests).toHaveLength(1);
        const { readOrganizationSubscriptionRenewalReview } = await import(
          "../../lib/services/subscription-renewal-review"
        );
        const {
          submitReviewedOrganizationSubscriptionCancellationUndo,
          submitOrganizationSubscriptionCancellationUndo,
        } = await import("../../lib/services/subscription-cancellation");
        const undoInput = {
          ...input,
          idempotencyKey: randomUUID(),
          expectedSubscriptionRevision: Number(after.source.lifecycle_revision),
        };
        await expect(
          submitOrganizationSubscriptionCancellationUndo(undoInput, async () => {}),
        ).rejects.toThrow();
        const review = await readOrganizationSubscriptionRenewalReview(undoInput, async () => {});
        expect(review.baseAmountCents).toBe(10000);
        expect(previews[0]).toMatchObject({
          schedule: schedule.id,
          preview_mode: "next",
          "schedule_details[end_behavior]": "release",
          "schedule_details[proration_behavior]": "none",
        });
        expect(previews[0]).not.toHaveProperty("subscription_details");
        const resumed = await submitReviewedOrganizationSubscriptionCancellationUndo(
          { ...undoInput, expectedRenewalTermsDigest: review.termsDigest },
          async () => {},
        );
        expect(resumed.status).toBe(lostResponse ? "OUTCOME_UNKNOWN" : "APPLIED");
        if (lostResponse) expect((await recover(100)).applied).toBeGreaterThanOrEqual(1);
        const final = await state(f);
        expect(final.source.cancel_at_period_end).toBeFalse();
        expect(final.source.pending_plan_key).toBeNull();
        expect(final.source.plan_key).toBe("pro_monthly");
        expect(final.allowance).toEqual(before.allowance);
        expect(writes).toBe(2);
        expect(schedule.phases).toHaveLength(1);
        const { reconcileStripeScheduledCancellationLifecycle } = await import(
          "../../lib/services/stripe-scheduled-cancellation-lifecycle"
        );
        const event = {
          id: `evt_${randomUUID().replaceAll("-", "")}`,
          type: "customer.subscription.updated",
          created: Math.floor(Date.now() / 1000),
          livemode: false,
          data: { object: subscription },
        };
        await reconcileStripeScheduledCancellationLifecycle({
          kind: "stripe.event",
          receivedAt: Date.now(),
          eventId: event.id,
          eventType: event.type,
          event: event as unknown as import("stripe").default.Event,
        });
        expect((await state(f)).source.cancel_at_period_end).toBeFalse();
        expect(writes).toBe(2);
        await reconcileActiveSchedule();
        const supportedSchedule = structuredClone(schedule);
        schedule.phases[0]!.items[0]!.price = "price_outofband";
        await reconcileActiveSchedule("degraded");
        schedule = supportedSchedule;
        const mutations = wire.requests.filter(
          (r) => r.method === "POST" && r.path.startsWith("/v1/subscription_schedules/"),
        );
        expect(mutations).toHaveLength(2);
        expect(mutations.map((r) => r.body.get("end_behavior"))).toEqual(["cancel", "release"]);
        expect(new Set(mutations.map((r) => r.idempotencyKey)).size).toBe(2);
        for (const request of mutations) {
          expect(request.idempotencyKey).toMatch(/^organization-cancellation:/);
          expect(request.body.get("proration_behavior")).toBe("none");
          expect(request.body.get("phases[0][items][0][price]")).toBe("price_pro");
          expect(request.body.get("phases[0][start_date]")).toBe(
            String(subscription.current_period_start),
          );
          expect(request.body.get("phases[0][end_date]")).toBe(
            String(subscription.current_period_end),
          );
          expect([...request.body.keys()].some((key) => key.startsWith("phases[1]"))).toBeFalse();
        }
        expect(
          wire.requests.some((r) => r.method === "POST" && r.path.startsWith("/v1/subscriptions/")),
        ).toBeFalse();
        const current = await state(f);
        const cancelAgain = await submit(
          {
            ...input,
            expectedSubscriptionRevision: Number(current.source.lifecycle_revision),
            idempotencyKey: randomUUID(),
          },
          async () => {},
        );
        expect(cancelAgain.status).toBe(lostResponse ? "OUTCOME_UNKNOWN" : "APPLIED");
        if (lostResponse) expect((await recover(100)).applied).toBeGreaterThanOrEqual(1);
        expect(writes).toBe(3);
        Object.assign(subscription, {
          status: "canceled",
          schedule: null,
          ended_at: subscription.current_period_end,
          canceled_at: subscription.current_period_end,
        });
        await db.query("UPDATE fixture_clock SET offset_seconds=$1", [
          subscription.current_period_end - Math.floor(Date.now() / 1000) + 1,
        ]);
        await db.query(
          `INSERT INTO subscription_reconciliation_scans (organization_id,subscription_id,next_due_at)
        SELECT organization_id,id,CASE WHEN id=$1 THEN clock_timestamp() ELSE clock_timestamp()+interval '1 hour' END FROM billing_subscriptions
        ON CONFLICT (organization_id,subscription_id) DO UPDATE SET next_due_at=EXCLUDED.next_due_at`,
          [before.source.id],
        );
        const { recoverMissedSubscriptionEvents } = await import(
          "../../lib/services/subscription-reconciliation"
        );
        const terminal = await recoverMissedSubscriptionEvents();
        expect(terminal.status).toBe("ok");
        expect(terminal.attempts).toHaveLength(1);
        expect(terminal.attempts[0]?.disposition).toBe("applied");
        const ended = await state(f);
        expect(ended.source.status).toBe("canceled");
        expect(ended.source.pending_plan_key).toBeNull();
        expect(ended.projection.plan_key).toBe("free");
        expect(ended.allowance).toEqual(before.allowance);
        expect(writes).toBe(3);
        expect((await recoverMissedSubscriptionEvents()).attempts).toHaveLength(0);
      } finally {
        await db.query("UPDATE fixture_clock SET offset_seconds=0");
        await wire.close();
      }
    });
  test("ordinary cancellation disables SDK write retries and leaves recovery to its original command", async () => {
    process.env.STRIPE_SECRET_KEY = ["sk", "test", "ordinarywire"].join("_");
    process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
    process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
    const { seedCancellationTestAccount } = await import(
      "./subscription-cancellation-test-fixture"
    );
    const f = await seedCancellationTestAccount((q, v) => db.query(q, v));
    const { startScheduleWireFixture } = await import(
      "./test-support/subscription-schedule-wire-test-fixture"
    );
    let raw = structuredClone(f.provider),
      writes = 0;
    const wire = await startScheduleWireFixture(async (request) => {
      if (request.method === "GET" && request.path === `/v1/customers/${raw.customer}`)
        return { id: raw.customer, object: "customer", livemode: false };
      if (request.method === "GET" && request.path === `/v1/subscriptions/${raw.id}`) return raw;
      if (request.method === "POST" && request.path === `/v1/subscriptions/${raw.id}`) {
        writes++;
        expect(request.body.get("cancel_at_period_end")).toBe("true");
        Object.assign(raw, {
          cancel_at_period_end: true,
          cancel_at: raw.current_period_end,
          canceled_at: Math.floor(Date.now() / 1000),
        });
        throw Error("Lost accepted cancellation response");
      }
      throw Error("Unexpected wire request");
    });
    stripeMock = wire.stripe;
    try {
      const service = await import("../../lib/services/subscription-cancellation");
      const command = await service.submitOrganizationSubscriptionCancellation(
        f.input,
        async () => {},
      );
      expect(command.status).toBe("OUTCOME_UNKNOWN");
      expect(writes).toBe(1);
      expect(
        (await service.recoverOrganizationSubscriptionCancellations(100)).applied,
      ).toBeGreaterThanOrEqual(1);
      expect(
        (
          await service.readOrganizationSubscriptionCancellation({
            ...f.input,
            commandId: command.commandId,
          })
        ).status,
      ).toBe("APPLIED");
      expect(writes).toBe(1);
      const calls = wire.requests.filter((request) => request.method === "POST");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.idempotencyKey).toMatch(/^organization-cancellation:/);
      expect(calls[0]!.apiVersion).toBe("2024-11-20.acacia");
    } finally {
      await wire.close();
    }
  });
  test("original snapshot cannot be removed or replaced after publication", async () => {
    const f = await configured();
    await f.finalize(f.input);
    const before = await state(f);
    for (const replacement of [
      null,
      {},
      { ...f.input.rawCurrentSchedule, customer: "cus_other" },
    ]) {
      await expect(
        db.query(
          "UPDATE billing_subscription_commands SET organization_schedule_configuration_snapshot=$2::jsonb WHERE id=$1",
          [f.identity.commandId, replacement === null ? null : JSON.stringify(replacement)],
        ),
      ).rejects.toThrow("immutable");
      expect(await state(f)).toEqual(before);
    }
  });
  test("snapshot cannot be attached before original configured publication", async () => {
    const f = await configured();
    const before = await state(f);
    await expect(
      db.query(
        "UPDATE billing_subscription_commands SET organization_schedule_configuration_snapshot=$2::jsonb WHERE id=$1",
        [f.identity.commandId, JSON.stringify(f.input.rawCurrentSchedule)],
      ),
    ).rejects.toThrow("requires original publication");
    expect(await state(f)).toEqual(before);
  });
  for (const [name, expression, message] of [
    ["missing", "NULL", "requires its original snapshot"],
    [
      "foreign customer",
      "jsonb_set(NEW.organization_schedule_configuration_snapshot,'{customer}','\"cus_other\"')",
      "requires original schedule scope",
    ],
    [
      "foreign target",
      "jsonb_set(NEW.organization_schedule_configuration_snapshot,'{phases,1,items,0,price}','\"price_other\"')",
      "requires original schedule scope",
    ],
  ] as const)
    test(`database rejects ${name} snapshot and rolls back pending publication`, async () => {
      const f = await configured();
      const before = await state(f);
      await db.query(`CREATE FUNCTION corrupt_snapshot_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.organization_schedule_configuration_evidence IS NOT NULL THEN
        NEW.organization_schedule_configuration_snapshot=${expression};
      END IF; RETURN NEW; END; $$;
      CREATE TRIGGER aaa_corrupt_snapshot_fixture BEFORE UPDATE ON billing_subscription_commands
      FOR EACH ROW EXECUTE FUNCTION corrupt_snapshot_fixture()`);
      try {
        await expect(f.finalize(f.input)).rejects.toMatchObject({
          cause: { code: "23514", message: expect.stringContaining(message) },
        });
        expect(await state(f)).toEqual(before);
      } finally {
        await db.query(
          "DROP TRIGGER aaa_corrupt_snapshot_fixture ON billing_subscription_commands; DROP FUNCTION corrupt_snapshot_fixture()",
        );
      }
      expect((await f.finalize(f.input)).command.status).toBe("APPLIED");
    });
  test("changed provider configuration retains original uncertainty and paid state", async () => {
    const f = await configured();
    const before = await state(f);
    f.input.rawCurrentSchedule.phases[1]!.items[0]!.price = "price_other";
    await expect(f.finalize(f.input)).rejects.toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_SCHEDULE_CONFIGURATION_UNVERIFIED" }),
    );
    expect(await state(f)).toEqual(before);
  });
  test("expired lease cannot publish pending state", async () => {
    const f = await configured();
    await db.query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.identity.commandId],
    );
    const before = await state(f);
    await expect(f.finalize(f.input)).rejects.toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" }),
    );
    expect(await state(f)).toEqual(before);
  });
  test("foreign original actor cannot settle the command", async () => {
    const f = await configured();
    const before = await state(f);
    await expect(f.finalize({ ...f.input, actorId: randomUUID() })).rejects.toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" }),
    );
    expect(await state(f)).toEqual(before);
  });
  test("organization fencing blocks pending-plan publication", async () => {
    const f = await configured();
    await db.query("UPDATE organizations SET paid_work_fenced_at=clock_timestamp() WHERE id=$1", [
      f.identity.organizationId,
    ]);
    const before = await state(f);
    await expect(f.finalize(f.input)).rejects.toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN" }),
    );
    expect(await state(f)).toEqual(before);
  });
  test("terminal write rollback also rolls back source and projection and supports retry", async () => {
    const f = await configured();
    const before = await state(f);
    await db.query(
      "CREATE FUNCTION reject_configured_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='downgrade' AND NEW.status='APPLIED' THEN RAISE EXCEPTION 'fixture final write rejected'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_configured_fixture BEFORE UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION reject_configured_fixture();",
    );
    try {
      await expect(f.finalize(f.input)).rejects.toMatchObject({
        cause: expect.objectContaining({ message: "fixture final write rejected" }),
      });
      expect(await state(f)).toEqual(before);
    } finally {
      await db.query(
        "DROP TRIGGER reject_configured_fixture ON billing_subscription_commands; DROP FUNCTION reject_configured_fixture()",
      );
    }
    expect((await f.finalize(f.input)).command.status).toBe("APPLIED");
  });
  test("original read-only settlement survives manager revocation", async () => {
    const f = await configured();
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
    expect((await f.finalize(f.input)).command.status).toBe("APPLIED");
  });
  test("current source drift cannot be overwritten by the original configured result", async () => {
    const f = await configured();
    await db.query("UPDATE billing_subscriptions SET provider_object_digest=$2 WHERE id=$1", [
      f.captured.source.id,
      "e".repeat(64),
    ]);
    const before = await state(f);
    await expect(f.finalize(f.input)).rejects.toMatchObject({
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
    expect(await state(f)).toEqual(before);
  });
  for (const lockTarget of ["organization", "association"] as const)
    test(`lease expiry while finalization waits for ${lockTarget} cannot commit stale pending state`, async () => {
      const f = await configured();
      const blocker = new Client({ connectionString: url });
      await blocker.connect();
      await blocker.query(`SET search_path TO ${schema},public`);
      await blocker.query("BEGIN");
      const blockerId = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query(
        lockTarget === "organization"
          ? "SELECT id FROM organizations WHERE id=$1 FOR UPDATE"
          : "SELECT organization_id FROM organization_subscription_authorities WHERE organization_id=$1 FOR UPDATE",
        [f.identity.organizationId],
      );
      const pending = f.finalize(f.input).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      try {
        let blocked = false;
        for (let i = 0; i < 400; i++) {
          blocked = (
            await db.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked",
              [blockerId],
            )
          ).rows[0].blocked;
          if (blocked) break;
          await Bun.sleep(25);
        }
        expect(blocked).toBe(true);
        await db.query("SET lock_timeout='1s'");
        await db.query(
          "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [f.identity.commandId],
        );
      } finally {
        await blocker.query("COMMIT");
        await blocker.end();
        await db.query("SET lock_timeout='0'");
      }
      const result = await pending;
      expect(result.error).toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" });
      expect(
        (
          await db.query(
            "SELECT status,organization_schedule_configuration_evidence AS evidence FROM billing_subscription_commands WHERE id=$1",
            [f.identity.commandId],
          )
        ).rows[0],
      ).toEqual({ status: "OUTCOME_UNKNOWN", evidence: null });
    }, 30000);
  function providerFor(f: Awaited<ReturnType<typeof configured>>, events: unknown[]) {
    const calls: string[] = [];
    const noWrite = () => {
      throw new Error("Unexpected provider mutation during recovery");
    };
    stripeMock = {
      events: {
        list: async () => {
          calls.push("events");
          return { object: "list", data: events, has_more: false };
        },
      },
      customers: {
        retrieve: async () => {
          calls.push("customer");
          return f.input.rawCustomer;
        },
      },
      subscriptions: {
        retrieve: async () => {
          calls.push("subscription");
          return f.input.rawSubscription;
        },
      },
      subscriptionSchedules: {
        retrieve: async () => {
          calls.push("schedule");
          return f.input.rawCurrentSchedule;
        },
        create: noWrite,
        update: noWrite,
        release: noWrite,
      },
    };
    return calls;
  }
  function originalEvents(f: Awaited<ReturnType<typeof configured>>) {
    return [
      {
        id: "evt_originalCreate",
        type: "subscription_schedule.created",
        raw: f.rawCreate,
        key: f.createKey,
        requestId: "req_create",
        created: f.rawCreate.created,
      },
      {
        id: "evt_originalConfigure",
        type: "subscription_schedule.updated",
        raw: f.input.rawCurrentSchedule,
        key: f.configurationEffect.provider_idempotency_key,
        requestId: "req_configured",
        created: f.configurationEffect.started_at
          ? Math.floor(f.configurationEffect.started_at.getTime() / 1000)
          : null,
      },
    ]
      .filter((e) => e.created !== null)
      .map((e) => ({
        id: e.id,
        object: "event",
        type: e.type,
        livemode: false,
        api_version: "2024-11-20.acacia",
        created: e.created,
        request: { id: e.requestId, idempotency_key: e.key },
        data: { object: structuredClone(e.raw) },
      }));
  }
  async function publication() {
    return (await import("../../lib/services/organization-schedule-publication"))
      .observeAndFinalizeOrganizationScheduleConfiguration;
  }
  for (const providerStatus of ["active", "past_due", "unpaid"] as const)
    for (const terminal of [false, true])
      test(`late configuration recovery retains original snapshot and unpaid boundary: ${providerStatus}/${terminal}`, async () => {
        const f = await configured(false);
        const originalSnapshot = structuredClone(f.input.rawCurrentSchedule);
        const events = originalEvents(f),
          target = originalSnapshot.phases[1]!;
        const now = terminal ? target.end_date! + 100 : target.start_date + 100;
        const before = await state(f);
        await db.query("UPDATE fixture_clock SET offset_seconds=$1", [now - Date.now() / 1000]);
        try {
          const reclaim = await repo.claimOrganizationSchedule(f.identity);
          if (!reclaim) throw new Error("Late recovery lease missing");
          f.input.rawCurrentSchedule = structuredClone(originalSnapshot);
          if (terminal) {
            for (const [key, value] of Object.entries({
              status: "completed",
              current_phase: null,
              subscription: null,
              completed_at: target.end_date,
            }))
              Reflect.set(f.input.rawCurrentSchedule, key, value);
          } else
            f.input.rawCurrentSchedule.current_phase = {
              start_date: target.start_date,
              end_date: target.end_date!,
            };
          const item = f.input.rawSubscription.items.data[0]!;
          item.id = "si_late";
          item.price.id = f.providerBinding.targetPriceId;
          item.price.product = f.providerBinding.targetProductId;
          item.price.unit_amount = 3000;
          f.input.rawSubscription = {
            ...f.input.rawSubscription,
            status: providerStatus,
            latest_invoice: "in_late",
            schedule: terminal ? null : originalSnapshot.id,
            current_period_start: terminal ? target.end_date! : target.start_date,
            current_period_end: terminal ? target.end_date! + 2592000 : target.end_date!,
          } as typeof f.input.rawSubscription;
          const calls = providerFor(f, events);
          // A foreign current customer cannot turn historical evidence into pending authority.
          const customer = f.input.rawCustomer.id;
          f.input.rawCustomer.id = "cus_foreign";
          await expect((await publication())(f.identity, reclaim.claim)).rejects.toThrow();
          expect((await state(f)).source).toEqual(before.source);
          f.input.rawCustomer.id = customer;
          const result = await (await publication())(f.identity, reclaim.claim);
          expect(result.command.status).toBe("APPLIED");
          expect(calls).toContain("schedule");
          const after = await state(f);
          expect(after.command.organization_schedule_configuration_snapshot).toEqual(
            originalSnapshot,
          );
          expect(after.source.pending_plan_key).toBe("plus_monthly");
          expect(after.source.plan_key).toBe(before.source.plan_key);
          expect(after.source.current_period_start).toEqual(before.source.current_period_start);
          expect(after.source.current_period_end).toEqual(before.source.current_period_end);
          expect(after.projection.effective_until).toEqual(before.source.current_period_end);
          expect(after.projection.effective_until.getTime()).toBeLessThan(now * 1000);
          expect(after.allowance).toEqual(before.allowance);
          expect(after.periods).toEqual(before.periods);
          calls.length = 0;
          expect((await (await publication())(f.identity, reclaim.claim)).replayed).toBeTrue();
          expect(calls).toEqual([]);
          expect(await state(f)).toEqual(after);
        } finally {
          await db.query("UPDATE fixture_clock SET offset_seconds=0");
        }
      });
  test("direct publication uses fresh provider reads and no additional financial write", async () => {
    const f = await configured();
    const calls = providerFor(f, []);
    expect(
      (
        await (
          await publication()
        )(f.identity, f.claim, {
          create: f.input.createEvidence,
          configuration: f.input.configurationEvidence,
        })
      ).command.status,
    ).toBe("APPLIED");
    expect(calls).toEqual(["customer", "subscription", "schedule"]);
    const after = await state(f);
    expect(after.source.pending_plan_key).toBe("plus_monthly");
    calls.length = 0;
    expect((await (await publication())(f.identity, f.claim)).replayed).toBeTrue();
    expect(calls).toEqual([]);
  });
  test("lost configure response recovers original events and stores one original receipt", async () => {
    const f = await configured(false);
    const calls = providerFor(f, originalEvents(f));
    const before = await state(f);
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
    expect((await (await publication())(f.identity, f.claim)).command.status).toBe("APPLIED");
    expect(calls).toEqual(["events", "events", "customer", "subscription", "schedule"]);
    const effect = (
      await db.query("SELECT state,receipt FROM organization_schedule_effects WHERE id=$1", [
        f.configurationEffect.id,
      ])
    ).rows[0];
    expect(effect.state).toBe("observed");
    expect(effect.receipt.kind).toBe("event");
    const after = await state(f);
    expect(after.allowance).toEqual(before.allowance);
    expect(after.periods).toEqual(before.periods);
  });
  test("original response receipt survives supplemental configuration event recovery", async () => {
    const f = await configured();
    providerFor(f, originalEvents(f));
    const before = (
      await db.query(
        "SELECT receipt,receipt_digest FROM organization_schedule_effects WHERE id=$1",
        [f.configurationEffect.id],
      )
    ).rows;
    expect((await (await publication())(f.identity, f.claim)).command.status).toBe("APPLIED");
    expect(
      (
        await db.query(
          "SELECT receipt,receipt_digest FROM organization_schedule_effects WHERE id=$1",
          [f.configurationEffect.id],
        )
      ).rows,
    ).toEqual(before);
  });
  test("missing event history never retires or replays uncertain configuration", async () => {
    const f = await configured(false);
    const calls = providerFor(f, []);
    const before = await state(f);
    await expect((await publication())(f.identity, f.claim)).rejects.toMatchObject({
      code: "SUBSCRIPTION_SCHEDULE_RECOVERY_UNAVAILABLE",
    });
    expect(calls).toEqual(["events"]);
    expect(await state(f)).toEqual(before);
    expect(
      (
        await db.query("SELECT state FROM organization_schedule_effects WHERE id=$1", [
          f.configurationEffect.id,
        ])
      ).rows[0].state,
    ).toBe("started");
  });
  test("later schedule drift retains recovered receipt but cannot publish a pending plan", async () => {
    const f = await configured(false);
    const events = originalEvents(f);
    f.input.rawCurrentSchedule.phases[1]!.items[0]!.price = "price_foreign";
    providerFor(f, events);
    const before = await state(f);
    await expect((await publication())(f.identity, f.claim)).rejects.toMatchObject({
      code: "SUBSCRIPTION_SCHEDULE_CONFIGURATION_UNVERIFIED",
    });
    expect(await state(f)).toEqual(before);
    expect(
      (
        await db.query("SELECT state FROM organization_schedule_effects WHERE id=$1", [
          f.configurationEffect.id,
        ])
      ).rows[0].state,
    ).toBe("observed");
  });
  test("lease lost during fresh observation retains evidence without stale publication", async () => {
    const f = await configured(false);
    providerFor(f, originalEvents(f));
    (stripeMock as { customers: unknown }).customers = {
      retrieve: async () => {
        await db.query(
          "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [f.identity.commandId],
        );
        return f.input.rawCustomer;
      },
    };
    await expect((await publication())(f.identity, f.claim)).rejects.toMatchObject({
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
    const after = await state(f);
    expect(after.source.pending_plan_key).toBeNull();
    expect(after.command.status).toBe("OUTCOME_UNKNOWN");
    expect(
      (
        await db.query("SELECT state FROM organization_schedule_effects WHERE id=$1", [
          f.configurationEffect.id,
        ])
      ).rows[0].state,
    ).toBe("observed");
  });
  function recurringInvoice(f: Pick<Awaited<ReturnType<typeof configured>>, "source">) {
    const start = Math.floor(f.source.current_period_end.getTime() / 1000);
    return {
      id: "upcoming_in_lower",
      object: "invoice",
      status: "draft",
      livemode: false,
      customer: f.source.stripe_customer_id,
      subscription: f.source.stripe_subscription_id,
      currency: "usd",
      charge: null,
      payment_intent: null,
      paid: false,
      paid_out_of_band: false,
      amount_paid: 0,
      amount_due: 3000,
      amount_remaining: 0,
      billing_reason: "subscription_cycle",
      subtotal: 3000,
      subtotal_excluding_tax: 3000,
      total: 3000,
      tax: 0,
      total_discount_amounts: [],
      total_tax_amounts: [],
      starting_balance: 0,
      period_start: start,
      period_end: start + 30 * 86400,
      hosted_invoice_url: null,
      collection_method: "charge_automatically",
      on_behalf_of: null,
      transfer_data: null,
      application_fee_amount: null,
      automatic_tax: { enabled: false, status: null },
      lines: {
        has_more: false,
        data: [
          {
            id: "il_lower",
            type: "subscription",
            subscription: f.source.stripe_subscription_id,
            subscription_item: f.source.stripe_subscription_item_id,
            price: { id: "price_plus" },
            quantity: 1,
            currency: "usd",
            amount: 3000,
            discount_amounts: [],
            tax_amounts: [],
            period: { start, end: start + 30 * 86400 },
            proration: false,
          },
        ],
      },
    };
  }
  function installTestCatalog(stripe: Record<string, unknown>) {
    stripe.prices = {
      retrieve: async (id: string) => ({
        id,
        active: true,
        currency: "usd",
        currency_options: {},
        unit_amount: id === "price_plus" ? 3000 : 10000,
        type: "recurring",
        billing_scheme: "per_unit",
        transform_quantity: null,
        recurring: {
          interval: "month",
          interval_count: 1,
          trial_period_days: null,
          usage_type: "licensed",
        },
        product: id === "price_plus" ? "prod_plus" : "prod_pro",
        livemode: false,
      }),
    };
    stripe.products = { retrieve: async (id: string) => ({ id, active: true, livemode: false }) };
  }
  function dispatchProvider(f: Awaited<ReturnType<typeof configured>>, loseResponse = false) {
    process.env.STRIPE_SECRET_KEY = ["sk", "test", "schedulepublication"].join("_");
    process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
    process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
    process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
    let updated = false,
      updates = 0;
    const calls = providerFor(f, []);
    const stripe = stripeMock as Record<string, unknown>;
    installTestCatalog(stripe);
    stripe.invoices = {
      createPreview: async (request: unknown) => {
        expect(request).toEqual({
          customer: f.source.stripe_customer_id,
          schedule: f.rawCreate.id,
          preview_mode: "recurring",
          schedule_details:
            f.configurationEffect.request_payload.kind === "schedule_configure"
              ? f.configurationEffect.request_payload.params
              : null,
        });
        return recurringInvoice(f);
      },
    };
    stripe.subscriptionSchedules = {
      retrieve: async () => (updated ? f.input.rawCurrentSchedule : f.rawCreate),
      update: async (id: string, params: unknown, options: unknown) => {
        updates++;
        expect(id).toBe(f.rawCreate.id);
        expect(options).toEqual({
          apiVersion: "2024-11-20.acacia",
          idempotencyKey: f.configurationEffect.provider_idempotency_key,
          maxNetworkRetries: 0,
        });
        expect(params).toEqual(
          f.configurationEffect.request_payload.kind === "schedule_configure"
            ? f.configurationEffect.request_payload.params
            : null,
        );
        updated = true;
        if (loseResponse) throw new Error("lost original configure response");
        return f.transport(
          structuredClone(f.input.rawCurrentSchedule),
          "req_configured",
          f.configurationEffect.provider_idempotency_key,
        );
      },
    };
    return { calls, updates: () => updates, stripe };
  }
  test("one-shot dispatcher persists original receipt then atomically publishes through fresh reads", async () => {
    const f = await configured(false, false);
    const provider = dispatchProvider(f);
    const before = await state(f);
    const { dispatchOrganizationScheduleConfiguration } = await import(
      "../../lib/services/organization-schedule-configuration"
    );
    const result = await dispatchOrganizationScheduleConfiguration(
      f.identity,
      f.claim,
      f.configurationEffect.id,
      async () => {},
      f.input.createEvidence,
    );
    expect(result.resolution.command.status).toBe("APPLIED");
    expect(provider.updates()).toBe(1);
    const after = await state(f);
    expect(after.source.plan_key).toBe("pro_monthly");
    expect(after.source.pending_plan_key).toBe("plus_monthly");
    expect(after.allowance).toEqual(before.allowance);
  });
  test("actual dispatch lost response reconciles original event without a second update", async () => {
    const f = await configured(false, false);
    const provider = dispatchProvider(f, true);
    const { dispatchOrganizationScheduleConfiguration } = await import(
      "../../lib/services/organization-schedule-configuration"
    );
    await expect(
      dispatchOrganizationScheduleConfiguration(
        f.identity,
        f.claim,
        f.configurationEffect.id,
        async () => {},
        f.input.createEvidence,
      ),
    ).rejects.toThrow("lost original configure response");
    const effect = (
      await db.query("SELECT * FROM organization_schedule_effects WHERE id=$1", [
        f.configurationEffect.id,
      ])
    ).rows[0];
    expect(effect.state).toBe("started");
    f.configurationEffect = effect;
    provider.stripe.events = {
      list: async () => ({ object: "list", has_more: false, data: originalEvents(f) }),
    };
    expect((await (await publication())(f.identity, f.claim)).command.status).toBe("APPLIED");
    expect(provider.updates()).toBe(1);
  });
  test("interactive original confirmation creates and configures through real journal ownership", async () => {
    const f = await providerCreated(undefined, false);
    await repo.finishOrganizationScheduleAttempt(f.identity, f.claim);
    process.env.STRIPE_SECRET_KEY = ["sk", "test", "schedulepublication"].join("_");
    process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
    process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
    process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
    const { oneMonthlySchedulePhaseEnd } = await import(
      "../../lib/services/organization-schedule-configuration-proof"
    );
    let creates = 0,
      updates = 0,
      snapshot: unknown = f.rawCreate;
    const stripe: Record<string, unknown> = {
      customers: { retrieve: async () => f.rawCustomer },
      subscriptions: { retrieve: async () => f.rawSubscription },
      invoices: { createPreview: async () => recurringInvoice(f) },
      events: {
        list: async () => {
          throw Error("Original response must suffice");
        },
      },
      subscriptionSchedules: {
        retrieve: async () => snapshot,
        create: async (
          _params: unknown,
          options: { idempotencyKey: string; maxNetworkRetries: number },
        ) => {
          creates++;
          expect(options.idempotencyKey).toBe(f.effect.provider_idempotency_key);
          expect(options.maxNetworkRetries).toBe(0);
          Reflect.set(f.rawSubscription, "schedule", f.rawCreate.id);
          f.rawCreate.created = Math.floor(Date.now() / 1000);
          return f.transport(
            structuredClone(f.rawCreate),
            "req_initialCreate",
            options.idempotencyKey,
          );
        },
        update: async (
          _id: string,
          params: {
            phases: { start_date: number; end_date?: number; items: { price: string }[] }[];
          },
          options: { idempotencyKey: string; maxNetworkRetries: number },
        ) => {
          updates++;
          expect(options.maxNetworkRetries).toBe(0);
          snapshot = {
            ...structuredClone(f.rawCreate),
            phases: params.phases.map((phase, index) => {
              const mapped = {
                ...f.rawCreate.phases[0],
                ...phase,
                end_date:
                  index === 0 ? phase.end_date : oneMonthlySchedulePhaseEnd(phase.start_date),
                items: phase.items.map((item) => ({
                  ...(f.rawCreate.phases[0]!.items as Record<string, unknown>[])[0],
                  ...item,
                  plan: item.price,
                })),
              };
              Reflect.deleteProperty(mapped, "iterations");
              return mapped;
            }),
          };
          return f.transport(
            structuredClone(snapshot) as object,
            "req_initialConfigure",
            options.idempotencyKey,
          );
        },
        release: async () => {
          throw Error("Successful configuration must not compensate");
        },
      },
    };
    installTestCatalog(stripe);
    stripeMock = stripe;
    const { confirmOrganizationSubscriptionDowngrade: confirm } = await import(
      "../../lib/services/organization-downgrade-command"
    );
    const input = { ...f.input, quoteId: f.quote.id, idempotencyKey: randomUUID() };
    const result = await confirm(input, async () => {});
    expect(result.status).toBe("APPLIED");
    expect(result.effect).toEqual({ kind: "schedule_configure", state: "observed" });
    expect(creates).toBe(1);
    expect(updates).toBe(1);
    expect((await confirm(input, async () => {})).commandId).toBe(result.commandId);
    expect(creates).toBe(1);
    expect(updates).toBe(1);
    const journal = (
      await db.query(
        "SELECT kind,state FROM organization_schedule_effects WHERE command_id=$1 ORDER BY created_at",
        [result.commandId],
      )
    ).rows;
    expect(journal).toEqual([
      { kind: "schedule_create", state: "observed" },
      { kind: "schedule_configure", state: "observed" },
    ]);
  });
  for (const lostResponse of [false, true])
    test(`interactive downgrade resumes original configuration and never redispatches: lost=${lostResponse}`, async () => {
      const f = await configured(false, false);
      const provider = dispatchProvider(f, lostResponse);
      provider.stripe.events = {
        list: async () => ({ object: "list", has_more: false, data: originalEvents(f) }),
      };
      await repo.finishOrganizationScheduleAttempt(f.identity, f.claim);
      const {
        confirmOrganizationSubscriptionDowngrade: confirm,
        readOrganizationSubscriptionDowngrade: read,
      } = await import("../../lib/services/organization-downgrade-command");
      const input = { ...f.input, quoteId: f.quote.id, idempotencyKey: randomUUID() };
      const before = await state(f);
      const first = await confirm(input, async () => {});
      expect(first.status).toBe(lostResponse ? "OUTCOME_UNKNOWN" : "APPLIED");
      expect(provider.updates()).toBe(1);
      expect(JSON.stringify(first)).not.toContain("provider_idempotency_key");
      if (lostResponse) {
        f.configurationEffect = (
          await db.query("SELECT * FROM organization_schedule_effects WHERE id=$1", [
            f.configurationEffect.id,
          ])
        ).rows[0];
        expect((await state(f)).source).toEqual(before.source);
        expect(
          (await confirm({ ...input, idempotencyKey: randomUUID() }, async () => {})).status,
        ).toBe("APPLIED");
      }
      const after = await state(f);
      expect(after.source.pending_plan_key).toBe("plus_monthly");
      expect(after.allowance).toEqual(before.allowance);
      expect(after.periods).toEqual(before.periods);
      const noRead = () => {
        throw Error("Terminal status must not query provider");
      };
      provider.stripe.events = { list: noRead };
      provider.stripe.customers = { retrieve: noRead };
      expect((await read(f.identity, async () => {})).status).toBe("APPLIED");
      expect((await confirm(input, async () => {})).status).toBe("APPLIED");
      expect(provider.updates()).toBe(1);
      expect(await state(f)).toEqual(after);
      await expect(
        read({ ...f.identity, actorId: randomUUID() }, async () => {}),
      ).rejects.toThrow();
      await expect(
        read({ ...f.identity, organizationId: randomUUID() }, async () => {}),
      ).rejects.toThrow();
    });
  test("unattended configuration recovery retains incidents, backs off and resolves atomically after manager loss", async () => {
    const f = await configured(false);
    const before = await state(f);
    await repo.finishOrganizationScheduleAttempt(f.identity, f.claim);
    await db.query(
      "UPDATE billing_subscription_commands SET updated_at=clock_timestamp()+interval '1 day' WHERE status IN ('PREPARED','OUTCOME_UNKNOWN') AND id<>$1",
      [f.identity.commandId],
    );
    const forceDue = async () => {
      await db.query(
        "UPDATE billing_subscription_commands SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
        [f.identity.commandId],
      );
      await db.query(
        "UPDATE billing_subscription_incidents SET next_retry_at=clock_timestamp()-interval '1 second' WHERE command_id=$1",
        [f.identity.commandId],
      );
    };
    const { recoverOrganizationSchedules: run } = await import(
      "../../lib/services/organization-schedule-maintenance"
    );
    const { listOrganizationScheduleRecovery: list } = await import(
      "./organization-schedule-maintenance"
    );
    providerFor(f, []);
    await forceDue();
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
    expect((await run()).unavailable).toBe(1);
    expect((await state(f)).source).toEqual(before.source);
    const incidents = async () =>
      (
        await db.query(
          "SELECT * FROM billing_subscription_incidents WHERE command_id=$1 ORDER BY created_at",
          [f.identity.commandId],
        )
      ).rows;
    expect(await incidents()).toHaveLength(1);
    expect((await incidents())[0].context.owner).toBe("organization_schedule_recovery");
    await db.query(
      "UPDATE billing_subscription_commands SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
      [f.identity.commandId],
    );
    expect((await list(25)).some((c) => c.id === f.identity.commandId)).toBeFalse();
    await forceDue();
    expect((await run()).unavailable).toBe(1);
    expect(await incidents()).toHaveLength(1);
    expect(Number((await incidents())[0].occurrence_count)).toBe(2);
    const foreignIncident = (
      await db.query(
        `INSERT INTO billing_subscription_incidents
          (organization_id,subscription_id,command_id,kind,severity,fingerprint,context)
         SELECT organization_id,subscription_id,id,'reconciliation','error',$2,
           '{"owner":"independent_recovery"}'::jsonb
         FROM billing_subscription_commands WHERE id=$1 RETURNING id`,
        [f.identity.commandId, "f".repeat(64)],
      )
    ).rows[0].id;
    providerFor(f, originalEvents(f));
    await forceDue();
    await db.query(`CREATE FUNCTION fail_schedule_incident_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='resolved' AND OLD.context->>'owner'='organization_schedule_recovery' THEN RAISE EXCEPTION 'fixture incident failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fail_schedule_incident_fixture BEFORE UPDATE ON billing_subscription_incidents FOR EACH ROW EXECUTE FUNCTION fail_schedule_incident_fixture()`);
    try {
      expect((await run()).unavailable).toBe(1);
      expect((await state(f)).source).toEqual(before.source);
      expect((await state(f)).command.status).toBe("OUTCOME_UNKNOWN");
    } finally {
      await db.query(
        "DROP TRIGGER fail_schedule_incident_fixture ON billing_subscription_incidents; DROP FUNCTION fail_schedule_incident_fixture()",
      );
    }
    await forceDue();
    expect((await run()).applied).toBe(1);
    const after = await state(f);
    expect(after.source.pending_plan_key).toBe("plus_monthly");
    expect(after.allowance).toEqual(before.allowance);
    expect(after.periods).toEqual(before.periods);
    const finalIncidents = await incidents();
    expect(
      finalIncidents
        .filter((row) => row.id !== foreignIncident)
        .every((row) => row.status === "resolved"),
    ).toBeTrue();
    expect(finalIncidents.find((row) => row.id === foreignIncident).status).toBe("open");
    expect((await list(25)).some((c) => c.id === f.identity.commandId)).toBeFalse();
  });
  test("unattended recovery neither steals a live lease nor dispatches an expired prepared quote", async () => {
    const active = await configured(false);
    await db.query(
      "UPDATE billing_subscription_commands SET updated_at=clock_timestamp()+interval '1 day' WHERE status IN ('PREPARED','OUTCOME_UNKNOWN') AND id<>$1",
      [active.identity.commandId],
    );
    await db.query(
      "UPDATE billing_subscription_commands SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
      [active.identity.commandId],
    );
    const { listOrganizationScheduleRecovery: list } = await import(
      "./organization-schedule-maintenance"
    );
    expect((await list(25)).some((c) => c.id === active.identity.commandId)).toBeFalse();
    const unstarted = await seed(1000);
    await Bun.sleep(1100);
    await db.query(
      "UPDATE billing_subscription_commands SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
      [unstarted.identity.commandId],
    );
    stripeMock = new Proxy(
      {},
      {
        get() {
          throw Error("Expired quote must not use provider");
        },
      },
    );
    const { recoverOrganizationSchedules: run } = await import(
      "../../lib/services/organization-schedule-maintenance"
    );
    expect((await run()).failed).toBe(1);
    expect(
      (
        await db.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
          unstarted.identity.commandId,
        ])
      ).rows[0].status,
    ).toBe("SUPERSEDED");
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM organization_schedule_effects WHERE command_id=$1",
          [unstarted.identity.commandId],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  for (const liveStatus of ["active", "past_due", "unpaid", "grace"] as const)
    test(`historical target payment preserves later ${liveStatus} with a controlled database clock`, async () => {
      const boundary = Math.floor(Date.now() / 1000) + 5;
      const f = await configured(true, true, {
        start: new Date((boundary - 120) * 1000),
        end: new Date(boundary * 1000),
      });
      if (liveStatus !== "active") await f.finalize(f.input);
      let before = await state(f);
      const { subscriptionAuthorityRepository: authority } = await import(
        "./subscription-authority"
      );
      let source = await authority.findById(f.identity.organizationId, f.captured.source.id);
      if (!source) throw new Error("Pending source missing");
      const target = f.input.rawCurrentSchedule.phases[1]!;
      if (typeof target.end_date !== "number") throw new Error("Finite target end required");
      const { SUBSCRIPTION_PAYMENT_GRACE_MS } = await import(
        "../../lib/services/subscription-payment-grace"
      );
      const logicalNow =
        target.end_date + (liveStatus === "grace" ? 0 : SUBSCRIPTION_PAYMENT_GRACE_MS / 1000) + 10;
      await db.query("UPDATE fixture_clock SET offset_seconds=$1", [
        logicalNow - Date.now() / 1000,
      ]);
      try {
        const clock = (
          await db.query(
            "SELECT clock_timestamp() AS logical, pg_catalog.clock_timestamp() AS real",
          )
        ).rows[0];
        expect(clock.logical.getTime()).toBeGreaterThan(clock.real.getTime() + 20 * 86400000);
        const provider = structuredClone(f.provider),
          item = provider.items.data[0]!;
        item.id = `si_history${f.identity.commandId.replaceAll("-", "")}`;
        Object.assign(item.price, { id: "price_plus", product: "prod_plus", unit_amount: 3000 });
        const { renewalPaidObjects } = await import("./subscription-renewal-test-fixture");
        const objects = renewalPaidObjects(
          { ...source, plan_key: "plus_monthly", stripe_subscription_item_id: item.id },
          provider,
          { start: boundary, end: target.end_date },
        );
        objects.invoice.status_transitions.paid_at = Math.floor(logicalNow);
        const subscription = {
          ...objects.subscription,
          status: liveStatus === "grace" ? "past_due" : liveStatus,
          schedule: null,
          current_period_start: target.end_date,
          current_period_end: target.end_date + 30 * 86400,
          latest_invoice: "in_later",
        };
        const scheduledSchedule = {
          ...structuredClone(f.input.rawCurrentSchedule),
          status: "completed",
          current_phase: null,
          completed_at: target.end_date,
          released_at: null,
          released_subscription: null,
        };
        if (liveStatus === "active") {
          // Recover a saved original response only after the target period expired,
          // then prove the same historical payment through the normal renewal owner.
          const reclaim = await repo.claimOrganizationSchedule(f.identity);
          if (!reclaim) throw new Error("Late saved-response claim missing");
          await f.finalize({
            ...f.input,
            leaseToken: reclaim.claim.leaseToken,
            executionGeneration: reclaim.claim.generation,
            rawSubscription: subscription,
            rawCurrentSchedule: scheduledSchedule,
          });
          before = await state(f);
          source = await authority.findById(f.identity.organizationId, f.captured.source.id);
          if (!source) throw new Error("Late pending source missing");
        }
        const { subscriptionBillingOperationsRepository: operations } = await import(
          "./subscription-billing-operations"
        );
        const providerEventId = `evt_history${f.identity.commandId.replaceAll("-", "")}`,
          eventCreatedAt = new Date(logicalNow * 1000),
          leaseToken = randomUUID();
        const receipt = await operations.recordEvent({
          organizationId: source.organization_id,
          subscriptionId: source.id,
          providerEventId,
          eventType: "invoice.paid",
          providerObjectType: "invoice",
          providerObjectId: objects.invoice.id,
          livemode: false,
          eventCreatedAt,
          payloadDigest: "e".repeat(64),
          now: eventCreatedAt,
        });
        expect(
          await operations.claimEvent({
            organizationId: source.organization_id,
            receiptId: receipt.value.id,
            leaseToken,
            leaseDurationMs: 60000,
          }),
        ).toBeTruthy();
        const input = {
          ...objects,
          subscription,
          scheduledSchedule,
          organizationId: source.organization_id,
          subscriptionId: source.id,
          invoiceId: objects.invoice.id,
          receiptId: receipt.value.id,
          leaseToken,
          expectedSubscriptionRevision: source.lifecycle_revision,
          expectedProjectionRevision: source.lifecycle_revision,
          providerEventId,
          eventCreatedAt,
        };
        const { finalizePaidRenewal } = await import("./subscription-renewal-finalization");
        const beforePayment = await state(f);
        await expect(
          finalizePaidRenewal({
            ...input,
            paymentIntent: { ...objects.paymentIntent, amount_received: 1 },
          }),
        ).rejects.toThrow();
        expect(await state(f)).toEqual(beforePayment);
        for (const invalid of [
          { ...input, expectedSubscriptionRevision: source.lifecycle_revision + 1 },
          { ...input, subscription: { ...subscription, latest_invoice: objects.invoice.id } },
          { ...input, invoice: { ...objects.invoice, customer: "cus_foreign" } },
          { ...input, subscription: { ...subscription, cancel_at_period_end: true } },
        ]) {
          await expect(finalizePaidRenewal(invalid)).rejects.toThrow();
          expect(await state(f)).toEqual(beforePayment);
        }
        await db.query(`CREATE FUNCTION reject_historical_expiry_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='expire' THEN RAISE EXCEPTION 'historical expiry failure'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER reject_historical_expiry_fixture BEFORE INSERT ON subscription_allowance_transactions FOR EACH ROW EXECUTE FUNCTION reject_historical_expiry_fixture()`);
        try {
          await expect(finalizePaidRenewal(input)).rejects.toThrow();
          expect(await state(f)).toEqual(beforePayment);
        } finally {
          await db.query(
            "DROP TRIGGER reject_historical_expiry_fixture ON subscription_allowance_transactions; DROP FUNCTION reject_historical_expiry_fixture()",
          );
        }
        const { retrievePaidRenewalObjects } = await import(
          "../../lib/services/stripe-paid-renewal-objects"
        );
        const readOnlyProvider = {
          invoices: { retrieve: async () => objects.invoice },
          subscriptions: { retrieve: async () => subscription },
          customers: { retrieve: async () => objects.customer },
          paymentIntents: { retrieve: async () => objects.paymentIntent },
          charges: { retrieve: async () => objects.charge },
          prices: { retrieve: async () => objects.price },
          products: { retrieve: async () => objects.product },
          subscriptionSchedules: { retrieve: async () => scheduledSchedule },
        };
        const fetched = await retrievePaidRenewalObjects(
          source,
          objects.invoice.id,
          readOnlyProvider as unknown as import("stripe").default,
        );
        if (liveStatus === "past_due") {
          let targetFailed = true;
          const failedTarget = {
            ...objects.invoice,
            status: "open",
            paid: false,
            amount_paid: 0,
            amount_remaining: objects.invoice.amount_due,
          };
          stripeMock = {
            ...readOnlyProvider,
            invoices: {
              retrieve: async () => (targetFailed ? failedTarget : objects.invoice),
              list: async () => ({
                object: "list",
                has_more: false,
                data: [{ ...(targetFailed ? failedTarget : objects.invoice), created: boundary }],
              }),
            },
          };
          await db.query(
            `INSERT INTO subscription_reconciliation_scans (organization_id, subscription_id, next_due_at)
            SELECT organization_id,id,clock_timestamp()+interval '1 hour' FROM billing_subscriptions WHERE id<>$1
            ON CONFLICT (organization_id,subscription_id) DO UPDATE SET next_due_at=EXCLUDED.next_due_at`,
            [source.id],
          );
          const { recoverMissedSubscriptionEvents } = await import(
            "../../lib/services/subscription-reconciliation"
          );
          const failed = await recoverMissedSubscriptionEvents();
          expect(failed.status).toBe("ok");
          const failedState = await state(f);
          expect(failedState.source.plan_key).toBe("pro_monthly");
          expect(failedState.source.pending_plan_key).toBe("plus_monthly");
          expect(failedState.source.current_period_end.getTime()).toBe(boundary * 1000);
          expect(failedState.source.dunning_started_at.getTime()).toBe(boundary * 1000);
          expect(failedState.periods).toEqual(beforePayment.periods);
          expect(failedState.allowance).toEqual(beforePayment.allowance);
          targetFailed = false;
          await db.query(
            "UPDATE subscription_reconciliation_scans SET next_due_at=clock_timestamp() WHERE subscription_id=$1",
            [source.id],
          );
          const recovered = await recoverMissedSubscriptionEvents();
          expect(recovered.status).toBe("ok");
          expect(recovered.attempts).toHaveLength(1);
          expect(recovered.attempts[0]?.disposition).toBe("applied");
        } else expect((await finalizePaidRenewal({ ...input, ...fetched })).replayed).toBeFalse();
        const after = await state(f);
        expect(after.source.status).toBe(liveStatus);
        expect(after.source.plan_key).toBe("plus_monthly");
        expect(after.source.pending_plan_key).toBeNull();
        expect(after.source.current_period_end.getTime()).toBe(target.end_date * 1000);
        expect(after.source.dunning_started_at?.getTime() ?? null).toBe(
          liveStatus === "active" ? null : target.end_date * 1000,
        );
        expect(after.command).toEqual(before.command);
        const period = (
          await db.query(
            "SELECT * FROM subscription_allowance_periods WHERE stripe_invoice_id=$1",
            [objects.invoice.id],
          )
        ).rows[0];
        expect(period.state).toBe("expired");
        expect(Number(period.available_amount)).toBe(0);
        expect(Number(period.expired_amount)).toBe(25);
        expect(
          (
            await finalizePaidRenewal({
              ...input,
              expectedSubscriptionRevision: Number(after.source.lifecycle_revision),
              expectedProjectionRevision: Number(after.projection.projection_revision),
            })
          ).replayed,
        ).toBeTrue();
        expect(await state(f)).toEqual(after);
        const paid = await authority.findById(source.organization_id, source.id);
        if (!paid) throw new Error("Historical paid source missing");
        const { assertScheduledPaidBinding } = await import(
          "./test-support/subscription-scheduled-binding"
        );
        await assertScheduledPaidBinding(paid, f.identity.commandId);
        // Another missed, now ordinary, interval must settle adjacent to the first
        // without granting the latest live period or dropping its dunning state.
        const nextEnd = target.end_date + 30 * 86400;
        const nextNow =
          nextEnd + (liveStatus === "grace" ? 10 : SUBSCRIPTION_PAYMENT_GRACE_MS / 1000 + 10);
        await db.query("UPDATE fixture_clock SET offset_seconds=$1", [nextNow - Date.now() / 1000]);
        const nextObjects = renewalPaidObjects(paid, provider, {
          start: target.end_date,
          end: nextEnd,
        });
        nextObjects.invoice.status_transitions.paid_at = Math.floor(nextNow);
        const nextEventId = `evt_next${f.identity.commandId.replaceAll("-", "")}`,
          nextCreatedAt = new Date(nextNow * 1000),
          nextLease = randomUUID();
        const nextReceipt = await operations.recordEvent({
          organizationId: paid.organization_id,
          subscriptionId: paid.id,
          providerEventId: nextEventId,
          eventType: "invoice.paid",
          providerObjectType: "invoice",
          providerObjectId: nextObjects.invoice.id,
          livemode: false,
          eventCreatedAt: nextCreatedAt,
          payloadDigest: "f".repeat(64),
          now: nextCreatedAt,
        });
        expect(
          await operations.claimEvent({
            organizationId: paid.organization_id,
            receiptId: nextReceipt.value.id,
            leaseToken: nextLease,
            leaseDurationMs: 60000,
          }),
        ).toBeTruthy();
        const nextInput = {
          ...nextObjects,
          organizationId: paid.organization_id,
          subscriptionId: paid.id,
          invoiceId: nextObjects.invoice.id,
          receiptId: nextReceipt.value.id,
          leaseToken: nextLease,
          expectedSubscriptionRevision: paid.lifecycle_revision,
          expectedProjectionRevision: paid.lifecycle_revision,
          providerEventId: nextEventId,
          eventCreatedAt: nextCreatedAt,
          subscription: {
            ...nextObjects.subscription,
            status: liveStatus === "grace" ? "past_due" : liveStatus,
            schedule: null,
            latest_invoice: "in_third",
            current_period_start: nextEnd,
            current_period_end: nextEnd + 30 * 86400,
          },
        };
        const beforeNext = await state(f);
        await expect(
          finalizePaidRenewal({
            ...nextInput,
            invoice: {
              ...nextObjects.invoice,
              lines: {
                ...nextObjects.invoice.lines,
                data: nextObjects.invoice.lines.data.map((line) => ({
                  ...line,
                  period: { ...line.period, start: line.period.start + 1 },
                })),
              },
            },
          }),
        ).rejects.toThrow();
        expect(await state(f)).toEqual(beforeNext);
        let historyPages = 0;
        let ordinaryFailed = liveStatus !== "active";
        let foreignFailedInvoice = liveStatus === "unpaid";
        const failedOrdinary = {
          ...nextObjects.invoice,
          status: "open",
          paid: false,
          amount_paid: 0,
          amount_remaining: nextObjects.invoice.amount_due,
        };
        const listedNext = { ...nextObjects.invoice, created: target.end_date };
        const listedLater = {
          ...listedNext,
          id: "in_third",
          created: nextEnd,
          lines: {
            ...listedNext.lines,
            data: listedNext.lines.data.map((line) => ({
              ...line,
              period: { start: nextEnd, end: nextEnd + 30 * 86400 },
            })),
          },
        };
        stripeMock = {
          ...readOnlyProvider,
          subscriptions: { retrieve: async () => nextInput.subscription },
          paymentIntents: { retrieve: async () => nextObjects.paymentIntent },
          charges: { retrieve: async () => nextObjects.charge },
          invoices: {
            list: async (request: { starting_after?: string }) => {
              historyPages++;
              return request.starting_after
                ? {
                    object: "list",
                    has_more: false,
                    data: [
                      {
                        ...(ordinaryFailed ? failedOrdinary : listedNext),
                        created: target.end_date,
                      },
                    ],
                  }
                : { object: "list", has_more: true, data: [listedLater] };
            },
            retrieve: async (id: string) => {
              expect(id).toBe(nextObjects.invoice.id);
              return ordinaryFailed
                ? {
                    ...failedOrdinary,
                    customer: foreignFailedInvoice ? "cus_foreign" : failedOrdinary.customer,
                  }
                : nextObjects.invoice;
            },
          },
        };
        await db.query(
          `INSERT INTO subscription_reconciliation_scans (organization_id, subscription_id, next_due_at)
          SELECT organization_id,id,clock_timestamp()+interval '1 hour' FROM billing_subscriptions WHERE id<>$1
          ON CONFLICT (organization_id,subscription_id) DO UPDATE SET next_due_at=EXCLUDED.next_due_at`,
          [paid.id],
        );
        const { recoverMissedSubscriptionEvents } = await import(
          "../../lib/services/subscription-reconciliation"
        );
        if (foreignFailedInvoice) {
          expect((await recoverMissedSubscriptionEvents()).status).toBe("degraded");
          expect(await state(f)).toEqual(beforeNext);
          foreignFailedInvoice = false;
          await db.query(
            "UPDATE subscription_reconciliation_scans SET next_due_at=clock_timestamp() WHERE subscription_id=$1",
            [paid.id],
          );
        }
        if (ordinaryFailed) {
          const failed = await recoverMissedSubscriptionEvents();
          expect(failed.status).toBe("ok");
          const failedState = await state(f);
          expect(failedState.source.current_period_end.getTime()).toBe(target.end_date * 1000);
          expect(failedState.source.dunning_started_at.getTime()).toBe(target.end_date * 1000);
          expect(failedState.periods).toEqual(beforeNext.periods);
          expect(failedState.allowance).toEqual(beforeNext.allowance);
          ordinaryFailed = false;
          historyPages = 0;
          await db.query(
            "UPDATE subscription_reconciliation_scans SET next_due_at=clock_timestamp() WHERE subscription_id=$1",
            [paid.id],
          );
        }
        const recovered = await recoverMissedSubscriptionEvents();
        expect(recovered.status).toBe("ok");
        expect(recovered.attempts).toHaveLength(1);
        expect(recovered.attempts[0]?.disposition).toBe("applied");
        expect(historyPages).toBe(2);
        const afterNext = await state(f);
        expect(afterNext.source.status).toBe(liveStatus);
        expect(afterNext.source.current_period_start.getTime()).toBe(target.end_date * 1000);
        expect(afterNext.source.current_period_end.getTime()).toBe(nextEnd * 1000);
        expect(afterNext.source.dunning_started_at?.getTime() ?? null).toBe(
          liveStatus === "active" ? null : nextEnd * 1000,
        );
        const nextPeriod = (
          await db.query(
            "SELECT * FROM subscription_allowance_periods WHERE stripe_invoice_id=$1",
            [nextObjects.invoice.id],
          )
        ).rows[0];
        expect(nextPeriod.state).toBe("expired");
        expect(Number(nextPeriod.available_amount)).toBe(0);
        expect(
          (
            await finalizePaidRenewal({
              ...nextInput,
              expectedSubscriptionRevision: Number(afterNext.source.lifecycle_revision),
              expectedProjectionRevision: Number(afterNext.projection.projection_revision),
            })
          ).replayed,
        ).toBeTrue();
        expect(await state(f)).toEqual(afterNext);
        const current = await authority.findById(paid.organization_id, paid.id);
        if (!current) throw new Error("Adjacent historical source missing");
        const { findSubscriptionRenewalBinding } = await import("./subscription-purchased-binding");
        expect(
          (
            await findSubscriptionRenewalBinding(current, {
              STRIPE_PLUS_MONTHLY_PRICE_ID: "price_rotated",
            })
          ).environment.STRIPE_PLUS_MONTHLY_PRICE_ID,
        ).toBe("price_plus");
      } finally {
        await db.query("UPDATE fixture_clock SET offset_seconds=0");
      }
    }, 30000);
  // The real database clock must cross the five-second renewal boundary
  // before publication, rollback and replay assertions can execute.
  for (const dunning of ["none", "webhook", "cron", "released"] as const)
    test(`paid first target atomically settles with dunning=${dunning}`, async () => {
      const boundary = Math.floor(Date.now() / 1000) + 5;
      const f = await configured(true, true, {
        start: new Date((boundary - 120) * 1000),
        end: new Date(boundary * 1000),
      });
      const { subscriptionAllowanceRepository: allowance } = await import(
        "./subscription-allowance"
      );
      const { writeTransaction } = await import("../helpers");
      await writeTransaction((tx) =>
        allowance.grantRenewalInTransaction(tx, {
          source: f.captured.source,
          invoiceId: `in_base${f.identity.commandId.replaceAll("-", "")}`,
          requestDigest: "a".repeat(64),
          databaseNow: new Date(),
        }),
      );
      await f.finalize(f.input);
      const before = await state(f);
      await Bun.sleep(Math.max(0, boundary * 1000 - Date.now() + 25));
      const { subscriptionAuthorityRepository: authority } = await import(
        "./subscription-authority"
      );
      let source = await authority.findById(f.identity.organizationId, f.captured.source.id);
      if (!source) throw new Error("Pending source missing");
      const { renewalPaidObjects } = await import("./subscription-renewal-test-fixture");
      const provider = structuredClone(f.provider);
      const targetItemId = `si_target${f.identity.commandId.replaceAll("-", "")}`;
      provider.items.data[0]!.id = targetItemId;
      Object.assign(provider.items.data[0]!.price, {
        id: "price_plus",
        product: "prod_plus",
        unit_amount: 3000,
      });
      const snapshot = structuredClone(f.input.rawCurrentSchedule),
        target = snapshot.phases[1]!;
      if (typeof target.end_date !== "number") throw new Error("Target fixture needs a finite end");
      snapshot.current_phase = { start_date: target.start_date, end_date: target.end_date };
      const objects = renewalPaidObjects(
        { ...source, plan_key: "plus_monthly", stripe_subscription_item_id: targetItemId },
        provider,
        { start: boundary, end: target.end_date },
      );
      objects.invoice.status_transitions.paid_at = boundary;
      const observedSchedule =
        dunning === "released"
          ? {
              ...snapshot,
              status: "released",
              subscription: null,
              released_subscription: source.stripe_subscription_id,
              released_at: boundary,
              completed_at: null,
              current_phase: null,
            }
          : snapshot;
      const subscription = {
        ...objects.subscription,
        schedule: dunning === "released" ? null : snapshot.id,
      };
      if (dunning === "webhook" || dunning === "cron") {
        const failed = {
          ...objects.invoice,
          status: "open",
          paid: false,
          amount_paid: 0,
          amount_remaining: objects.invoice.amount_due,
        };
        let observedInvoice = failed;
        stripeMock = {
          subscriptions: { retrieve: async () => ({ ...subscription, status: "past_due" }) },
          subscriptionSchedules: { retrieve: async () => snapshot },
          customers: { retrieve: async () => objects.customer },
          invoices: { retrieve: async () => observedInvoice },
        };
        const { reconcileStripeDunningLifecycle } = await import(
          "../../lib/services/stripe-dunning-lifecycle"
        );
        const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
        const event = {
          id: eventId,
          object: "event",
          type: "invoice.payment_failed",
          created: Math.floor(Date.now() / 1000),
          livemode: false,
          data: { object: failed },
          api_version: "2024-11-20.acacia",
          pending_webhooks: 0,
          request: null,
        } as unknown as import("stripe").default.Event;
        const message = {
          kind: "stripe.event" as const,
          eventId,
          eventType: event.type,
          event,
          receivedAt: Date.now(),
        };
        const beforeFailure = await state(f);
        if (dunning === "webhook") {
          observedInvoice = { ...failed, customer: "cus_foreign" };
          await expect(
            reconcileStripeDunningLifecycle(message, source.stripe_subscription_id),
          ).rejects.toThrow();
          expect(await state(f)).toEqual(beforeFailure);
          observedInvoice = failed;
          await db.query(`CREATE FUNCTION reject_dunning_receipt_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='applied' THEN RAISE EXCEPTION 'dunning receipt fixture failure'; END IF; RETURN NEW; END $$;
            CREATE TRIGGER reject_dunning_receipt_fixture BEFORE UPDATE ON billing_subscription_event_receipts FOR EACH ROW EXECUTE FUNCTION reject_dunning_receipt_fixture()`);
          try {
            await expect(
              reconcileStripeDunningLifecycle(message, source.stripe_subscription_id),
            ).rejects.toThrow();
            expect(await state(f)).toEqual(beforeFailure);
          } finally {
            await db.query(
              "DROP TRIGGER reject_dunning_receipt_fixture ON billing_subscription_event_receipts; DROP FUNCTION reject_dunning_receipt_fixture()",
            );
          }
          await reconcileStripeDunningLifecycle(message, source.stripe_subscription_id);
          const completed = await state(f);
          await reconcileStripeDunningLifecycle(message, source.stripe_subscription_id);
          expect(await state(f)).toEqual(completed);
        } else {
          // Keep unrelated fixture accounts outside this bounded production cron scan.
          await db.query(
            `INSERT INTO subscription_reconciliation_scans (organization_id, subscription_id, next_due_at)
            SELECT organization_id,id,clock_timestamp()+interval '1 hour' FROM billing_subscriptions WHERE id<>$1
            ON CONFLICT (organization_id,subscription_id) DO UPDATE SET next_due_at=EXCLUDED.next_due_at`,
            [source.id],
          );
          const { recoverMissedSubscriptionEvents } = await import(
            "../../lib/services/subscription-reconciliation"
          );
          const recovered = await recoverMissedSubscriptionEvents();
          expect(recovered.status).toBe("ok");
          expect(recovered.attempts).toHaveLength(1);
          expect(recovered.attempts[0]?.disposition).toBe("applied");
        }
        const afterFailure = await state(f);
        expect(afterFailure.source.status).toBe("grace");
        expect(afterFailure.source.plan_key).toBe("pro_monthly");
        expect(afterFailure.source.pending_plan_key).toBe("plus_monthly");
        expect(afterFailure.periods).toEqual(beforeFailure.periods);
        expect(afterFailure.allowance).toEqual(beforeFailure.allowance);
        source = await authority.findById(f.identity.organizationId, f.captured.source.id);
        if (!source) throw new Error("Dunning source missing");
      }
      const { subscriptionBillingOperationsRepository: operations } = await import(
        "./subscription-billing-operations"
      );
      const providerEventId = `evt_${f.identity.commandId.replaceAll("-", "")}`,
        eventCreatedAt = new Date(),
        leaseToken = crypto.randomUUID();
      const receipt = await operations.recordEvent({
        organizationId: source.organization_id,
        subscriptionId: source.id,
        providerEventId,
        eventType: "invoice.paid",
        providerObjectType: "invoice",
        providerObjectId: objects.invoice.id,
        livemode: false,
        eventCreatedAt,
        payloadDigest: "b".repeat(64),
        now: new Date(),
      });
      expect(
        await operations.claimEvent({
          organizationId: source.organization_id,
          receiptId: receipt.value.id,
          leaseToken,
          leaseDurationMs: 60000,
        }),
      ).toBeTruthy();
      const { finalizePaidRenewal } = await import("./subscription-renewal-finalization");
      const input = {
        ...objects,
        subscription,
        scheduledSchedule: observedSchedule,
        organizationId: source.organization_id,
        subscriptionId: source.id,
        invoiceId: objects.invoice.id,
        receiptId: receipt.value.id,
        leaseToken,
        expectedSubscriptionRevision: source.lifecycle_revision,
        expectedProjectionRevision: source.lifecycle_revision,
        providerEventId,
        eventCreatedAt,
      };
      const beforePayment = await state(f);
      for (const changed of [
        { ...input, paymentIntent: { ...input.paymentIntent, amount_received: 0 } },
        { ...input, scheduledSchedule: { ...snapshot, id: "sub_sched_foreign" } },
        {
          ...input,
          invoice: {
            ...input.invoice,
            lines: {
              ...input.invoice.lines,
              data: input.invoice.lines.data.map((line) => ({
                ...line,
                subscription_item: "si_foreign",
              })),
            },
          },
        },
      ]) {
        await expect(finalizePaidRenewal(changed)).rejects.toThrow();
        expect(await state(f)).toEqual(beforePayment);
      }
      await db.query(`CREATE FUNCTION reject_target_receipt_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='applied' THEN RAISE EXCEPTION 'target receipt fixture failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_target_receipt_fixture BEFORE UPDATE ON billing_subscription_event_receipts FOR EACH ROW EXECUTE FUNCTION reject_target_receipt_fixture()`);
      try {
        await expect(finalizePaidRenewal(input)).rejects.toThrow();
        expect(await state(f)).toEqual(beforePayment);
      } finally {
        await db.query(
          "DROP TRIGGER reject_target_receipt_fixture ON billing_subscription_event_receipts; DROP FUNCTION reject_target_receipt_fixture()",
        );
      }
      expect((await finalizePaidRenewal(input)).replayed).toBeFalse();
      expect((await finalizePaidRenewal(input)).replayed).toBeTrue();
      const after = await state(f);
      expect(after.source.plan_key).toBe("plus_monthly");
      expect(after.source.pending_plan_key).toBeNull();
      expect(after.source.stripe_subscription_item_id).toBe(targetItemId);
      expect(after.projection.plan_key).toBe("plus_monthly");
      expect(after.command).toEqual(before.command);
      expect(
        (
          await db.query(
            "SELECT granted_amount FROM subscription_allowance_periods WHERE stripe_invoice_id=$1",
            [objects.invoice.id],
          )
        ).rows,
      ).toEqual([{ granted_amount: "25.000000" }]);
      const paidSource = await authority.findById(source.organization_id, source.id);
      if (!paidSource) throw new Error("Paid source missing");
      const { assertScheduledPaidBinding } = await import(
        "./test-support/subscription-scheduled-binding"
      );
      await assertScheduledPaidBinding(paidSource, f.identity.commandId);
      const { reconcileStripePaidRenewal } = await import("../../lib/services/stripe-paid-renewal");
      let invoiceReads = 0;
      stripeMock = {
        invoices: {
          retrieve: async () => {
            invoiceReads++;
            return objects.invoice;
          },
        },
      };
      const deliverAgain = async () => {
        const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
        await reconcileStripePaidRenewal({
          kind: "stripe.event",
          eventId,
          eventType: "invoice.paid",
          receivedAt: Date.now(),
          event: {
            id: eventId,
            object: "event",
            type: "invoice.paid",
            created: Math.floor(Date.now() / 1000),
            livemode: false,
            data: { object: objects.invoice },
            api_version: "2024-11-20.acacia",
            pending_webhooks: 0,
            request: null,
          } as unknown as import("stripe").default.Event,
        });
        const row = await db.query(
          "SELECT status, applied_subscription_revision FROM billing_subscription_event_receipts WHERE provider_event_id=$1",
          [eventId],
        );
        expect(row.rows[0]?.status).toBe("applied");
        expect(Number(row.rows[0]?.applied_subscription_revision)).toBe(
          paidSource.lifecycle_revision,
        );
      };
      const beforeReplay = await state(f);
      await deliverAgain();
      expect(await state(f)).toEqual(beforeReplay);
      // A later lifecycle revision must not make the already-paid invoice depend on current provider state.
      const later = await authority.advance({
        organizationId: paidSource.organization_id,
        subscriptionId: paidSource.id,
        expectedRevision: paidSource.lifecycle_revision,
        source: "webhook",
        observation: "authoritative_provider_retrieval",
        values: {
          ...paidSource,
          cancel_at_period_end: true,
          provider_object_digest: "d".repeat(64),
          last_provider_event_id: `evt_${crypto.randomUUID().replaceAll("-", "")}`,
          last_provider_event_created_at: new Date(),
        },
      });
      const { findSubscriptionRenewalBinding } = await import("./subscription-purchased-binding");
      expect(
        (await findSubscriptionRenewalBinding(later.subscription, {})).environment
          .STRIPE_PLUS_MONTHLY_PRICE_ID,
      ).toBe("price_plus");
      const beforeLaterReplay = await state(f);
      await deliverAgain();
      expect(await state(f)).toEqual(beforeLaterReplay);
      expect(invoiceReads).toBe(2);
    }, 30_000);
});
