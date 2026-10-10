/** Real PostgreSQL atomic paid upgrade publication and concurrent allowance use. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { upgradePaidObjects } from "./organization-upgrade-paid-test-fixture";
import {
  installOrganizationUpgradeTestSchema,
  seedOrganizationUpgradeTestAccount,
} from "./organization-upgrade-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `upgrade_paid_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
let service: typeof import("./organization-upgrade-finalization");
let helpers: typeof import("../helpers");
let allowance: typeof import("./subscription-allowance").subscriptionAllowanceRepository;
let money: typeof import("./subscription-funding-reservations");
let close: typeof import("../client").closeDatabaseConnectionsForTests;
async function seed(period?: { start: Date; end: Date }) {
  const f = await seedOrganizationUpgradeTestAccount((q, v) => db.query(q, v), period);
  const suffix = f.input.subscriptionId.replaceAll("-", "");
  const initial = await helpers.writeTransaction((tx) =>
    allowance.grantRenewalInTransaction(tx, {
      source: f.captured.source,
      invoiceId: `in_base${suffix}`,
      requestDigest: "a".repeat(64),
      databaseNow: new Date(),
    }),
  );
  const { saveOrganizationUpgradeQuote } = await import("./organization-upgrade-quotes");
  const { prepareOrganizationUpgrade } = await import("./organization-upgrade-commands");
  const { claimOrganizationUpgrade, markOrganizationUpgradeDispatch } = await import(
    "./organization-upgrade-execution"
  );
  const { recordOrganizationUpgradeInvoiceOrigin } = await import(
    "./organization-upgrade-invoice-origins"
  );
  const quote = await saveOrganizationUpgradeQuote({
    identity: f.input,
    captured: f.captured,
    review: f.review,
    providerBinding: f.providerBinding,
  });
  const prepared = await prepareOrganizationUpgrade({ ...f.input, quoteId: quote.id });
  const identity = {
    organizationId: f.input.organizationId,
    actorId: f.input.actorId,
    commandId: prepared.command.id,
  };
  const claim = await claimOrganizationUpgrade(identity);
  if (!claim) throw new Error("Missing fixture claim");
  await markOrganizationUpgradeDispatch(identity, claim);
  const objects = upgradePaidObjects(f);
  objects.rawInvoice.id = `in_upgrade${suffix}`;
  await recordOrganizationUpgradeInvoiceOrigin({
    organizationId: f.input.organizationId,
    commandId: prepared.command.id,
    evidence: {
      kind: "invoice_created_event",
      raw: {
        id: `evt_${suffix}`,
        object: "event",
        type: "invoice.created",
        api_version: "2024-11-20.acacia",
        created: f.review.prorationDate,
        livemode: false,
        request: {
          id: `req_${suffix}`,
          idempotency_key: prepared.command.provider_idempotency_key,
        },
        data: { object: objects.rawInvoice },
      },
    },
  });
  return {
    ...f,
    quote,
    claim,
    initial: initial.period,
    commandId: prepared.command.id,
    finalInput: {
      organizationId: f.input.organizationId,
      commandId: prepared.command.id,
      leaseToken: claim.command.lease_token!,
      executionGeneration: claim.command.execution_generation,
      ...objects,
    },
  };
}
async function state(f: Awaited<ReturnType<typeof seed>>) {
  return {
    command: (
      await db.query(
        "SELECT status,result_subscription_revision::int revision FROM billing_subscription_commands WHERE id=$1",
        [f.commandId],
      )
    ).rows[0],
    source: (
      await db.query(
        "SELECT plan_key,lifecycle_revision::int revision FROM billing_subscriptions WHERE id=$1",
        [f.input.subscriptionId],
      )
    ).rows[0],
    projection: (
      await db.query(
        "SELECT source_subscription_revision::int revision FROM organization_entitlements WHERE organization_id=$1 AND billing_scope_id IS NULL",
        [f.input.organizationId],
      )
    ).rows[0],
    period: (
      await db.query("SELECT * FROM subscription_allowance_periods WHERE id=$1", [f.initial.id])
    ).rows[0],
    adjustments: (
      await db.query(
        "SELECT * FROM subscription_allowance_transactions WHERE allowance_period_id=$1 AND kind='grant_adjustment'",
        [f.initial.id],
      )
    ).rows,
  };
}
async function reserve(f: Awaited<ReturnType<typeof seed>>, micros: bigint) {
  return helpers.writeTransaction((tx) =>
    allowance.reserve(tx, {
      organizationId: f.input.organizationId,
      periodId: f.initial.id,
      logicalOperationId: randomUUID(),
      requestDigest: "b".repeat(64),
      requestedAmount: money.microsToMoney(micros),
      allowanceAmount: money.microsToMoney(micros),
      purchasedCreditAmount: money.microsToMoney(0n),
      purchasedCreditReservationTransactionId: null,
    }),
  );
}
(url ? describe : describe.skip)("atomic organization paid upgrade PostgreSQL", () => {
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
    const target = new URL(url!);
    target.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = target.toString();
    process.env.TEST_DATABASE_URL = target.toString();
    process.env.ENVIRONMENT = "local";
    process.env.LOCAL_PG_POOL_MAX = "4";
    service = await import("./organization-upgrade-finalization");
    helpers = await import("../helpers");
    ({ subscriptionAllowanceRepository: allowance } = await import("./subscription-allowance"));
    money = await import("./subscription-funding-reservations");
    ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
  }, 120000);
  afterAll(async () => {
    if (!db) return;
    await close?.();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });
  test("one transaction publishes source, exact adjustment, entitlement and immutable applied command", async () => {
    const f = await seed();
    const r = await service.finalizePaidOrganizationUpgrade(f.finalInput);
    const s = await state(f);
    expect(r.replayed).toBe(false);
    expect(s.command).toEqual({ status: "APPLIED", revision: 2 });
    expect(s.source).toEqual({ plan_key: "pro_monthly", revision: 2 });
    expect(s.projection.revision).toBe(2);
    expect(s.period.granted_amount).toBe("25.000000");
    expect(s.period.adjustment_amount).toBe(f.review.additionalAllowanceUsd);
    expect(s.adjustments).toHaveLength(1);
    expect(s.adjustments[0].source_invoice_id).toBe(f.finalInput.rawInvoice.id);
    await expect(
      db.query("UPDATE billing_subscription_commands SET provider_response_digest=$2 WHERE id=$1", [
        f.commandId,
        "f".repeat(64),
      ]),
    ).rejects.toThrow();
  });
  for (const purchased of [false, true])
    test(`reviewed paid plan binding survives catalog rotation with purchased=${purchased}`, async () => {
      const boundary = Math.floor(Date.now() / 1000) + 4;
      const f = await seed(
        purchased
          ? { start: new Date((boundary - 120) * 1000), end: new Date(boundary * 1000) }
          : undefined,
      );
      if (purchased) {
        const { checkoutContractSchema, checkoutContractDigest } = await import(
          "../../lib/services/subscription-checkout-contract"
        );
        const id = f.input.subscriptionId,
          org = f.input.organizationId,
          metadata = { app: "eliza-cloud", organization_id: org, command_id: id };
        const payload = checkoutContractSchema.parse({
          version: 1,
          catalogVersion: "v1",
          planKey: "plus_monthly",
          accountId: "acct_original",
          expectedLivemode: false,
          priceId: f.providerBinding.sourcePriceId,
          productId: f.providerBinding.sourceProductId,
          presentation: "embedded",
          params: {
            mode: "subscription",
            currency: "usd",
            customer: f.captured.source.stripe_customer_id,
            client_reference_id: id,
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
        VALUES($1,$2,$3,'checkout','plus_monthly',$4,$4,$5,'APPLIED',1,clock_timestamp(),$5,clock_timestamp(),clock_timestamp(),$1,$6::jsonb)`,
          [
            id,
            org,
            f.input.actorId,
            randomUUID(),
            "a".repeat(64),
            JSON.stringify({ payload, digest: checkoutContractDigest(payload) }),
          ],
        );
      }
      const applied = await service.finalizePaidOrganizationUpgrade(f.finalInput);
      const { subscriptionAuthorityRepository: authority } = await import(
        "./subscription-authority"
      );
      const source = await authority.findById(f.input.organizationId, f.input.subscriptionId);
      if (!source) throw new Error("Missing paid source");
      const { findSubscriptionRenewalBinding } = await import("./subscription-purchased-binding");
      const resolved = await findSubscriptionRenewalBinding(source, {
        STRIPE_PRO_MONTHLY_PRICE_ID: "price_rotated",
        STRIPE_PRO_PRODUCT_ID: "prod_rotated",
      });
      expect(resolved.environment.STRIPE_PRO_MONTHLY_PRICE_ID).toBe(
        f.providerBinding.targetPriceId,
      );
      expect(resolved.environment.STRIPE_PRO_PRODUCT_ID).toBe(f.providerBinding.targetProductId);
      expect(resolved.contract?.planKey ?? null).toBe(purchased ? "plus_monthly" : null);
      expect(resolved.contract?.accountId ?? null).toBe(purchased ? "acct_original" : null);
      // A historical invoice keeps its recorded Plus terms after the live source upgrades.
      // This resolver must never use current Pro terms or the deployment's rotated prices.
      const { findOriginalInvoiceCommercialTerms } = await import(
        "./subscription-invoice-commercial-terms"
      );
      const { invoiceEventFixture } = await import(
        "../../lib/services/test-support/subscription-invoice-event-fixture"
      );
      const { createSubscriptionInvoiceEventEvidence } = await import(
        "../../lib/services/subscription-invoice-event-evidence"
      );
      const originalFixture = invoiceEventFixture();
      const originalScope = {
        ...originalFixture.scope,
        organizationId: source.organization_id,
        subscriptionId: source.id,
        providerAccountId: "acct_original",
        customerId: source.stripe_customer_id,
        providerSubscriptionId: source.stripe_subscription_id,
      };
      Object.assign(originalFixture.invoice, {
        customer: originalScope.customerId,
        subscription: originalScope.providerSubscriptionId,
        total: 3000,
        subtotal: 3000,
        ending_balance: 3000,
      });
      const originalLine = originalFixture.invoice.lines.data[0]!;
      Object.assign(originalLine, {
        subscription: source.stripe_subscription_id,
        subscription_item: source.stripe_subscription_item_id,
        amount: 3000,
        price: {
          id: f.providerBinding.sourcePriceId,
          product: f.providerBinding.sourceProductId,
        },
        period: {
          start: f.captured.source.current_period_start.getTime() / 1000,
          end: f.captured.source.current_period_end.getTime() / 1000,
        },
      });
      const original = () =>
        createSubscriptionInvoiceEventEvidence(originalFixture.event, originalScope);
      originalFixture.event.created = originalLine.period.start + 1;
      originalFixture.invoice.status_transitions.paid_at = originalLine.period.start + 1;
      if (purchased) {
        const { findOriginalInvoiceCommercialOrigin } = await import(
          "./subscription-invoice-commercial-origin"
        );
        const futureOriginal = (pro: boolean) => {
          const future = structuredClone(originalFixture.event);
          const futureLine = future.data.object.lines.data[0]!;
          futureLine.period = {
            start: originalLine.period.end,
            end: originalLine.period.end + 30 * 86400,
          };
          future.created = futureLine.period.start + 1;
          future.data.object.status_transitions.paid_at = future.created;
          if (pro) {
            futureLine.amount = 10000;
            futureLine.price = {
              id: f.providerBinding.targetPriceId,
              product: f.providerBinding.targetProductId,
            };
            Object.assign(future.data.object, {
              total: 10000,
              subtotal: 10000,
              ending_balance: 10000,
            });
          }
          return createSubscriptionInvoiceEventEvidence(future, originalScope);
        };
        const beforeOrigin = await state(f);
        const purchasedOrigin = await findOriginalInvoiceCommercialOrigin(
          futureOriginal(false),
          source.id,
        );
        expect(purchasedOrigin.planKey).toBe("plus_monthly");
        expect(purchasedOrigin.periodStart).toBe(originalLine.period.end);
        const upgradedOrigin = await findOriginalInvoiceCommercialOrigin(
          futureOriginal(true),
          applied.command.id,
        );
        expect(upgradedOrigin.planKey).toBe("pro_monthly");
        expect(upgradedOrigin.allowanceAmountUsd).toBe("90.000000");
        const { assertReceiptCommercialSelection } = await import(
          "./test-support/subscription-commercial-selection"
        );
        await assertReceiptCommercialSelection({
          query: (q, v) => db.query(q, v),
          original: futureOriginal(true),
          commandId: applied.command.id,
        });
        expect(await state(f)).toEqual(beforeOrigin);
        expect(
          (
            await db.query(
              "SELECT count(*)::int n FROM billing_subscription_revisions WHERE subscription_id=$1 AND current_period_start=$2",
              [source.id, new Date(originalLine.period.end * 1000)],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
        await expect(
          findOriginalInvoiceCommercialOrigin(futureOriginal(true), source.id),
        ).rejects.toMatchObject({ code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE" });
        await expect(
          findOriginalInvoiceCommercialOrigin(original(), source.id),
        ).rejects.toMatchObject({ code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE" });
        await expect(
          findOriginalInvoiceCommercialOrigin(futureOriginal(true), randomUUID()),
        ).rejects.toMatchObject({ code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE" });
        const terms = await findOriginalInvoiceCommercialTerms(original(), 1);
        expect(terms.planKey).toBe("plus_monthly");
        expect(terms.baseAmountCents).toBe(3000);
        expect(terms.allowanceAmountUsd).toBe("25.000000");
        expect(terms.priceId).toBe(f.providerBinding.sourcePriceId);
        expect(terms.subscriptionRevision).toBe(1);
        expect(terms.periodEnd).toBe(originalLine.period.end);
        expect(await findOriginalInvoiceCommercialTerms(original(), 1)).toEqual(terms);
        for (const scopeChange of [
          { providerAccountId: "acct_foreign" },
          { organizationId: randomUUID() },
          { subscriptionId: randomUUID() },
        ]) {
          const foreign = createSubscriptionInvoiceEventEvidence(originalFixture.event, {
            ...originalScope,
            ...scopeChange,
          });
          await expect(findOriginalInvoiceCommercialTerms(foreign, 1)).rejects.toMatchObject({
            code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
          });
        }
        await expect(
          findOriginalInvoiceCommercialTerms({ ...original(), digest: "f".repeat(64) }, 1),
        ).rejects.toMatchObject({ code: "SUBSCRIPTION_INVOICE_EVENT_EVIDENCE_UNAVAILABLE" });
        await expect(findOriginalInvoiceCommercialTerms(original(), 2)).rejects.toMatchObject({
          code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
        });
        // Even a correctly rehashed invoice cannot borrow another item, interval or price.
        for (const change of [
          { subscription_item: "si_foreign" },
          { period: { ...originalLine.period, end: originalLine.period.end + 1 } },
          { price: { ...originalLine.price, id: "price_rotated" } },
          { amount: 2999 },
        ]) {
          const saved = structuredClone(originalLine);
          Object.assign(originalLine, change);
          await expect(findOriginalInvoiceCommercialTerms(original(), 1)).rejects.toMatchObject({
            code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
          });
          Object.assign(originalLine, saved);
        }
        const before = await state(f);
        // The applied upgrade's actual immutable revision supports its own original price.
        Object.assign(originalLine, {
          amount: 10000,
          price: {
            id: f.providerBinding.targetPriceId,
            product: f.providerBinding.targetProductId,
          },
        });
        Object.assign(originalFixture.invoice, {
          total: 10000,
          subtotal: 10000,
          ending_balance: 10000,
        });
        const upgradedTerms = await findOriginalInvoiceCommercialTerms(original(), 2);
        expect(upgradedTerms.planKey).toBe("pro_monthly");
        expect(upgradedTerms.allowanceAmountUsd).toBe("90.000000");
        expect(await state(f)).toEqual(before);
      } else {
        const { findOriginalInvoiceCommercialOrigin } = await import(
          "./subscription-invoice-commercial-origin"
        );
        await expect(
          findOriginalInvoiceCommercialOrigin(original(), applied.command.id),
        ).rejects.toMatchObject({ code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE" });
        await expect(findOriginalInvoiceCommercialTerms(original(), 1)).rejects.toMatchObject({
          code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
        });
      }
      for (const revision of [0, 1.5, 9999])
        await expect(
          findOriginalInvoiceCommercialTerms(original(), revision),
        ).rejects.toMatchObject({
          code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
        });
      await expect(
        findSubscriptionRenewalBinding({ ...source, provider_object_digest: "f".repeat(64) }, {}),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE" });
      const { proveReviewedPaidPlanBinding } = await import(
        "../../lib/services/subscription-reviewed-plan-binding"
      );
      const revisions = await authority.listRevisions(source.organization_id, source.id);
      const proofInput = { source, command: applied.command, quote: f.quote, revisions };
      expect(() =>
        proveReviewedPaidPlanBinding({ ...proofInput, revisions: revisions.slice(1) }),
      ).toThrow();
      expect(() =>
        proveReviewedPaidPlanBinding({
          ...proofInput,
          quote: { ...f.quote, organization_id: randomUUID() },
        }),
      ).toThrow();
      expect(() =>
        proveReviewedPaidPlanBinding({
          ...proofInput,
          revisions: revisions.map((r, i) => (i === 1 ? { ...r, plan_key: "plus_monthly" } : r)),
        }),
      ).toThrow();
      if (purchased) {
        await Bun.sleep(Math.max(0, boundary * 1000 - Date.now() + 25));
        const { renewalPaidObjects } = await import("./subscription-renewal-test-fixture");
        const objects = renewalPaidObjects(source, f.finalInput.rawSubscription, {
          start: boundary,
          end: boundary + 30 * 86400,
        });
        const { subscriptionBillingOperationsRepository: operations } = await import(
          "./subscription-billing-operations"
        );
        const providerEventId = `evt_${randomUUID().replaceAll("-", "")}`,
          eventCreatedAt = new Date(),
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
        const oldKey = process.env.STRIPE_SECRET_KEY,
          oldPrice = process.env.STRIPE_PRO_MONTHLY_PRICE_ID,
          oldProduct = process.env.STRIPE_PRO_PRODUCT_ID;
        process.env.STRIPE_SECRET_KEY = ["sk", "test", "renewalbinding"].join("_");
        process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_rotated";
        process.env.STRIPE_PRO_PRODUCT_ID = "prod_rotated";
        try {
          const { finalizePaidRenewal } = await import("./subscription-renewal-finalization");
          const input = {
            ...objects,
            organizationId: source.organization_id,
            subscriptionId: source.id,
            invoiceId: objects.invoice.id,
            receiptId: receipt.value.id,
            leaseToken,
            expectedSubscriptionRevision: 2,
            expectedProjectionRevision: 2,
            providerEventId,
            eventCreatedAt,
            providerAccountId: "acct_original",
          };
          await expect(
            finalizePaidRenewal({ ...input, providerAccountId: "acct_other" }),
          ).rejects.toMatchObject({ code: "SUBSCRIPTION_CHECKOUT_UNAVAILABLE" });
          expect(
            (
              await db.query(
                "SELECT count(*)::int AS count FROM subscription_allowance_periods WHERE stripe_invoice_id=$1",
                [objects.invoice.id],
              )
            ).rows,
          ).toEqual([{ count: 0 }]);
          expect((await finalizePaidRenewal(input)).replayed).toBeFalse();
          expect((await finalizePaidRenewal(input)).replayed).toBeTrue();
          const renewed = await authority.findById(source.organization_id, source.id);
          if (!renewed) throw new Error("Renewed source missing");
          expect(renewed.plan_key).toBe("pro_monthly");
          expect(renewed.lifecycle_revision).toBe(3);
          const retained = await findSubscriptionRenewalBinding(renewed, {});
          expect(retained.contract?.planKey).toBe("plus_monthly");
          expect(retained.environment.STRIPE_PRO_MONTHLY_PRICE_ID).toBe("price_pro");
          const historicalTerms = await findOriginalInvoiceCommercialTerms(original(), 2);
          expect(historicalTerms.subscriptionRevision).toBe(2);
          expect(historicalTerms.periodEnd).toBe(boundary);
          await expect(findOriginalInvoiceCommercialTerms(original(), 3)).rejects.toMatchObject({
            code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
          });
          expect(
            (
              await db.query(
                "SELECT granted_amount FROM subscription_allowance_periods WHERE stripe_invoice_id=$1",
                [objects.invoice.id],
              )
            ).rows,
          ).toEqual([{ granted_amount: "90.000000" }]);
          await authority.advance({
            organizationId: renewed.organization_id,
            subscriptionId: renewed.id,
            expectedRevision: renewed.lifecycle_revision,
            source: "webhook",
            observation: "authoritative_provider_retrieval",
            values: {
              ...renewed,
              status: "canceled",
              canceled_at: new Date(),
              ended_at: new Date(),
              last_provider_event_id: `evt_${randomUUID().replaceAll("-", "")}`,
              last_provider_event_created_at: new Date(),
              provider_object_digest: "c".repeat(64),
            },
          });
          const terminal = await authority.findById(renewed.organization_id, renewed.id);
          expect(terminal?.status).toBe("canceled");
          expect(await findOriginalInvoiceCommercialTerms(original(), 2)).toEqual(historicalTerms);
          const { findOriginalInvoiceCommercialOrigin } = await import(
            "./subscription-invoice-commercial-origin"
          );
          const deferredEvent = structuredClone(originalFixture.event);
          deferredEvent.data.object.lines.data[0]!.period = {
            start: boundary,
            end: boundary + 30 * 86400,
          };
          deferredEvent.created = boundary + 1;
          deferredEvent.data.object.status_transitions.paid_at = boundary + 1;
          const deferred = createSubscriptionInvoiceEventEvidence(deferredEvent, originalScope);
          expect(
            (await findOriginalInvoiceCommercialOrigin(deferred, applied.command.id)).planKey,
          ).toBe("pro_monthly");
          expect(await authority.findById(renewed.organization_id, renewed.id)).toEqual(terminal);
        } finally {
          for (const [key, value] of [
            ["STRIPE_SECRET_KEY", oldKey],
            ["STRIPE_PRO_MONTHLY_PRICE_ID", oldPrice],
            ["STRIPE_PRO_PRODUCT_ID", oldProduct],
          ] as const)
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
      }
    });
  test("concurrent paid deliveries apply once and replay after consumption without replenishing", async () => {
    const f = await seed();
    const results = await Promise.all([
      service.finalizePaidOrganizationUpgrade(f.finalInput),
      service.finalizePaidOrganizationUpgrade(f.finalInput),
    ]);
    expect(results.filter((x) => !x.replayed)).toHaveLength(1);
    await reserve(f, 5000000n);
    const before = await state(f);
    expect((await service.finalizePaidOrganizationUpgrade(f.finalInput)).replayed).toBe(true);
    expect((await state(f)).period.available_amount).toBe(before.period.available_amount);
    expect(before.adjustments).toHaveLength(1);
  });
  test("in-flight reservations and settled usage survive concurrent adjustment", async () => {
    const f = await seed();
    const used = await reserve(f, 8000000n);
    await helpers.writeTransaction((tx) =>
      allowance.finalize(tx, {
        organizationId: f.input.organizationId,
        reservationId: used.reservation.id,
        idempotencyKey: randomUUID(),
        requestDigest: "c".repeat(64),
        actualAllowanceAmount: money.microsToMoney(8000000n),
        actualPurchasedCreditAmount: money.microsToMoney(0n),
        uncollectedOverageAmount: money.microsToMoney(0n),
        purchasedCreditSettlementTransactionId: null,
        purchasedCreditRefundTransactionId: null,
      }),
    );
    await Promise.all([
      reserve(f, 5000000n),
      service.finalizePaidOrganizationUpgrade(f.finalInput),
    ]);
    const s = await state(f);
    expect(s.period.reserved_amount).toBe("5.000000");
    expect(s.period.settled_amount).toBe("8.000000");
    expect(money.moneyToMicros(s.period.available_amount, "available")).toBe(
      12000000n + money.moneyToMicros(f.review.additionalAllowanceUsd, "adjustment"),
    );
  });
  for (const [name, mutate] of [
    [
      "unpaid invoice",
      (f: Awaited<ReturnType<typeof seed>>) => {
        f.finalInput.rawInvoice.paid = false;
      },
    ],
    [
      "another invoice",
      (f: Awaited<ReturnType<typeof seed>>) => {
        f.finalInput.rawInvoice.id = "in_other";
      },
    ],
    [
      "pending target",
      (f: Awaited<ReturnType<typeof seed>>) => {
        Object.assign(f.finalInput.rawSubscription, { pending_update: { expires_at: 1800000000 } });
      },
    ],
    [
      "old price still applied",
      (f: Awaited<ReturnType<typeof seed>>) => {
        f.finalInput.rawSubscription.items.data[0]!.price.id = f.providerBinding.sourcePriceId;
      },
    ],
  ] as const)
    test(`${name} cannot partially publish`, async () => {
      const f = await seed();
      mutate(f);
      await expect(service.finalizePaidOrganizationUpgrade(f.finalInput)).rejects.toThrow();
      const s = await state(f);
      expect(s.source.revision).toBe(1);
      expect(s.projection.revision).toBe(1);
      expect(s.period.adjustment_amount).toBe("0.000000");
      expect(s.command.status).toBe("OUTCOME_UNKNOWN");
    });
  test("storage failure rolls back source and entitlement along with allowance", async () => {
    const f = await seed();
    await db.query(
      "CREATE FUNCTION reject_paid_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='grant_adjustment' THEN RAISE EXCEPTION 'fixture ledger failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_paid_fixture BEFORE INSERT ON subscription_allowance_transactions FOR EACH ROW EXECUTE FUNCTION reject_paid_fixture();",
    );
    try {
      await expect(service.finalizePaidOrganizationUpgrade(f.finalInput)).rejects.toThrow();
      const s = await state(f);
      expect(s.source.revision).toBe(1);
      expect(s.period.adjustment_amount).toBe("0.000000");
      expect(s.command.status).toBe("OUTCOME_UNKNOWN");
    } finally {
      await db.query(
        "DROP TRIGGER reject_paid_fixture ON subscription_allowance_transactions; DROP FUNCTION reject_paid_fixture()",
      );
    }
    expect((await service.finalizePaidOrganizationUpgrade(f.finalInput)).replayed).toBe(false);
  });
  test("actor removal does not lose a dispatched paid effect; system recovery fences the old worker", async () => {
    const f = await seed();
    await db.query("UPDATE users SET role='member',is_active=false WHERE id=$1", [f.input.actorId]);
    await db.query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.commandId],
    );
    const recovered = await service.claimOrganizationUpgradePaidReconciliation({
      organizationId: f.input.organizationId,
      commandId: f.commandId,
    });
    expect(recovered?.canDispatch).toBe(false);
    if (!recovered) throw new Error("Missing reconciliation claim");
    await expect(service.finalizePaidOrganizationUpgrade(f.finalInput)).rejects.toThrow();
    expect(
      (
        await service.finalizePaidOrganizationUpgrade({
          ...f.finalInput,
          leaseToken: recovered.command.lease_token!,
          executionGeneration: recovered.command.execution_generation,
        })
      ).replayed,
    ).toBe(false);
  });
  test("organization fence and foreign tenant prevent activation", async () => {
    const f = await seed(),
      other = await seed();
    await expect(
      service.finalizePaidOrganizationUpgrade({
        ...f.finalInput,
        organizationId: other.input.organizationId,
      }),
    ).rejects.toThrow();
    await db.query("UPDATE organizations SET is_active=false WHERE id=$1", [
      f.input.organizationId,
    ]);
    await expect(service.finalizePaidOrganizationUpgrade(f.finalInput)).rejects.toThrow();
    expect((await state(f)).source.revision).toBe(1);
  });
  test("late paid observation expires both unused base balance and the adjustment atomically", async () => {
    const second = Math.floor(Date.now() / 1000),
      f = await seed({
        start: new Date((second - 86400) * 1000),
        end: new Date((second + 5) * 1000),
      });
    await reserve(f, 5000000n);
    await Bun.sleep(Math.max(0, f.source.current_period_end.getTime() - Date.now() + 20));
    await service.finalizePaidOrganizationUpgrade(f.finalInput);
    const s = await state(f);
    expect(s.command.status).toBe("APPLIED");
    expect(s.period.state).toBe("expired");
    expect(s.period.available_amount).toBe("0.000000");
    expect(s.period.reserved_amount).toBe("5.000000");
    expect(money.moneyToMicros(s.period.expired_amount, "expired")).toBe(
      20000000n + money.moneyToMicros(f.review.additionalAllowanceUsd, "adjustment"),
    );
    await expect(reserve(f, 1000000n)).rejects.toThrow();
  }, 10000);
  test("zero-micro synthetic proration applies payment without inventing a positive grant", async () => {
    const second = Math.floor(Date.now() / 1000),
      f = await seed({
        start: new Date((second - 1000000000) * 1000),
        end: new Date((second + 5) * 1000),
      });
    expect(f.review.additionalAllowanceUsd).toBe("0.000000");
    await service.finalizePaidOrganizationUpgrade(f.finalInput);
    const s = await state(f);
    expect(s.command.status).toBe("APPLIED");
    expect(s.adjustments).toHaveLength(0);
    expect(s.period.granted_amount).toBe("25.000000");
    expect(s.period.available_amount).toBe("25.000000");
  });
  test("incident closure shares paid publication rollback and replay", async () => {
    const f = await seed();
    const {
      recordOrganizationUpgradeRecoveryOutcome: record,
      resolveAppliedUpgradeIncidentsInTransaction: resolve,
    } = await import("./organization-upgrade-recovery-incidents");
    const identity = { organizationId: f.input.organizationId, commandId: f.commandId };
    await record({ ...identity, issueCode: "UPGRADE_RECOVERY_UNAVAILABLE" });
    expect(await helpers.writeTransaction((tx) => resolve(tx, identity))).toBe(0);
    const before = await state(f);
    await db.query(
      "CREATE FUNCTION reject_upgrade_incident_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='resolved' THEN RAISE EXCEPTION 'fixture incident resolution failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_upgrade_incident_fixture BEFORE UPDATE ON billing_subscription_incidents FOR EACH ROW EXECUTE FUNCTION reject_upgrade_incident_fixture();",
    );
    try {
      await expect(service.finalizePaidOrganizationUpgrade(f.finalInput)).rejects.toThrow();
      expect(await state(f)).toEqual(before);
      expect(
        (
          await db.query("SELECT status FROM billing_subscription_incidents WHERE command_id=$1", [
            f.commandId,
          ])
        ).rows,
      ).toEqual([{ status: "open" }]);
    } finally {
      await db.query(
        "DROP TRIGGER reject_upgrade_incident_fixture ON billing_subscription_incidents; DROP FUNCTION reject_upgrade_incident_fixture()",
      );
    }
    await service.finalizePaidOrganizationUpgrade(f.finalInput);
    expect(
      (
        await db.query("SELECT status FROM billing_subscription_incidents WHERE command_id=$1", [
          f.commandId,
        ])
      ).rows,
    ).toEqual([{ status: "resolved" }]);
    const applied = await state(f);
    expect((await service.finalizePaidOrganizationUpgrade(f.finalInput)).replayed).toBe(true);
    expect(await state(f)).toEqual(applied);
  });

  test("failure at command publication rolls back already staged source, journal and entitlement", async () => {
    const f = await seed();
    await db.query(
      "CREATE FUNCTION reject_upgrade_commit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='upgrade' AND NEW.status='APPLIED' THEN RAISE EXCEPTION 'fixture final publication failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_upgrade_commit_fixture BEFORE UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION reject_upgrade_commit_fixture();",
    );
    try {
      await expect(service.finalizePaidOrganizationUpgrade(f.finalInput)).rejects.toThrow();
      const s = await state(f);
      expect(s.source.revision).toBe(1);
      expect(s.projection.revision).toBe(1);
      expect(s.adjustments).toHaveLength(0);
      expect(s.period.adjustment_amount).toBe("0.000000");
    } finally {
      await db.query(
        "DROP TRIGGER reject_upgrade_commit_fixture ON billing_subscription_commands; DROP FUNCTION reject_upgrade_commit_fixture()",
      );
    }
  });

  test("original renewal grant replays after an upgrade without rewriting base identity or resetting consumption", async () => {
    const f = await seed();
    await service.finalizePaidOrganizationUpgrade(f.finalInput);
    await reserve(f, 5000000n);
    const before = await state(f);
    const replay = await helpers.writeTransaction((tx) =>
      allowance.grantRenewalInTransaction(tx, {
        source: f.captured.source,
        invoiceId: f.initial.stripe_invoice_id!,
        requestDigest: "a".repeat(64),
        databaseNow: new Date(),
      }),
    );
    expect(replay.replayed).toBe(true);
    const after = await state(f);
    expect(after.period.available_amount).toBe(before.period.available_amount);
    expect(after.period.adjustment_amount).toBe(before.period.adjustment_amount);
    expect(String(after.period.subscription_revision)).toBe("1");
  });
  test("database refuses applied command without atomic target and allowance publication", async () => {
    const f = await seed();
    await expect(
      db.query(
        "UPDATE billing_subscription_commands SET status='APPLIED',provider_response_digest=$2,result_subscription_id=subscription_id,result_subscription_revision=expected_subscription_revision+1,completed_at=clock_timestamp(),applied_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
        [f.commandId, "a".repeat(64)],
      ),
    ).rejects.toThrow();
    expect((await state(f)).command.status).toBe("OUTCOME_UNKNOWN");
  });
  test("lease expiry after source publication rolls back the complete transaction", async () => {
    const f = await seed();
    await db.query(
      "CREATE SEQUENCE paid_lease_probe; CREATE FUNCTION delay_paid_lease_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='grant_adjustment' THEN PERFORM nextval('paid_lease_probe'); PERFORM pg_sleep(2.1); END IF; RETURN NEW; END $$; CREATE TRIGGER delay_paid_lease_fixture BEFORE INSERT ON subscription_allowance_transactions FOR EACH ROW EXECUTE FUNCTION delay_paid_lease_fixture();",
    );
    await db.query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
      [f.commandId],
    );
    try {
      await expect(service.finalizePaidOrganizationUpgrade(f.finalInput)).rejects.toThrow();
      expect((await db.query("SELECT is_called FROM paid_lease_probe")).rows[0].is_called).toBe(
        true,
      );
      const s = await state(f);
      expect(s.source.revision).toBe(1);
      expect(s.projection.revision).toBe(1);
      expect(s.adjustments).toHaveLength(0);
      expect(s.period.adjustment_amount).toBe("0.000000");
      expect(s.command.status).toBe("OUTCOME_UNKNOWN");
    } finally {
      await db.query(
        "DROP TRIGGER delay_paid_lease_fixture ON subscription_allowance_transactions; DROP FUNCTION delay_paid_lease_fixture(); DROP SEQUENCE paid_lease_probe",
      );
    }
  }, 10000);
  test("historical target and compatible later live period settle only the original expired allowance", async () => {
    const second = Math.floor(Date.now() / 1000);
    const f = await seed({
      start: new Date((second - 86400) * 1000),
      end: new Date((second + 5) * 1000),
    });
    const { recordOrganizationUpgradeHistoricalTarget: record } = await import(
      "./organization-upgrade-historical-targets"
    );
    const eventId = `evt_history${f.commandId.replaceAll("-", "")}`;
    await record({
      ...f.finalInput,
      raw: {
        id: eventId,
        object: "event",
        type: "customer.subscription.pending_update_applied",
        api_version: "2024-11-20.acacia",
        created: f.review.prorationDate,
        livemode: false,
        data: {
          object: { ...f.finalInput.rawSubscription, latest_invoice: f.finalInput.rawInvoice.id },
        },
      },
    });
    await Bun.sleep(Math.max(0, f.source.current_period_end.getTime() - Date.now() + 20));
    const live = {
      ...f.finalInput.rawSubscription,
      current_period_start: second + 5,
      current_period_end: second + 86405,
    };
    for (const invalid of [
      { ...live, status: "canceled" },
      { ...live, status: "past_due" },
      { ...live, cancel_at_period_end: true },
    ]) {
      await expect(
        service.finalizePaidOrganizationUpgrade({ ...f.finalInput, rawSubscription: invalid }),
      ).rejects.toThrow();
      expect((await state(f)).command.status).toBe("OUTCOME_UNKNOWN");
    }
    await service.finalizePaidOrganizationUpgrade({ ...f.finalInput, rawSubscription: live });
    const result = await state(f);
    expect(result.command.status).toBe("APPLIED");
    expect(result.source.plan_key).toBe("pro_monthly");
    expect(result.period.state).toBe("expired");
    expect(result.period.available_amount).toBe("0.000000");
    expect(result.adjustments).toHaveLength(1);
    const proof = (
      await db.query(
        "SELECT organization_upgrade_settlement_evidence AS proof FROM billing_subscription_commands WHERE id=$1",
        [f.commandId],
      )
    ).rows[0].proof;
    expect(proof.kind).toBe("historical_target_with_live_compatibility");
    expect(proof.eventId).toBe(eventId);
    expect(proof.livePeriodStart).toBe(f.source.current_period_end.toISOString());
    const deadline = (
      await db.query(
        "SELECT effective_until FROM organization_entitlements WHERE organization_id=$1 AND billing_scope_id IS NULL",
        [f.input.organizationId],
      )
    ).rows[0].effective_until;
    expect(deadline).toEqual(f.source.current_period_end);
    expect(deadline.getTime()).toBeLessThan(Date.now());
    await expect(
      db.query(
        "UPDATE billing_subscription_commands SET organization_upgrade_settlement_evidence=NULL WHERE id=$1",
        [f.commandId],
      ),
    ).rejects.toThrow();
    expect(
      (await service.finalizePaidOrganizationUpgrade({ ...f.finalInput, rawSubscription: live }))
        .replayed,
    ).toBe(true);
    expect((await state(f)).adjustments).toHaveLength(1);
  }, 10000);
  test("later live target alone cannot prove original period application", async () => {
    const second = Math.floor(Date.now() / 1000);
    const f = await seed({
      start: new Date((second - 86400) * 1000),
      end: new Date((second + 5) * 1000),
    });
    await Bun.sleep(Math.max(0, f.source.current_period_end.getTime() - Date.now() + 20));
    await expect(
      service.finalizePaidOrganizationUpgrade({
        ...f.finalInput,
        rawSubscription: {
          ...f.finalInput.rawSubscription,
          current_period_start: second + 5,
          current_period_end: second + 86405,
        },
      }),
    ).rejects.toThrow();
    expect((await state(f)).command.status).toBe("OUTCOME_UNKNOWN");
    expect((await state(f)).source.revision).toBe(1);
    expect((await state(f)).adjustments).toHaveLength(0);
  }, 10000);
});
