/** Defines the shared real-database recovery contract with an actual Stripe SDK loopback boundary; adapters own database lifecycle only. */
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import Stripe from "stripe";
import { installCancellationTestSchema } from "../subscription-cancellation-test-fixture";
import { seedRenewalTestAccount } from "../subscription-renewal-test-fixture";

export interface RecoveryContractDatabase {
  setup(): Promise<void>;
  exec(sql: string): Promise<void>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
  close(): Promise<void>;
}
export function definePaidRenewalRecoveryContract(database: RecoveryContractDatabase) {
  process.env.ENVIRONMENT = "local";
  process.env.NODE_ENV = "test";
  process.env.CLOUD_E2E = "1";
  process.env.STRIPE_SECRET_KEY = "sk_test_cloud_e2e";
  process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
  process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
  process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
  process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
  setDefaultTimeout(120_000);
  let service: typeof import("../../../lib/services/subscription-reconciliation");
  const objects = new Map<string, object>();
  const objectSequences = new Map<string, object[]>();
  const requests: string[] = [];
  const mutations = new Map<string, (body: URLSearchParams) => object>();
  let writes = 0;
  let legacyObservation: Record<string, unknown>;
  let legacyCapture: Record<string, unknown>;
  let beforeChargeResponse: (() => Promise<void>) | null = null;
  let beforeInvoiceResponse: (() => Promise<void>) | null = null;
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method !== "GET") writes++;
    response.setHeader("Content-Type", "application/json");
    const mutation = mutations.get(request.url ?? "");
    if (request.method === "POST" && mutation) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        try {
          response.end(JSON.stringify(mutation(new URLSearchParams(body))));
        } catch {
          response.writeHead(400);
          response.end(
            JSON.stringify({
              error: { message: "Controlled mutation did not match expected input" },
            }),
          );
        }
      });
      return;
    }
    const sequence = objectSequences.get(request.url ?? "");
    const value = sequence?.length ? sequence.shift() : objects.get(request.url ?? "");
    if (request.method !== "GET" || !value) {
      response.writeHead(400);
      response.end(
        JSON.stringify({ error: { message: "Unexpected controlled provider request" } }),
      );
      return;
    }
    if (request.url?.startsWith("/v1/charges/") && beforeChargeResponse) {
      const action = beforeChargeResponse;
      beforeChargeResponse = null;
      void action().then(
        () => response.end(JSON.stringify(value)),
        (error: Error) => {
          // error-policy:J1 Controlled transport exposes a failed race fixture as a failed response.
          response.destroy(error);
        },
      );
      return;
    }
    if (request.url?.startsWith("/v1/invoices/") && beforeInvoiceResponse) {
      const action = beforeInvoiceResponse;
      beforeInvoiceResponse = null;
      void action().then(
        () => response.end(JSON.stringify(value)),
        (error: Error) => {
          // error-policy:J1 Controlled provider race failures are transport failures.
          response.destroy(error);
        },
      );
      return;
    }
    response.end(JSON.stringify(value));
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback address missing");
    process.env.STRIPE_CLOUD_E2E_API_ORIGIN = `http://127.0.0.1:${address.port}`;
    await database.setup();
    await installCancellationTestSchema((query) => database.exec(query));
    const migration = await readFile(
      new URL("../../migrations/0385_subscription_reconciliation.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await database.exec(statement);
    const journalMigration = await readFile(
      new URL("../../migrations/0528_subscription_adjustment_observations.sql", import.meta.url),
      "utf8",
    );
    for (const statement of journalMigration.split("--> statement-breakpoint"))
      if (statement.trim()) await database.exec(statement);
    const claimMigration = await readFile(
      new URL("../../migrations/0529_subscription_adjustment_recovery.sql", import.meta.url),
      "utf8",
    );
    for (const statement of claimMigration.split("--> statement-breakpoint"))
      if (statement.trim()) await database.exec(statement);
    const invoiceEvidenceMigration = await readFile(
      new URL("../../migrations/0530_subscription_invoice_event_evidence.sql", import.meta.url),
      "utf8",
    );
    for (const statement of invoiceEvidenceMigration.split("--> statement-breakpoint"))
      if (statement.trim()) await database.exec(statement);
    const observationMigration = await readFile(
      new URL("../../migrations/0531_subscription_invoice_observations.sql", import.meta.url),
      "utf8",
    );
    for (const statement of observationMigration.split("--> statement-breakpoint"))
      if (statement.trim()) await database.exec(statement);
    // Persist a genuine pre-upgrade row before installing the new shape constraint.
    const legacy = await prepareInvoiceObservation();
    await legacy.journal.observeAndRecordOriginalInvoice(legacy.input, legacy.stripe);
    legacyObservation = (await legacy.rows())[0]!;
    const captureMigration = await readFile(
      new URL(
        "../../migrations/0532_subscription_invoice_capture_observations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of captureMigration.split("--> statement-breakpoint"))
      if (statement.trim()) await database.exec(statement);
    const oldCapture = await prepareInvoiceObservation(undefined, true);
    const originalRow = (
      await database.query<{
        evidence: import("../../../lib/services/subscription-invoice-event-evidence").SubscriptionInvoiceEventEvidence;
      }>("SELECT evidence FROM subscription_invoice_event_evidence WHERE receipt_id=$1", [
        oldCapture.owner.receiptId,
      ])
    ).rows[0]!;
    const { observeRetainedCollectingInvoiceCapture } = await import(
      "../../../lib/services/retained-collecting-invoice-capture"
    );
    const oldEvidence = await observeRetainedCollectingInvoiceCapture(
      originalRow.evidence,
      oldCapture.stripe,
    );
    await database.query(
      "INSERT INTO subscription_invoice_observations(organization_id,receipt_id,request_id,version,observation,observed_at) VALUES($1,$2,$3,1,$4,clock_timestamp())",
      [
        oldCapture.owner.organizationId,
        oldCapture.owner.receiptId,
        oldCapture.input.leaseToken,
        JSON.stringify(oldEvidence),
      ],
    );
    legacyCapture = (await oldCapture.rows())[0]!;
    const debtMigration = await readFile(
      new URL("../../migrations/0533_subscription_invoice_debt_observations.sql", import.meta.url),
      "utf8",
    );
    for (const statement of debtMigration.split("--> statement-breakpoint"))
      if (statement.trim()) await database.exec(statement);
    service = await import("../../../lib/services/subscription-reconciliation");
  });
  beforeEach(async () => {
    await database.exec("UPDATE organizations SET is_active=false");
    objects.clear();
    mutations.clear();
    objectSequences.clear();
    requests.length = 0;
    writes = 0;
    beforeChargeResponse = null;
    beforeInvoiceResponse = null;
  });
  afterAll(async () => {
    if (server.listening) {
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    }
    await database.close();
  });
  async function seed() {
    const f = await seedRenewalTestAccount((sql, values) => database.query(sql, values));
    for (const [path, value] of [
      [`/v1/customers/${f.customer.id}`, f.customer],
      [`/v1/subscriptions/${f.subscription.id}`, f.subscription],
      [`/v1/invoices/${f.invoice.id}`, f.invoice],
      [`/v1/payment_intents/${f.paymentIntent.id}`, f.paymentIntent],
      [`/v1/charges/${f.charge.id}`, f.charge],
      [`/v1/prices/${f.price.id}`, f.price],
      [`/v1/products/${f.product.id}`, f.product],
    ] as const)
      objects.set(path, value);
    return f;
  }
  async function seedPurchasedCheckout(planKey: "plus_monthly" | "pro_monthly" = "plus_monthly") {
    const fixture = await seedRenewalTestAccount((sql, values) => database.query(sql, values));
    const orgId = randomUUID(),
      actorId = randomUUID();
    const customerId = `cus_${orgId.replaceAll("-", "")}`;
    const db = database;
    await db.query("INSERT INTO organizations(id,stripe_customer_id) VALUES($1,$2)", [
      orgId,
      customerId,
    ]);
    await db.query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'owner')", [
      actorId,
      orgId,
    ]);
    const operations = (await import("../subscription-billing-operations"))
      .subscriptionBillingOperationsRepository;
    const binding = (
      await import("../../../lib/services/subscription-catalog")
    ).resolveSubscriptionProviderBinding(process.env, planKey, "v1");
    const commandId = randomUUID();
    const command = (
      await operations.enqueueCommand({
        id: commandId,
        organizationId: orgId,
        requestedByUserId: actorId,
        kind: "checkout",
        subscriptionId: null,
        targetPlanKey: planKey,
        expectedSubscriptionRevision: null,
        idempotencyKey: randomUUID(),
        providerIdempotencyKey: randomUUID(),
        requestDigest: "b".repeat(64),
        checkoutContract: {
          version: 1,
          catalogVersion: "v1",
          planKey,
          accountId: "acct_checkoutfixture",
          expectedLivemode: false,
          priceId: binding.priceId,
          productId: binding.productId,
          params: {
            mode: "subscription",
            customer: customerId,
            client_reference_id: commandId,
            line_items: [{ price: binding.priceId, quantity: 1 }],
            payment_method_types: ["card"],
            allow_promotion_codes: false,
            automatic_tax: { enabled: false },
            metadata: { app: "eliza-cloud", organization_id: orgId, command_id: commandId },
            subscription_data: {
              metadata: { app: "eliza-cloud", organization_id: orgId, command_id: commandId },
            },
            success_url:
              "https://cloud.eliza.app/cloud/billing?subscription_session_id={CHECKOUT_SESSION_ID}",
            cancel_url: "https://cloud.eliza.app/cloud/billing",
            expires_at: Math.floor(Date.now() / 1000) + 86400,
          },
        },
        now: new Date(),
      })
    ).value;
    await operations.markCommandOutcomeUnknown({
      organizationId: orgId,
      commandId: command.id,
      expectedStateRevision: command.state_revision,
      expectedExecutionGeneration: 0,
    });
    // These provider identities must not overlap the fixture's historical subscription.
    const subId = `sub_${orgId.replaceAll("-", "")}`,
      itemId = `si_${orgId.replaceAll("-", "")}`;
    fixture.invoice.billing_reason = "subscription_create";
    fixture.invoice.customer = customerId;
    fixture.invoice.subscription = subId;
    fixture.invoice.lines.data[0]!.subscription = subId;
    fixture.invoice.lines.data[0]!.subscription_item = itemId;
    fixture.subscription.id = subId;
    fixture.subscription.customer = customerId;
    fixture.subscription.items.data[0]!.id = itemId;
    fixture.customer.id = customerId;
    fixture.paymentIntent.customer = customerId;
    fixture.charge.customer = customerId;
    const session = {
      id: `cs_test_${orgId.replaceAll("-", "")}`,
      mode: "subscription",
      status: "complete",
      payment_status: "paid",
      customer: customerId,
      subscription: subId,
      invoice: fixture.invoice.id,
      livemode: false,
      client_reference_id: command.id,
      metadata: { app: "eliza-cloud", organization_id: orgId, command_id: command.id },
    };
    return { ...fixture, session, orgId, command, providerAccountId: "acct_checkoutfixture" };
  }

  async function allowanceCount(organizationId: string) {
    return (
      await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM subscription_allowance_periods WHERE organization_id=$1",
        [organizationId],
      )
    ).rows[0]!.count;
  }
  test.each([
    { plan_key: "app_monthly" },
    { plan_key: "independent_app_plan" },
    { billing_scope_id: randomUUID() },
    { merchant_key: "app-merchant" },
  ])("rejects non-organization renewal sources before provider reads: %j", async (invalid) => {
    const f = await seed();
    const { retrievePaidRenewalObjects } = await import(
      "../../../lib/services/stripe-paid-renewal-objects"
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback address missing");
    const stripe = new Stripe("sk_test_cloud_e2e", {
      host: "127.0.0.1",
      port: address.port,
      protocol: "http",
      maxNetworkRetries: 0,
    });
    await expect(
      retrievePaidRenewalObjects({ ...f.source, ...invalid }, f.invoice.id, stripe),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_ORGANIZATION_SOURCE_UNAVAILABLE" });
    expect(requests).toEqual([]);
    expect(await allowanceCount(f.source.organization_id)).toBe(0);
    expect(writes).toBe(0);
  });
  test("missed paid renewal heals through the existing cron without a webhook delivery", async () => {
    const f = await seed();
    Object.assign(f.invoice, {
      description: "PRIVATE_INVOICE_NOTE",
      metadata: { secret: "PRIVATE_INVOICE_NOTE" },
    });
    expect(await allowanceCount(f.source.organization_id)).toBe(0);
    const result = await service.recoverMissedSubscriptionEvents();
    expect(await allowanceCount(f.source.organization_id)).toBe(1);
    expect(result.status).toBe("ok");
    expect(result.attempts[0]?.disposition).toBe("applied");
    const retained = (
      await database.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM subscription_allowance_transactions WHERE organization_id=$1 AND kind='grant'",
        [f.source.organization_id],
      )
    ).rows[0]!.metadata.renewalInvoiceAuthority as Record<string, unknown>;
    expect(retained.kind).toBe("renewal_invoice_authority");
    expect(retained.invoiceId).toBe(f.invoice.id);
    expect(retained.customerId).toBe(f.source.stripe_customer_id);
    expect(retained.subscriptionId).toBe(f.source.id);
    expect(retained.invoiceLineId).toBe(f.invoice.lines.data[0]!.id);
    expect(retained.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(retained.grantDigest).toMatch(/^[a-f0-9]{64}$/);
    const metadataBeforeReplay = (
      await database.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM subscription_allowance_transactions WHERE organization_id=$1 AND kind='grant'",
        [f.source.organization_id],
      )
    ).rows[0]!.metadata;
    expect(JSON.stringify(metadataBeforeReplay)).not.toContain("PRIVATE_INVOICE_NOTE");
    const details = metadataBeforeReplay.renewalInvoiceDetails as {
      authorityDigest: string;
      digest: string;
      invoice: {
        id: string;
        total: number;
        amount_paid: number;
        lines: { data: Array<{ id: string }> };
      };
    };
    if (typeof retained.digest !== "string") throw new Error("Missing retained authority digest");
    expect(details.authorityDigest).toBe(retained.digest);
    expect(details.invoice.id).toBe(f.invoice.id);
    expect(details.invoice.total).toBe(f.invoice.total);
    expect(details.invoice.amount_paid).toBe(f.invoice.amount_paid);
    expect(details.invoice.lines.data[0]!.id).toBe(f.invoice.lines.data[0]!.id);
    expect(details.digest).toMatch(/^[a-f0-9]{64}$/);
    const settlement = metadataBeforeReplay.renewalSettlementDetails as {
      invoiceDetailsDigest: string;
      payment: { amount_received: number };
      charge: { amount_captured: number };
      balanceHistory: unknown;
    };
    expect(settlement.invoiceDetailsDigest).toBe(details.digest);
    expect(settlement.payment.amount_received).toBe(f.invoice.amount_paid);
    expect(settlement.charge.amount_captured).toBe(f.invoice.amount_paid);
    expect(settlement.balanceHistory).toBeNull();
    await service.recoverMissedSubscriptionEvents();
    const replayMetadata = (
      await database.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM subscription_allowance_transactions WHERE organization_id=$1 AND kind='grant'",
        [f.source.organization_id],
      )
    ).rows[0]!.metadata;
    expect(replayMetadata).toEqual(metadataBeforeReplay);

    expect(writes).toBe(0);
    const revisions = (
      await database.query<{
        source: string;
        provider_event_id: string | null;
      }>(
        "SELECT source,provider_event_id FROM billing_subscription_revisions WHERE subscription_id=$1 ORDER BY revision DESC LIMIT 1",
        [f.source.id],
      )
    ).rows;
    expect(revisions).toEqual([{ source: "reconciliation", provider_event_id: null }]);
    expect(
      (
        await database.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM billing_subscription_event_receipts WHERE organization_id=$1",
          [f.source.organization_id],
        )
      ).rows[0]!.count,
    ).toBe(0);
  });

  for (const account of ["retained", "foreign"] as const) {
    test(`cancellation and reviewed resume use ${account} purchase authority after catalog rotation`, async () => {
      const f = await seedPurchasedCheckout();
      const { finalizeSubscriptionCheckout } = await import(
        "../subscription-checkout-finalization"
      );
      await finalizeSubscriptionCheckout(f);
      await database.query("UPDATE organizations SET is_active=false WHERE id<>$1", [f.orgId]);
      let live = {
        ...f.subscription,
        canceled_at: null as number | null,
        cancel_at: null as number | null,
      };
      const path = `/v1/subscriptions/${live.id}`;
      objects.set(path, live);
      objects.set(`/v1/customers/${f.customer.id}`, f.customer);
      objects.set("/v1/account", {
        id: account === "retained" ? "acct_checkoutfixture" : "acct_foreign",
      });
      mutations.set(path, (body) => {
        expect([...body.keys()]).toEqual(["cancel_at_period_end"]);
        const canceled = body.get("cancel_at_period_end") === "true";
        live = {
          ...live,
          cancel_at_period_end: canceled,
          cancel_at: canceled ? live.current_period_end : null,
          canceled_at: canceled ? Math.floor(Date.now() / 1000) : live.canceled_at,
        };
        objects.set(path, live);
        return live;
      });
      mutations.set("/v1/invoices/create_preview", (body) => {
        expect(body.get("subscription")).toBe(live.id);
        expect(body.get("subscription_details[cancel_at_period_end]")).toBe("false");
        return {
          ...f.invoice,
          id: "upcoming_in_retained",
          status: "draft",
          automatic_tax: { enabled: false, status: null },
          lines: {
            ...f.invoice.lines,
            data: [
              {
                ...f.invoice.lines.data[0]!,
                period: {
                  start: live.current_period_end,
                  end: live.current_period_end + 30 * 86400,
                },
              },
            ],
          },
        };
      });
      const input = {
        organizationId: f.orgId,
        actorId: f.command.requested_by_user_id,
        subscriptionId: f.command.id,
        expectedSubscriptionRevision: 1,
        idempotencyKey: randomUUID(),
      };
      const cancellation = await import("../../../lib/services/subscription-cancellation");
      process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_rotated";
      process.env.STRIPE_PLUS_PRODUCT_ID = "prod_rotated";
      try {
        if (account === "retained") {
          const repository = await import("../subscription-cancellation");
          const command = await repository.prepareCancellation(input);
          const claim = await repository.claimCancellation({ ...input, commandId: command.id });
          if (!claim) throw new Error("Cancellation fixture claim missing");
          const scheduled = {
            ...live,
            cancel_at_period_end: true,
            cancel_at: live.current_period_end,
            canceled_at: Math.floor(Date.now() / 1000),
          };
          await expect(
            repository.finalizeCancellation(input, claim, scheduled, "acct_foreign"),
          ).rejects.toThrow();
          await expect(repository.finalizeCancellation(input, claim, scheduled)).rejects.toThrow();
          expect(await sourceRevision(f.command.id)).toBe(1);
          await repository.releaseCancellation(input, claim);
        }
        const result = await cancellation.submitOrganizationSubscriptionCancellation(
          input,
          async () => {},
        );
        if (account === "foreign") {
          expect(result.status).toBe("OUTCOME_UNKNOWN");
          expect(writes).toBe(0);
          expect(await sourceRevision(f.command.id)).toBe(1);
          return;
        }
        expect(result.status).toBe("APPLIED");
        expect(writes).toBe(1);
        const { reconcileStripeScheduledCancellationLifecycle } = await import(
          "../../../lib/services/stripe-scheduled-cancellation-lifecycle"
        );
        const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
        const event = {
          id: eventId,
          type: "customer.subscription.updated",
          created: Math.floor(Date.now() / 1000),
          livemode: false,
          data: { object: live },
        };
        await reconcileStripeScheduledCancellationLifecycle({
          kind: "stripe.event",
          receivedAt: Date.now(),
          eventId,
          eventType: event.type,
          // Production validates pinned Acacia wire data independently of the newer SDK type.
          event: event as unknown as Stripe.Event,
        });
        const revision = await sourceRevision(f.command.id);
        const { readOrganizationSubscriptionRenewalReview } = await import(
          "../../../lib/services/subscription-renewal-review"
        );
        const resume = {
          ...input,
          expectedSubscriptionRevision: revision,
          idempotencyKey: randomUUID(),
        };
        const review = await readOrganizationSubscriptionRenewalReview(resume, async () => {});
        expect(review.planKey).toBe("plus_monthly");
        const resultUndo =
          await cancellation.submitReviewedOrganizationSubscriptionCancellationUndo(
            { ...resume, expectedRenewalTermsDigest: review.termsDigest },
            async () => {},
          );
        expect(resultUndo.status).toBe("APPLIED");
        expect(await allowanceCount(f.orgId)).toBe(1);
        expect(
          (
            await database.query(
              "SELECT cancel_at_period_end FROM billing_subscriptions WHERE id=$1",
              [f.command.id],
            )
          ).rows,
        ).toEqual([{ cancel_at_period_end: false }]);
      } finally {
        process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
        process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
      }
    });
  }

  for (const scenario of ["partial", "full", "excess", "waived", "reversed", "changing"] as const) {
    test(`canonical SDK recovery proves ${scenario} credit settlement without synthetic payments`, async () => {
      const f = await seed();
      const credit =
        scenario === "partial"
          ? 500
          : scenario === "excess"
            ? 4000
            : scenario === "waived"
              ? 0
              : 3000;
      const used = Math.min(credit, 3000),
        total = scenario === "waived" ? 0 : 3000;
      const due = total - used;
      const discount = { amount: 3000, discount: "di_waived" };
      objects.set(`/v1/invoices/${f.invoice.id}`, {
        ...f.invoice,
        starting_balance: -credit,
        ending_balance: -credit + used,
        total,
        amount_due: due,
        amount_paid: due,
        payment_intent: due ? f.invoice.payment_intent : null,
        charge: due ? f.invoice.charge : null,
        ...(scenario === "waived"
          ? {
              discounts: [discount.discount],
              total_discount_amounts: [discount],
              lines: {
                ...f.invoice.lines,
                data: [{ ...f.invoice.lines.data[0]!, discount_amounts: [discount] }],
              },
            }
          : {}),
      });
      objects.set(`/v1/payment_intents/${f.paymentIntent.id}`, {
        ...f.paymentIntent,
        amount: due,
        amount_received: due,
      });
      objects.set(`/v1/charges/${f.charge.id}`, { ...f.charge, amount: due, amount_captured: due });
      const applied = {
        id: "cbtxn_applied",
        object: "customer_balance_transaction",
        customer: f.customer.id,
        invoice: f.invoice.id,
        livemode: false,
        currency: "usd",
        type: "applied_to_invoice",
        amount: used,
        ending_balance: -credit + used,
        created: f.invoice.status_transitions.paid_at,
        credit_note: null,
      };
      const data =
        scenario === "reversed"
          ? [
              { ...applied, id: "cbtxn_reversal", type: "unapplied_from_invoice", amount: -used },
              applied,
            ]
          : [applied];
      objects.set(`/v1/customers/${f.customer.id}/balance_transactions?limit=100`, {
        object: "list",
        has_more: false,
        data,
      });
      objects.set(`/v1/customers/${f.customer.id}/balance_transactions?limit=1`, {
        object: "list",
        has_more: data.length > 1,
        data: [scenario === "changing" ? { ...applied, id: "cbtxn_new" } : data[0]],
      });
      const result = await service.recoverMissedSubscriptionEvents();
      const denied = scenario === "reversed" || scenario === "changing";
      expect(await allowanceCount(f.source.organization_id)).toBe(denied ? 0 : 1);
      expect(result.attempts[0]?.disposition).toBe(denied ? "unavailable" : "applied");
      expect(writes).toBe(0);
      if (!due)
        expect(
          requests.some((path) => path.includes("/payment_intents/") || path.includes("/charges/")),
        ).toBeFalse();
      if (!denied) {
        expect(
          (
            await database.query(
              "SELECT granted_amount::text AS amount FROM subscription_allowance_periods WHERE organization_id=$1",
              [f.source.organization_id],
            )
          ).rows,
        ).toEqual([{ amount: "25.000000" }]);
        const { reconcileStripePaidRenewal } = await import(
          "../../../lib/services/stripe-paid-renewal"
        );
        const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
        const event = {
          id: eventId,
          type: "invoice.paid",
          created: Math.floor(Date.now() / 1000),
          livemode: false,
          data: {
            object: { id: f.invoice.id, object: "invoice", billing_reason: "subscription_cycle" },
          },
        };
        await reconcileStripePaidRenewal({
          eventId,
          eventType: "invoice.paid",
          event,
        } as Parameters<typeof reconcileStripePaidRenewal>[0]);
        expect(await allowanceCount(f.source.organization_id)).toBe(1);
        expect(
          (
            await database.query(
              "SELECT count(*)::int AS count FROM subscription_allowance_transactions WHERE organization_id=$1 AND kind='grant'",
              [f.source.organization_id],
            )
          ).rows,
        ).toEqual([{ count: 1 }]);
      }
    });
  }

  for (const channel of ["cron", "webhook"] as const) {
    for (const invalid of [null, "legacy", "account", "credential_mode"] as const) {
      test(`rotated binding ${invalid ?? "preserves purchase"} through ${channel} paid renewal`, async () => {
        const rejected = invalid === "account" || invalid === "credential_mode";
        const f = await seedPurchasedCheckout();
        await database.query("UPDATE organizations SET is_active=false WHERE id<>$1", [f.orgId]);
        const boundary = Math.floor(Date.now() / 1000) + 3;
        // A real month-long purchased period ends shortly after publication; wait
        // for the primary clock rather than fabricating the renewal source.
        const start = boundary - 30 * 86400;
        f.invoice.lines.data[0]!.period = { start, end: boundary };
        f.invoice.status_transitions.paid_at = start + 1;
        f.subscription.current_period_start = start;
        f.subscription.current_period_end = boundary;
        process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_rotated";
        process.env.STRIPE_PLUS_PRODUCT_ID = "prod_rotated";
        try {
          const { finalizeSubscriptionCheckout } = await import(
            "../subscription-checkout-finalization"
          );
          await finalizeSubscriptionCheckout(f);
          expect(await allowanceCount(f.orgId)).toBe(1);
          if (invalid === "legacy") {
            // Preserve actual paid publication, restore pre-column storage, then
            // execute the real migration; this does not run a historical binary.
            await database.exec(
              "DROP TRIGGER preserve_subscription_checkout_contract ON billing_subscription_commands; ALTER TABLE billing_subscription_commands DROP COLUMN checkout_contract;",
            );
            await database.exec(
              await readFile(
                new URL(
                  "../../migrations/0397_subscription_checkout_contract.sql",
                  import.meta.url,
                ),
                "utf8",
              ),
            );
            expect(
              (
                await database.query(
                  "SELECT status,checkout_contract FROM billing_subscription_commands WHERE id=$1",
                  [f.command.id],
                )
              ).rows,
            ).toEqual([{ status: "APPLIED", checkout_contract: null }]);
            process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
            process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
          }
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, boundary * 1000 - Date.now() + 20)),
          );
          const suffix = randomUUID().replaceAll("-", "");
          f.invoice.id = `in_${suffix}`;
          f.invoice.billing_reason = "subscription_cycle";
          f.invoice.payment_intent = `pi_${suffix}`;
          f.invoice.charge = `ch_${suffix}`;
          f.paymentIntent.id = f.invoice.payment_intent;
          f.paymentIntent.latest_charge = f.invoice.charge;
          f.charge.id = f.invoice.charge;
          f.charge.payment_intent = f.invoice.payment_intent;
          f.invoice.lines.data[0]!.period = { start: boundary, end: boundary + 30 * 86400 };
          f.invoice.status_transitions.paid_at = boundary;
          f.paymentIntent.invoice = f.invoice.id;
          f.charge.invoice = f.invoice.id;
          f.subscription.latest_invoice = f.invoice.id;
          f.subscription.current_period_start = boundary;
          f.subscription.current_period_end = boundary + 30 * 86400;
          for (const [path, value] of [
            ["/v1/account", { id: "acct_checkoutfixture" }],
            [
              "/v1/prices/price_rotated",
              { ...f.price, id: "price_rotated", product: "prod_rotated" },
            ],
            ["/v1/products/prod_rotated", { ...f.product, id: "prod_rotated" }],
            [`/v1/customers/${f.customer.id}`, f.customer],
            [`/v1/subscriptions/${f.subscription.id}`, f.subscription],
            [`/v1/invoices/${f.invoice.id}`, f.invoice],
            [`/v1/payment_intents/${f.paymentIntent.id}`, f.paymentIntent],
            [`/v1/charges/${f.charge.id}`, f.charge],
            [`/v1/prices/${f.price.id}`, f.price],
            [`/v1/products/${f.product.id}`, f.product],
          ] as const)
            objects.set(path, value);
          if (invalid === "account") objects.set("/v1/account", { id: "acct_other" });
          let modeChanged = false;
          if (invalid === "credential_mode")
            beforeChargeResponse = async () => {
              process.env.STRIPE_SECRET_KEY = "sk_live_changed";
              modeChanged = true;
            };
          const deliver = async () => {
            if (channel === "cron") {
              await makeDue(f.orgId);
              const result = await service.recoverMissedSubscriptionEvents();
              expect(result.attempts.some((a) => a.disposition === "applied")).toBe(!rejected);
            } else {
              const { reconcileStripePaidRenewal } = await import(
                "../../../lib/services/stripe-paid-renewal"
              );
              const eventId = `evt_${suffix}`;
              // Keep the legacy invoice wire shape; the real SDK constructs the
              // typed event from signed JSON without inventing newer API fields.
              const webhooks = new Stripe("sk_test_renewal_signature_fixture").webhooks;
              const secret = "whsec_renewal_signature_fixture";
              const payload = JSON.stringify({
                id: eventId,
                object: "event",
                api_version: "2025-08-27.basil",
                created: boundary,
                livemode: false,
                pending_webhooks: 0,
                request: null,
                type: "invoice.paid",
                data: { object: f.invoice },
              });
              const signature = await webhooks.generateTestHeaderStringAsync({ payload, secret });
              const event = await webhooks.constructEventAsync(payload, signature, secret);
              await reconcileStripePaidRenewal({
                kind: "stripe.event",
                eventId,
                eventType: "invoice.paid",
                receivedAt: Date.now(),
                event,
              });
            }
          };
          if (rejected && channel === "webhook") await expect(deliver()).rejects.toThrow();
          else await deliver();
          if (invalid === "credential_mode") expect(modeChanged).toBe(true);
          expect(await allowanceCount(f.orgId)).toBe(rejected ? 1 : 2);
          if (!rejected) expect(requests).toContain("GET /v1/prices/price_plus");
          expect(requests).not.toContain("GET /v1/prices/price_rotated");
          expect(writes).toBe(0);
          expect(await sourceRevision(f.command.id)).toBe(rejected ? 1 : 2);
          if (invalid === "legacy") expect(requests).not.toContain("GET /v1/account");
          const periods = await database.query<{
            granted_amount: string;
            stripe_invoice_id: string;
          }>(
            "SELECT granted_amount,stripe_invoice_id FROM subscription_allowance_periods WHERE organization_id=$1 ORDER BY period_start",
            [f.orgId],
          );
          expect(periods.rows.every((period) => period.granted_amount === "25.000000")).toBe(true);
          if (!rejected) expect(periods.rows[1]?.stripe_invoice_id).toBe(f.invoice.id);
          if (invalid === null) {
            const { observeAndRecordRenewalAdjustment } = await import(
              "../subscription-adjustment-observations"
            );
            const grant = (
              await database.query<{ id: string }>(
                "SELECT t.id FROM subscription_allowance_transactions t JOIN subscription_allowance_periods p ON p.id=t.allowance_period_id WHERE t.organization_id=$1 AND p.stripe_invoice_id=$2 AND t.kind='grant'",
                [f.orgId, f.invoice.id],
              )
            ).rows[0]!;
            objects.set("/v1/account", { id: "acct_checkoutfixture", object: "account" });
            objects.set(`/v1/credit_notes?invoice=${f.invoice.id}&limit=100`, {
              object: "list",
              has_more: false,
              data: [],
            });
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Loopback missing");
            const stripe = new Stripe("sk_test_cloud_e2e", {
              host: "127.0.0.1",
              port: address.port,
              protocol: "http",
              maxNetworkRetries: 0,
            });
            const request = {
              organizationId: f.orgId,
              grantId: grant.id,
              requestId: randomUUID(),
              expectedPreviousId: null,
            };
            const fundingSnapshot = async () => ({
              periods: (
                await database.query(
                  "SELECT * FROM subscription_allowance_periods WHERE organization_id=$1 ORDER BY id",
                  [f.orgId],
                )
              ).rows,
              transactions: (
                await database.query(
                  "SELECT * FROM subscription_allowance_transactions WHERE organization_id=$1 ORDER BY id",
                  [f.orgId],
                )
              ).rows,
            });
            const fundingBefore = await fundingSnapshot();
            const first = await observeAndRecordRenewalAdjustment(request, stripe);
            expect(first.replayed).toBe(false);
            expect(first.observation.version).toBe(1);
            const readCount = requests.length;
            expect((await observeAndRecordRenewalAdjustment(request, stripe)).replayed).toBe(true);
            expect(requests.length).toBe(readCount);
            await expect(
              observeAndRecordRenewalAdjustment({ ...request, requestId: randomUUID() }, stripe),
            ).rejects.toThrow();
            const next = { ...request, expectedPreviousId: first.observation.id };
            const attempts = await Promise.allSettled([
              observeAndRecordRenewalAdjustment({ ...next, requestId: randomUUID() }, stripe),
              observeAndRecordRenewalAdjustment({ ...next, requestId: randomUUID() }, stripe),
            ]);
            expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
            expect(
              (
                await database.query(
                  "SELECT version FROM subscription_adjustment_observations WHERE grant_id=$1 ORDER BY version",
                  [grant.id],
                )
              ).rows,
            ).toEqual([{ version: 1 }, { version: 2 }]);
            expect(await allowanceCount(f.orgId)).toBe(2);
            expect(await sourceRevision(f.command.id)).toBe(2);
            expect(await fundingSnapshot()).toEqual(fundingBefore);
            expect(writes).toBe(0);
            const {
              claimRenewalAdjustment,
              failRenewalAdjustment,
              listDueRenewalAdjustmentGrants,
            } = await import("../subscription-adjustment-recovery");
            const work = { organizationId: f.orgId, grantId: grant.id };
            expect(await listDueRenewalAdjustmentGrants(5)).toContainEqual(work);
            const claim = await claimRenewalAdjustment(work);
            if (!claim) throw new Error("Expected initial adjustment claim");
            expect(await claimRenewalAdjustment(work)).toBeNull();
            expect(await listDueRenewalAdjustmentGrants(5)).not.toContainEqual(work);
            const recorded = await observeAndRecordRenewalAdjustment(
              claim.request,
              stripe,
              claim.identity,
            );
            expect(recorded.observation.version).toBe(3);
            const completedReads = requests.length;
            expect(
              (await observeAndRecordRenewalAdjustment(claim.request, stripe, claim.identity))
                .replayed,
            ).toBe(true);
            expect(requests.length).toBe(completedReads);
            expect(await claimRenewalAdjustment(work)).toBeNull();
            await database.query(
              "UPDATE subscription_adjustment_scans SET next_due_at=clock_timestamp() WHERE grant_id=$1",
              [grant.id],
            );
            const expiring = await claimRenewalAdjustment({ ...work, leaseDurationMs: 1000 });
            if (!expiring) throw new Error("Expected expiring adjustment claim");
            let delayed = false;
            const delayedStripe = new Stripe("sk_test_cloud_e2e", {
              host: "127.0.0.1",
              port: address.port,
              protocol: "http",
              maxNetworkRetries: 0,
              httpClient: Stripe.createFetchHttpClient(
                Object.assign(
                  async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                    if (!delayed) {
                      delayed = true;
                      await new Promise((resolve) => setTimeout(resolve, 1100));
                    }
                    return fetch(url, init);
                  },
                  { preconnect: fetch.preconnect },
                ),
              ),
            });
            await expect(
              observeAndRecordRenewalAdjustment(expiring.request, delayedStripe, expiring.identity),
            ).rejects.toThrow();
            expect(delayed).toBe(true);
            const reclaimed = await claimRenewalAdjustment(work);
            if (!reclaimed) throw new Error("Expected expired claim replacement");
            expect(reclaimed.identity.generation).toBe(expiring.identity.generation + 1);
            await expect(
              observeAndRecordRenewalAdjustment(expiring.request, stripe, expiring.identity),
            ).rejects.toThrow();
            expect(
              (
                await observeAndRecordRenewalAdjustment(
                  reclaimed.request,
                  stripe,
                  reclaimed.identity,
                )
              ).observation.version,
            ).toBe(4);
            expect(
              (
                await database.query(
                  "SELECT disposition FROM subscription_adjustment_attempts WHERE grant_id=$1 ORDER BY generation",
                  [grant.id],
                )
              ).rows,
            ).toEqual([
              { disposition: "recorded" },
              { disposition: "superseded" },
              { disposition: "recorded" },
            ]);
            expect(await fundingSnapshot()).toEqual(fundingBefore);
            await database.query(
              "UPDATE subscription_adjustment_scans SET next_due_at=clock_timestamp() WHERE grant_id=$1",
              [grant.id],
            );
            const failed = await claimRenewalAdjustment(work);
            if (!failed) throw new Error("Expected failure-bookkeeping claim");
            await failRenewalAdjustment(failed.identity, "provider_unavailable");
            await expect(
              failRenewalAdjustment(failed.identity, "provider_unavailable"),
            ).rejects.toThrow();
            expect(await claimRenewalAdjustment(work)).toBeNull();
            expect(
              (
                await database.query(
                  "SELECT failures,next_due_at>clock_timestamp() AS delayed FROM subscription_adjustment_scans WHERE grant_id=$1",
                  [grant.id],
                )
              ).rows,
            ).toEqual([{ failures: 1, delayed: true }]);
            const { recoverRenewalAdjustmentObservations } = await import(
              "../../../lib/services/renewal-adjustment-maintenance"
            );
            await database.query(
              "UPDATE subscription_adjustment_scans SET next_due_at=clock_timestamp() WHERE grant_id=$1",
              [grant.id],
            );
            const recovered = await recoverRenewalAdjustmentObservations();
            expect(recovered.attempts).toContainEqual({
              grantId: grant.id,
              attemptId: expect.any(String),
              disposition: "recorded",
            });
            // The original checkout grant lacks later-renewal evidence. It receives
            // an explicit incident/backoff rather than a fabricated provider snapshot.
            expect(recovered.attempts.some((a) => a.disposition === "original_unavailable")).toBe(
              true,
            );
            const afterRecoveryReads = requests.length;
            expect((await recoverRenewalAdjustmentObservations()).attempts).toEqual([]);
            expect(requests.length).toBe(afterRecoveryReads);
            expect(
              (
                await database.query(
                  "SELECT context->>'grantId' AS grant FROM billing_subscription_incidents WHERE organization_id=$1 AND context->>'observedBy'='renewal_adjustment_maintenance'",
                  [f.orgId],
                )
              ).rows.length,
            ).toBe(1);
            await database.query(
              "UPDATE subscription_adjustment_scans SET next_due_at=clock_timestamp() WHERE grant_id=$1",
              [grant.id],
            );
            objects.delete(`/v1/credit_notes?invoice=${f.invoice.id}&limit=100`);
            const unavailable = await recoverRenewalAdjustmentObservations();
            expect(unavailable.status).toBe("degraded");
            expect(unavailable.attempts).toContainEqual({
              grantId: grant.id,
              attemptId: expect.any(String),
              disposition: "unavailable",
            });
            expect(
              (
                await database.query(
                  "SELECT disposition FROM subscription_adjustment_attempts WHERE grant_id=$1 ORDER BY generation DESC LIMIT 1",
                  [grant.id],
                )
              ).rows,
            ).toEqual([{ disposition: "failed" }]);
            expect(
              (
                await database.query(
                  "SELECT context->>'grantId' AS grant FROM billing_subscription_incidents WHERE organization_id=$1 AND context->>'reason'='observation_unavailable'",
                  [f.orgId],
                )
              ).rows,
            ).toEqual([{ grant: grant.id }]);
            objects.set(`/v1/credit_notes?invoice=${f.invoice.id}&limit=100`, {
              object: "list",
              has_more: false,
              data: [],
            });
            expect(await fundingSnapshot()).toEqual(fundingBefore);
            expect(writes).toBe(0);
            // Advance the actual lifecycle through the existing provider recovery,
            // then prove historical-grant observation still runs for a terminal source.
            objects.set(`/v1/subscriptions/${f.subscription.id}`, {
              ...f.subscription,
              status: "canceled",
              canceled_at: Math.floor(Date.now() / 1000),
              ended_at: Math.floor(Date.now() / 1000),
            });
            await makeDue(f.orgId);
            await service.recoverMissedSubscriptionEvents();
            expect(
              (
                await database.query(
                  "SELECT status FROM billing_subscriptions WHERE organization_id=$1",
                  [f.orgId],
                )
              ).rows,
            ).toEqual([{ status: "canceled" }]);
            const terminalFunding = await fundingSnapshot();
            await database.query(
              "UPDATE subscription_adjustment_scans SET next_due_at=clock_timestamp() WHERE grant_id=$1",
              [grant.id],
            );
            expect((await recoverRenewalAdjustmentObservations()).attempts).toContainEqual({
              grantId: grant.id,
              attemptId: expect.any(String),
              disposition: "recorded",
            });
            expect(await fundingSnapshot()).toEqual(terminalFunding);
            const head = (
              await database.query<{ id: string }>(
                "SELECT id FROM subscription_adjustment_observations WHERE grant_id=$1 ORDER BY version DESC LIMIT 1",
                [grant.id],
              )
            ).rows[0]!;
            let fenced = false;
            const fencedStripe = new Stripe("sk_test_cloud_e2e", {
              host: "127.0.0.1",
              port: address.port,
              protocol: "http",
              maxNetworkRetries: 0,
              httpClient: Stripe.createFetchHttpClient(
                Object.assign(
                  async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                    if (!fenced) {
                      fenced = true;
                      await database.query(
                        "UPDATE organizations SET paid_work_fenced_at=clock_timestamp() WHERE id=$1",
                        [f.orgId],
                      );
                    }
                    return fetch(url, init);
                  },
                  { preconnect: fetch.preconnect },
                ),
              ),
            });
            await expect(
              observeAndRecordRenewalAdjustment(
                { ...request, requestId: randomUUID(), expectedPreviousId: head.id },
                fencedStripe,
              ),
            ).rejects.toThrow();
            expect(fenced).toBe(true);
            expect(
              (
                await database.query(
                  "SELECT count(*)::int AS count FROM subscription_adjustment_observations WHERE grant_id=$1",
                  [grant.id],
                )
              ).rows,
            ).toEqual([{ count: 6 }]);
            expect(await fundingSnapshot()).toEqual(terminalFunding);
            await expect(observeAndRecordRenewalAdjustment(request, stripe)).rejects.toThrow();
          }
        } finally {
          process.env.STRIPE_SECRET_KEY = "sk_test_cloud_e2e";
          process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
          process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
        }
      });
    }
  }

  async function makeDue(organizationId: string) {
    await database.query(
      "UPDATE subscription_reconciliation_scans SET next_due_at=clock_timestamp() WHERE organization_id=$1",
      [organizationId],
    );
  }
  function positiveSafeRevision(value: string): number {
    if (!/^[1-9]\d*$/.test(value))
      throw new Error("Database revision is not a canonical positive integer");
    const revision = Number(value);
    if (!Number.isSafeInteger(revision))
      throw new Error("Database revision exceeds the safe integer range");
    return revision;
  }
  async function sourceRevision(subscriptionId: string) {
    const result = await database.query<{ lifecycle_revision: string }>(
      "SELECT lifecycle_revision::text AS lifecycle_revision FROM billing_subscriptions WHERE id=$1",
      [subscriptionId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Subscription fixture source is missing");
    return positiveSafeRevision(row.lifecycle_revision);
  }
  test("concurrent and repeated scans publish one paid allowance and one new revision", async () => {
    const f = await seed();
    const results = await Promise.all([
      service.recoverMissedSubscriptionEvents(),
      service.recoverMissedSubscriptionEvents(),
    ]);
    expect(
      results.flatMap((r) => r.attempts).filter((a) => a.disposition === "applied"),
    ).toHaveLength(1);
    expect(await allowanceCount(f.source.organization_id)).toBe(1);
    expect(await sourceRevision(f.source.id)).toBe(f.source.lifecycle_revision + 1);
    await makeDue(f.source.organization_id);
    expect((await service.recoverMissedSubscriptionEvents()).attempts[0]?.disposition).toBe(
      "no_change",
    );
    expect(await allowanceCount(f.source.organization_id)).toBe(1);
    expect(await sourceRevision(f.source.id)).toBe(f.source.lifecycle_revision + 1);
    expect(writes).toBe(0);
  });
  for (const invalid of [
    "invoice_customer",
    "invoice_subscription",
    "invoice_livemode",
    "payment_customer",
    "charge_not_captured",
    "old_invoice",
  ] as const) {
    test(`${invalid} cannot publish a recovered allowance`, async () => {
      const f = await seed();
      if (invalid === "invoice_customer") f.invoice.customer = "cus_other";
      if (invalid === "invoice_subscription") f.invoice.subscription = "sub_other";
      if (invalid === "invoice_livemode") f.invoice.livemode = true;
      if (invalid === "payment_customer") f.paymentIntent.customer = "cus_other";
      if (invalid === "charge_not_captured") f.charge.captured = false;
      if (invalid === "old_invoice") {
        f.invoice.lines.data[0]!.period.start -= 30 * 86400;
        f.invoice.lines.data[0]!.period.end -= 30 * 86400;
      }
      const result = await service.recoverMissedSubscriptionEvents();
      expect(result.status).toBe("degraded");
      expect(await allowanceCount(f.source.organization_id)).toBe(0);
      expect(await sourceRevision(f.source.id)).toBe(f.source.lifecycle_revision);
      expect(writes).toBe(0);
    });
  }
  test("account deletion fencing during provider reads prevents renewal publication", async () => {
    const f = await seed();
    beforeChargeResponse = async () => {
      await database.query(
        "UPDATE organizations SET paid_work_fenced_at=clock_timestamp() WHERE id=$1",
        [f.source.organization_id],
      );
    };
    const result = await service.recoverMissedSubscriptionEvents();
    expect(result.attempts[0]?.disposition).toBe("deletion_owned");
    expect(await allowanceCount(f.source.organization_id)).toBe(0);
    expect(await sourceRevision(f.source.id)).toBe(f.source.lifecycle_revision);
    expect(writes).toBe(0);
  });

  test("a later invoice-paid delivery preserves append-only original grant evidence", async () => {
    const f = await seed();
    expect((await service.recoverMissedSubscriptionEvents()).status).toBe("ok");
    await expect(
      database.query(
        "UPDATE subscription_allowance_transactions SET metadata='{}'::jsonb WHERE organization_id=$1 AND kind='grant'",
        [f.source.organization_id],
      ),
    ).rejects.toThrow();
    const originalEvidence = (
      await database.query<{ metadata: unknown }>(
        "SELECT metadata FROM subscription_allowance_transactions WHERE organization_id=$1 AND kind='grant'",
        [f.source.organization_id],
      )
    ).rows;
    const { reconcileStripePaidRenewal } = await import(
      "../../../lib/services/stripe-paid-renewal"
    );
    const event: Stripe.InvoicePaidEvent = JSON.parse(
      JSON.stringify({
        id: `evt_${randomUUID().replaceAll("-", "")}`,
        object: "event",
        type: "invoice.paid",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        data: { object: f.invoice },
      }),
    );
    const message = {
      kind: "stripe.event" as const,
      eventId: event.id,
      eventType: event.type,
      event,
      receivedAt: Date.now(),
    };
    await reconcileStripePaidRenewal(message);
    await reconcileStripePaidRenewal(message);
    expect(await allowanceCount(f.source.organization_id)).toBe(1);
    expect(await sourceRevision(f.source.id)).toBe(f.source.lifecycle_revision + 1);
    expect(
      (
        await database.query<{ status: string; disposition: string }>(
          "SELECT status,disposition FROM billing_subscription_event_receipts WHERE organization_id=$1",
          [f.source.organization_id],
        )
      ).rows,
    ).toEqual([{ status: "applied", disposition: "paid_renewal_finalized" }]);
    expect(
      (
        await database.query<{ metadata: unknown }>(
          "SELECT metadata FROM subscription_allowance_transactions WHERE organization_id=$1 AND kind='grant'",
          [f.source.organization_id],
        )
      ).rows,
    ).toEqual(originalEvidence);
    expect(writes).toBe(0);
  });

  test("a webhook winning during recovery reads fences stale publication without a second grant", async () => {
    const f = await seed();
    beforeChargeResponse = async () => {
      const { reconcileStripePaidRenewal } = await import(
        "../../../lib/services/stripe-paid-renewal"
      );
      const event: Stripe.InvoicePaidEvent = JSON.parse(
        JSON.stringify({
          id: `evt_${randomUUID().replaceAll("-", "")}`,
          object: "event",
          type: "invoice.paid",
          created: Math.floor(Date.now() / 1000),
          livemode: false,
          data: { object: f.invoice },
        }),
      );
      await reconcileStripePaidRenewal({
        kind: "stripe.event",
        eventId: event.id,
        eventType: event.type,
        event,
        receivedAt: Date.now(),
      });
    };
    const result = await service.recoverMissedSubscriptionEvents();
    expect(result.attempts[0]?.disposition).toBe("stale");
    expect(await allowanceCount(f.source.organization_id)).toBe(1);
    expect(await sourceRevision(f.source.id)).toBe(f.source.lifecycle_revision + 1);
    expect(writes).toBe(0);
  });

  test("a changed initial provider observation can settle as an existing-grant replay", async () => {
    const fixture = await seed();
    expect((await service.recoverMissedSubscriptionEvents()).status).toBe("ok");
    await makeDue(fixture.source.organization_id);
    objectSequences.set(`/v1/subscriptions/${fixture.subscription.id}`, [
      {
        ...fixture.subscription,
        current_period_end: fixture.subscription.current_period_end + 30 * 86400,
      },
      fixture.subscription,
    ]);
    const result = await service.recoverMissedSubscriptionEvents();
    expect(result.status).toBe("ok");
    expect(result.attempts[0]?.disposition).toBe("no_change");
    expect(await allowanceCount(fixture.source.organization_id)).toBe(1);
    expect(await sourceRevision(fixture.source.id)).toBe(fixture.source.lifecycle_revision + 1);
    const receipt = (
      await database.query<{
        disposition: string;
        result_revision: number | null;
        observed_revision: string;
        observation_digest: string;
      }>(
        "SELECT disposition,result_revision,observed_revision::text AS observed_revision,observation_digest FROM subscription_reconciliation_attempts WHERE organization_id=$1 ORDER BY generation DESC LIMIT 1",
        [fixture.source.organization_id],
      )
    ).rows[0];
    if (!receipt) throw new Error("Recovery fixture receipt is missing");
    expect({
      ...receipt,
      observed_revision: positiveSafeRevision(receipt.observed_revision),
    }).toMatchObject({
      disposition: "no_change",
      result_revision: null,
      observed_revision: fixture.source.lifecycle_revision + 1,
    });
    expect(receipt?.observation_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(objectSequences.get(`/v1/subscriptions/${fixture.subscription.id}`)).toHaveLength(0);
    expect(writes).toBe(0);
  });

  for (const canonicalChanged of [false, true])
    test(`retains original unfunded webhook without funding (later invoice changed=${canonicalChanged})`, async () => {
      const f = await seed();
      Object.assign(f.invoice, {
        amount_paid: 0,
        amount_due: 0,
        payment_intent: null,
        charge: null,
        starting_balance: 0,
        ending_balance: f.invoice.total,
      });
      objects.set("/v1/account", { id: "acct_original", object: "account" });
      const event: Stripe.InvoicePaidEvent = JSON.parse(
        JSON.stringify({
          id: `evt_${randomUUID().replaceAll("-", "")}`,
          object: "event",
          type: "invoice.paid",
          api_version: "2024-11-20.acacia",
          created: Math.floor(Date.now() / 1000),
          livemode: false,
          data: { object: f.invoice },
        }),
      );
      if (canonicalChanged)
        Object.assign(f.invoice, { ending_balance: 0, amount_paid: f.invoice.total });
      const { reconcileStripePaidRenewal } = await import(
        "../../../lib/services/stripe-paid-renewal"
      );
      const message = {
        kind: "stripe.event" as const,
        eventId: event.id,
        eventType: event.type,
        event,
        receivedAt: Date.now(),
      };
      await Promise.all(
        [0, 1].map(() =>
          expect(reconcileStripePaidRenewal(message)).rejects.toMatchObject({
            code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
            context: { reason: "deferred_invoice_observation_retained" },
          }),
        ),
      );
      const records = await database.query<{
        evidence: { event: { data: { object: { ending_balance: number; amount_paid: number } } } };
      }>("SELECT evidence FROM subscription_invoice_event_evidence WHERE organization_id=$1", [
        f.source.organization_id,
      ]);
      expect(records.rows).toHaveLength(1);
      expect(records.rows[0]!.evidence.event.data.object.ending_balance).toBe(
        event.data.object.ending_balance!,
      );
      expect(records.rows[0]!.evidence.event.data.object.amount_paid).toBe(0);
      expect(await allowanceCount(f.source.organization_id)).toBe(0);
      expect(await sourceRevision(f.source.id)).toBe(f.source.lifecycle_revision);
      expect(writes).toBe(0);
      expect(requests.toSorted()).toEqual(
        [
          `GET /v1/invoices/${f.invoice.id}`,
          "GET /v1/account",
          `GET /v1/invoices/${f.invoice.id}`,
          "GET /v1/account",
        ].toSorted(),
      );
    });

  async function retainUnfunded(originalDebit = true, collecting = false, retainPrior = true) {
    const f = await seed();
    Object.assign(
      f.invoice,
      collecting
        ? {
            amount_paid: f.invoice.total + 20,
            amount_due: f.invoice.total + 20,
            starting_balance: 20,
            ending_balance: 0,
          }
        : {
            amount_paid: 0,
            amount_due: 0,
            payment_intent: null,
            charge: null,
            starting_balance: 0,
            ending_balance: f.invoice.total,
          },
    );
    if (collecting) {
      Object.assign(f.paymentIntent, {
        amount: f.invoice.total + 20,
        amount_received: f.invoice.total + 20,
      });
      Object.assign(f.charge, {
        amount: f.invoice.total + 20,
        amount_captured: f.invoice.total + 20,
      });
    }
    objects.set("/v1/account", { id: "acct_original", object: "account" });
    const event: Stripe.InvoicePaidEvent = JSON.parse(
      JSON.stringify({
        id: `evt_${randomUUID().replaceAll("-", "")}`,
        object: "event",
        type: "invoice.paid",
        api_version: "2024-11-20.acacia",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        data: { object: { ...f.invoice, ...(originalDebit ? {} : { ending_balance: 0 }) } },
      }),
    );
    const { reconcileStripePaidRenewal } = await import(
      "../../../lib/services/stripe-paid-renewal"
    );
    await expect(
      reconcileStripePaidRenewal({
        kind: "stripe.event",
        eventId: event.id,
        eventType: event.type,
        event,
        receivedAt: Date.now(),
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE" });
    const priorInvoiceId = collecting ? `in_prior${randomUUID().replaceAll("-", "")}` : undefined;
    const priorSourceId = collecting ? randomUUID() : undefined;
    if (priorInvoiceId && priorSourceId) {
      const priorSubscriptionId = `sub_${priorSourceId.replaceAll("-", "")}`;
      await database.query(
        `INSERT INTO billing_subscriptions SELECT (jsonb_populate_record(NULL::billing_subscriptions,
        to_jsonb(s) || jsonb_build_object('id',$2::text,'status','canceled','stripe_subscription_id',$3::text,
          'stripe_subscription_item_id',$4::text))).* FROM billing_subscriptions s WHERE id=$1`,
        [
          f.source.id,
          priorSourceId,
          priorSubscriptionId,
          `si_${priorSourceId.replaceAll("-", "")}`,
        ],
      );
      const repository = (await import("../subscription-billing-operations"))
        .subscriptionBillingOperationsRepository;
      await repository.createFence({
        organizationId: f.source.organization_id,
        subscriptionId: priorSourceId,
        providerEventId: null,
        providerEventCreatedAt: null,
        providerObjectDigest: "f".repeat(64),
        nextReconcileAt: null,
        now: new Date(),
      });
      const prior = {
        ...f.invoice,
        id: priorInvoiceId,
        subscription: priorSubscriptionId,
        total: 20,
        subtotal: 20,
        starting_balance: 0,
        ending_balance: 20,
        amount_due: 0,
        amount_paid: 0,
        payment_intent: null,
        charge: null,
        status_transitions: { paid_at: f.invoice.status_transitions.paid_at - 1 },
        lines: {
          ...f.invoice.lines,
          data: [
            {
              ...f.invoice.lines.data[0]!,
              id: `il_${priorSourceId.replaceAll("-", "")}`,
              subscription: priorSubscriptionId,
              subscription_item: `si_${priorSourceId.replaceAll("-", "")}`,
              amount: 20,
              period: {
                start: f.invoice.lines.data[0]!.period.start - 100,
                end: f.invoice.lines.data[0]!.period.end - 100,
              },
            },
          ],
        },
      };
      objects.set(`/v1/invoices/${priorInvoiceId}`, prior);
      const priorEvent = JSON.parse(
        JSON.stringify({
          ...event,
          id: `evt_${randomUUID().replaceAll("-", "")}`,
          created: event.created - 1,
          data: { object: prior },
        }),
      );
      if (retainPrior)
        await expect(
          reconcileStripePaidRenewal({
            kind: "stripe.event",
            eventId: priorEvent.id,
            eventType: priorEvent.type,
            event: priorEvent,
            receivedAt: Date.now(),
          }),
        ).rejects.toMatchObject({ code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE" });
    }
    const receipt = (
      await database.query<{ id: string }>(
        "SELECT id FROM billing_subscription_event_receipts WHERE provider_event_id=$1",
        [event.id],
      )
    ).rows[0]!;
    const recovery = await import("../subscription-invoice-event-recovery");
    const operations = (await import("../subscription-billing-operations"))
      .subscriptionBillingOperationsRepository;
    return {
      f,
      priorInvoiceId,
      priorSourceId,
      owner: { organizationId: f.source.organization_id, receiptId: receipt.id },
      recovery,
      operations,
    };
  }
  async function prepareInvoiceObservation(
    beforeRead?: () => Promise<void>,
    collecting = false,
    retainPrior = true,
  ) {
    const original = await retainUnfunded(true, collecting, retainPrior);
    const { f, owner, recovery } = original;
    const claim = (await recovery.claimOriginalInvoiceEvent(owner))!;
    const posting = {
      id: "cbtxn_original",
      object: "customer_balance_transaction",
      customer: f.customer.id,
      invoice: f.invoice.id,
      livemode: false,
      currency: "usd",
      type: collecting ? "applied_to_invoice" : "invoice_too_small",
      amount: collecting ? -20 : f.invoice.total,
      ending_balance: collecting ? 0 : f.invoice.total,
      created: f.invoice.status_transitions.paid_at,
      credit_note: null,
    };
    for (const limit of [100, 1])
      objects.set(`/v1/customers/${f.customer.id}/balance_transactions?limit=${limit}`, {
        object: "list",
        has_more: false,
        data: collecting
          ? [
              posting,
              ...(limit === 100
                ? [
                    {
                      ...posting,
                      id: "cbtxn_prior",
                      invoice: original.priorInvoiceId!,
                      type: "invoice_too_small",
                      amount: 20,
                      ending_balance: 20,
                      created: posting.created - 1,
                    },
                  ]
                : []),
            ]
          : [posting],
      });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback address missing");
    let first = true;
    const stripe = new Stripe("sk_test_cloud_e2e", {
      host: "127.0.0.1",
      port: address.port,
      protocol: "http",
      maxNetworkRetries: 0,
      httpClient: Stripe.createFetchHttpClient(
        Object.assign(
          async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            if (first) {
              first = false;
              await beforeRead?.();
            }
            return fetch(url, init);
          },
          { preconnect: fetch.preconnect },
        ),
      ),
    });
    const journal = await import("../subscription-invoice-observations");
    const input = { ...owner, leaseToken: claim.leaseToken };
    const rows = async () =>
      (
        await database.query(
          "SELECT * FROM subscription_invoice_observations WHERE receipt_id=$1 ORDER BY version",
          [owner.receiptId],
        )
      ).rows;
    return { ...original, claim, input, stripe, journal, rows };
  }
  test("original invoice observations are immutable replayable versions without financial application", async () => {
    const x = await prepareInvoiceObservation();
    const first = await x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe);
    expect(first.replayed).toBe(false);
    expect(first.observation.version).toBe(1);
    expect(first.observation.previous_id).toBeNull();
    const readCount = requests.length;
    expect(
      (await x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe)).observation,
    ).toEqual(first.observation);
    expect(requests).toHaveLength(readCount);
    expect(
      (
        await database.query(
          "SELECT status,lease_token,processed_at,applied_subscription_revision FROM billing_subscription_event_receipts WHERE id=$1",
          [x.owner.receiptId],
        )
      ).rows,
    ).toEqual([
      {
        status: "received",
        lease_token: null,
        processed_at: null,
        applied_subscription_revision: null,
      },
    ]);
    expect(await x.recovery.listDueOriginalInvoiceEvents(5)).toEqual([]);
    await database.query(
      "UPDATE billing_subscription_event_receipts SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
      [x.owner.receiptId],
    );
    const next = (await x.recovery.claimOriginalInvoiceEvent(x.owner))!;
    const replayDuringNewLease = await x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe);
    expect(replayDuringNewLease.observation.id).toBe(first.observation.id);
    expect(
      (
        await database.query(
          "SELECT status,lease_token FROM billing_subscription_event_receipts WHERE id=$1",
          [x.owner.receiptId],
        )
      ).rows,
    ).toEqual([{ status: "processing", lease_token: next.leaseToken }]);
    const second = await x.journal.observeAndRecordOriginalInvoice(
      { ...x.owner, leaseToken: next.leaseToken },
      x.stripe,
    );
    expect(second.observation.version).toBe(2);
    expect(second.observation.previous_id).toBe(first.observation.id);
    expect(
      (await x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe)).observation.id,
    ).toBe(first.observation.id);
    expect(await x.rows()).toHaveLength(2);
    for (const statement of [
      "UPDATE subscription_invoice_observations SET version=version+10 WHERE receipt_id=$1",
      "DELETE FROM subscription_invoice_observations WHERE receipt_id=$1",
    ])
      await expect(database.query(statement, [x.owner.receiptId])).rejects.toThrow();
    expect(await allowanceCount(x.owner.organizationId)).toBe(0);
    expect(writes).toBe(0);
  });
  test("invoice observation database rejects original evidence substitution and a broken version chain", async () => {
    const x = await prepareInvoiceObservation();
    const first = await x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe);
    await database.query(
      "UPDATE billing_subscription_event_receipts SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
      [x.owner.receiptId],
    );
    const next = (await x.recovery.claimOriginalInvoiceEvent(x.owner))!;
    for (const [payload, version, previous] of [
      [
        { ...first.observation.observation, originalEvidenceDigest: "0".repeat(64) },
        2,
        first.observation.id,
      ],
      [first.observation.observation, 3, first.observation.id],
      [first.observation.observation, 2, null],
    ] as const)
      await expect(
        database.query(
          "INSERT INTO subscription_invoice_observations(organization_id,receipt_id,request_id,version,previous_id,observation,observed_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())",
          [
            x.owner.organizationId,
            x.owner.receiptId,
            next.leaseToken,
            version,
            previous,
            JSON.stringify(payload),
          ],
        ),
      ).rejects.toThrow();
    expect(await x.rows()).toHaveLength(1);
    expect(
      (
        await x.journal.observeAndRecordOriginalInvoice(
          { ...x.owner, leaseToken: next.leaseToken },
          x.stripe,
        )
      ).observation.version,
    ).toBe(2);
  });
  test("same invoice observation lease has exactly one publication across concurrent readers", async () => {
    const x = await prepareInvoiceObservation();
    const results = await Promise.all([
      x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe),
      x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe),
    ]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results[0]!.observation.id).toBe(results[1]!.observation.id);
    expect(await x.rows()).toHaveLength(1);
  });
  for (const scenario of [
    "deletion",
    "inactive",
    "lease replacement",
    "lease expiry",
    "terminal receipt",
    "source fence",
  ] as const)
    test(`original invoice publication rejects ${scenario} during provider reads`, async () => {
      const x = await prepareInvoiceObservation(async () => {
        if (scenario === "deletion")
          await database.query(
            "UPDATE organizations SET paid_work_fenced_at=clock_timestamp() WHERE id=$1",
            [x.owner.organizationId],
          );
        if (scenario === "inactive")
          await database.query("UPDATE organizations SET is_active=false WHERE id=$1", [
            x.owner.organizationId,
          ]);
        if (scenario === "lease replacement")
          await database.query(
            "UPDATE billing_subscription_event_receipts SET lease_token=$2 WHERE id=$1",
            [x.owner.receiptId, randomUUID()],
          );
        if (scenario === "lease expiry")
          await database.query(
            "UPDATE billing_subscription_event_receipts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [x.owner.receiptId],
          );
        if (scenario === "terminal receipt")
          await x.operations.failEvent({
            ...x.input,
            status: "quarantined",
            errorCode: "controlled_observation_terminal",
          });
        if (scenario === "source fence") {
          await x.operations.createFence({
            organizationId: x.owner.organizationId,
            subscriptionId: x.f.source.id,
            providerEventId: null,
            providerEventCreatedAt: null,
            providerObjectDigest: "e".repeat(64),
            nextReconcileAt: null,
            now: new Date(),
          });
          await database.query(
            "UPDATE subscription_billing_fences SET state='quarantined',fence_revision=fence_revision+1 WHERE subscription_id=$1",
            [x.f.source.id],
          );
        }
      });
      await expect(
        x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_INVOICE_OBSERVATION_UNAVAILABLE" });
      expect(await x.rows()).toHaveLength(0);
      expect(await allowanceCount(x.owner.organizationId)).toBe(0);
      expect(writes).toBe(0);
    });
  test("invoice observation preserves historical original identity after subscription cancellation and item replacement", async () => {
    const x = await prepareInvoiceObservation();
    await database.query(
      "UPDATE billing_subscriptions SET status='canceled',stripe_subscription_item_id='si_journalreplaced' WHERE id=$1",
      [x.f.source.id],
    );
    const result = await x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe);
    const evidence = result.observation.observation;
    if (evidence.kind !== "retained_invoice_balance_observation")
      throw new Error("Expected balance observation");
    expect(evidence.invoice.lines.data[0]!.subscription_item).toBe(
      x.f.invoice.lines.data[0]!.subscription_item,
    );
    expect(await allowanceCount(x.owner.organizationId)).toBe(0);
  });
  test("invoice observation cannot publish under a foreign owner or unknown lease", async () => {
    const x = await prepareInvoiceObservation();
    const count = requests.length;
    for (const input of [
      { ...x.input, organizationId: randomUUID() },
      { ...x.input, leaseToken: randomUUID() },
    ])
      await expect(
        x.journal.observeAndRecordOriginalInvoice(input, x.stripe),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_INVOICE_OBSERVATION_UNAVAILABLE" });
    expect(requests).toHaveLength(count);
    expect(await x.rows()).toHaveLength(0);
  });
  test("invoice observation insert and receipt release roll back together", async () => {
    const x = await prepareInvoiceObservation();
    await database.exec(`CREATE FUNCTION reject_invoice_observation_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status='processing' AND NEW.status='received' THEN RAISE EXCEPTION 'controlled release failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_invoice_observation_release BEFORE UPDATE ON billing_subscription_event_receipts FOR EACH ROW EXECUTE FUNCTION reject_invoice_observation_release();`);
    try {
      await expect(x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe)).rejects.toThrow();
      expect(await x.rows()).toHaveLength(0);
      expect(
        (
          await database.query(
            "SELECT status,lease_token FROM billing_subscription_event_receipts WHERE id=$1",
            [x.owner.receiptId],
          )
        ).rows,
      ).toEqual([{ status: "processing", lease_token: x.input.leaseToken }]);
    } finally {
      await database.exec(
        "DROP TRIGGER reject_invoice_observation_release ON billing_subscription_event_receipts; DROP FUNCTION reject_invoice_observation_release();",
      );
    }
    expect((await x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe)).replayed).toBe(
      false,
    );
    expect(await x.rows()).toHaveLength(1);
  });
  async function prepareInvoiceMaintenance(collecting = false, retainPrior = true) {
    const x = await prepareInvoiceObservation(undefined, collecting, retainPrior);
    await x.operations.releaseEventForRetry(x.input);
    await database.query(
      "UPDATE billing_subscription_event_receipts SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
      [x.owner.receiptId],
    );
    const { recoverOriginalInvoiceObservations } = await import(
      "../../../lib/services/original-invoice-maintenance"
    );
    return { ...x, recover: recoverOriginalInvoiceObservations };
  }
  test("original invoice maintenance observes terminal unfunded history and backs off without financial application", async () => {
    const x = await prepareInvoiceMaintenance();
    await database.query(
      "UPDATE billing_subscriptions SET status='canceled',stripe_subscription_item_id='si_maintenanceoriginal' WHERE id=$1",
      [x.f.source.id],
    );
    expect(await x.recover()).toMatchObject({
      status: "ok",
      attempts: [{ receiptId: x.owner.receiptId, disposition: "recorded" }],
      deferredByBudget: 0,
    });
    expect(await x.rows()).toHaveLength(1);
    expect((await x.recover()).attempts).toEqual([]);
    expect(
      (
        await database.query(
          "SELECT status,processed_at,applied_subscription_revision FROM billing_subscription_event_receipts WHERE id=$1",
          [x.owner.receiptId],
        )
      ).rows,
    ).toEqual([{ status: "received", processed_at: null, applied_subscription_revision: null }]);
    expect(await allowanceCount(x.owner.organizationId)).toBe(0);
    expect(writes).toBe(0);
  });
  test("capture migration preserves existing balance rows and their immutability", async () => {
    expect(
      (
        await database.query("SELECT * FROM subscription_invoice_observations WHERE id=$1", [
          legacyObservation.id,
        ])
      ).rows,
    ).toEqual([legacyObservation]);
    await expect(
      database.query("UPDATE subscription_invoice_observations SET version=version WHERE id=$1", [
        legacyObservation.id,
      ]),
    ).rejects.toThrow("immutable");
    await expect(
      database.query("DELETE FROM subscription_invoice_observations WHERE id=$1", [
        legacyObservation.id,
      ]),
    ).rejects.toThrow("immutable");
  });
  test("debt migration preserves earlier capture evidence and immutable versions", async () => {
    expect(
      (
        await database.query("SELECT * FROM subscription_invoice_observations WHERE id=$1", [
          legacyCapture.id,
        ])
      ).rows,
    ).toEqual([legacyCapture]);
    await expect(
      database.query("UPDATE subscription_invoice_observations SET version=version WHERE id=$1", [
        legacyCapture.id,
      ]),
    ).rejects.toThrow("immutable");
    await expect(
      database.query("DELETE FROM subscription_invoice_observations WHERE id=$1", [
        legacyCapture.id,
      ]),
    ).rejects.toThrow("immutable");
  });
  for (const fault of ["refund", "missing_payment"] as const)
    test(`collecting maintenance preserves unavailable ${fault} without a balance fallback`, async () => {
      const x = await prepareInvoiceMaintenance(true);
      if (fault === "refund")
        Object.assign(x.f.charge, { refunded: true, amount_refunded: x.f.charge.amount });
      else objects.delete(`/v1/payment_intents/${x.f.paymentIntent.id}`);
      expect(await x.recover()).toMatchObject({
        status: "degraded",
        attempts: expect.arrayContaining([
          { receiptId: x.owner.receiptId, disposition: "unavailable" },
        ]),
      });
      expect(await x.rows()).toHaveLength(0);
      expect(
        (
          await database.query(
            "SELECT id FROM billing_subscription_incidents WHERE event_receipt_id=$1",
            [x.owner.receiptId],
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await database.query(
            "SELECT status FROM billing_subscription_event_receipts WHERE id=$1",
            [x.owner.receiptId],
          )
        ).rows,
      ).toEqual([{ status: "received" }]);
      expect(await allowanceCount(x.owner.organizationId)).toBe(0);
      expect(writes).toBe(0);
    });
  test("capture cannot publish after the receipt lease changes during charge retrieval", async () => {
    const x = await prepareInvoiceObservation(undefined, true);
    const replacement = randomUUID();
    beforeChargeResponse = async () => {
      await database.query(
        "UPDATE billing_subscription_event_receipts SET lease_token=$2 WHERE id=$1",
        [x.owner.receiptId, replacement],
      );
    };
    await expect(
      x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_INVOICE_OBSERVATION_UNAVAILABLE" });
    expect(await x.rows()).toHaveLength(0);
    expect(
      (
        await database.query(
          "SELECT lease_token FROM billing_subscription_event_receipts WHERE id=$1",
          [x.owner.receiptId],
        )
      ).rows,
    ).toEqual([{ lease_token: replacement }]);
  });
  test("collecting capture is journaled and replayed without allowance publication", async () => {
    const x = await prepareInvoiceObservation(undefined, true);
    const result = await x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe);
    const evidence = result.observation.observation;
    expect(evidence.kind).toBe("observed_original_invoice_debt");
    if (evidence.kind !== "observed_original_invoice_debt") throw new Error("Expected capture");
    expect(evidence.capture.payment.id).toBe(x.f.paymentIntent.id);
    expect(evidence.capture.charge.amount_captured).toBe(x.f.invoice.amount_due);
    const count = requests.length;
    expect((await x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe)).replayed).toBe(
      true,
    );
    expect(requests).toHaveLength(count);
    expect(await x.rows()).toHaveLength(1);
    expect(await allowanceCount(x.owner.organizationId)).toBe(0);
    expect(writes).toBe(0);
  });
  test("capture journal rejects foreign nested ownership and replacement payment IDs", async () => {
    const x = await prepareInvoiceObservation(undefined, true);
    const first = await x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe);
    const evidence = first.observation.observation;
    if (evidence.kind !== "observed_original_invoice_debt") throw new Error("Expected capture");
    await database.query(
      "UPDATE billing_subscription_event_receipts SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
      [x.owner.receiptId],
    );
    const next = (await x.recovery.claimOriginalInvoiceEvent(x.owner))!;
    for (const payload of [
      { ...evidence, capture: { ...evidence.capture, organizationId: randomUUID() } },
      { ...evidence, trace: { ...evidence.trace, version: 2 } },
      {
        ...evidence,
        capture: {
          ...evidence.capture,
          balance: { ...evidence.capture.balance, organizationId: randomUUID() },
        },
      },
      {
        ...evidence,
        trace: {
          ...evidence.trace,
          components: evidence.trace.components.map((c) => ({ ...c, amount: c.amount + 1 })),
        },
      },
      {
        ...evidence,
        trace: {
          ...evidence.trace,
          components: evidence.trace.components.map((c) => ({
            ...c,
            subscriptionId: randomUUID(),
          })),
        },
      },
      {
        ...evidence,
        trace: {
          ...evidence.trace,
          components: evidence.trace.components.map((c) => ({
            ...c,
            period: { ...c.period, end: c.period.end + 1 },
          })),
        },
      },
      {
        ...evidence,
        originals: evidence.originals.map((c) => ({
          ...c,
          originalEvidenceDigests: ["0".repeat(64)],
        })),
      },

      {
        ...evidence,
        capture: {
          ...evidence.capture,
          payment: { ...evidence.capture.payment, id: "pi_replacement" },
        },
      },
      {
        ...evidence,
        capture: {
          ...evidence.capture,
          charge: {
            ...evidence.capture.charge,
            amount_captured: evidence.capture.charge.amount_captured + 1,
          },
        },
      },
    ])
      await expect(
        database.query(
          "INSERT INTO subscription_invoice_observations(organization_id,receipt_id,request_id,version,previous_id,observation,observed_at) VALUES($1,$2,$3,2,$4,$5,clock_timestamp())",
          [
            x.owner.organizationId,
            x.owner.receiptId,
            next.leaseToken,
            first.observation.id,
            JSON.stringify(payload),
          ],
        ),
      ).rejects.toThrow();
    expect(await x.rows()).toHaveLength(1);
    expect(
      (
        await x.journal.observeAndRecordOriginalInvoice(
          { ...x.owner, leaseToken: next.leaseToken },
          x.stripe,
        )
      ).observation.version,
    ).toBe(2);
    expect(await allowanceCount(x.owner.organizationId)).toBe(0);
  });
  for (const state of ["quarantined", "open"] as const)
    test(`contributor ${state} fence revision changes during provider reads prevent attribution`, async () => {
      const x = await prepareInvoiceObservation(undefined, true);
      beforeChargeResponse = async () => {
        await database.query(
          "UPDATE subscription_billing_fences SET state=$2,fence_revision=fence_revision+1 WHERE subscription_id=$1",
          [x.priorSourceId, state],
        );
      };
      await expect(
        x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe),
      ).rejects.toMatchObject({
        code:
          state === "open"
            ? "SUBSCRIPTION_INVOICE_OBSERVATION_UNAVAILABLE"
            : "SUBSCRIPTION_INVOICE_DEBT_SOURCES_UNAVAILABLE",
      });
      expect(await x.rows()).toHaveLength(0);
      expect(await allowanceCount(x.owner.organizationId)).toBe(0);
    });
  test("missing retained contributing history cannot be replaced by a current provider invoice", async () => {
    const x = await prepareInvoiceObservation(undefined, true, false);
    await expect(
      x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_INVOICE_DEBT_TRACE_UNAVAILABLE" });
    expect(await x.rows()).toHaveLength(0);
    expect(await allowanceCount(x.owner.organizationId)).toBe(0);
  });
  test("maintenance retains a missing-debt incident without falling back to capture-only success", async () => {
    const x = await prepareInvoiceMaintenance(true, false);
    expect(await x.recover()).toMatchObject({
      status: "degraded",
      attempts: [{ receiptId: x.owner.receiptId, disposition: "unavailable" }],
    });
    expect(await x.rows()).toHaveLength(0);
    expect(
      (
        await database.query(
          "SELECT id FROM billing_subscription_incidents WHERE event_receipt_id=$1",
          [x.owner.receiptId],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await database.query(
          "SELECT status,processed_at FROM billing_subscription_event_receipts WHERE id=$1",
          [x.owner.receiptId],
        )
      ).rows,
    ).toEqual([{ status: "received", processed_at: null }]);
    expect(await allowanceCount(x.owner.organizationId)).toBe(0);
    expect((await x.recover()).attempts).toEqual([]);
  });
  test("unrelated retained invoice with a closed source fence does not block traced contributors", async () => {
    const x = await prepareInvoiceObservation(undefined, true);
    const id = randomUUID(),
      providerId = `sub_${id.replaceAll("-", "")}`,
      invoiceId = `in_${id.replaceAll("-", "")}`;
    await database.query(
      `INSERT INTO billing_subscriptions SELECT (jsonb_populate_record(NULL::billing_subscriptions,
      to_jsonb(s) || jsonb_build_object('id',$2::text,'status','canceled','stripe_subscription_id',$3::text,
        'stripe_subscription_item_id',$4::text))).* FROM billing_subscriptions s WHERE id=$1`,
      [x.f.source.id, id, providerId, `si_${id.replaceAll("-", "")}`],
    );
    const prior = objects.get(`/v1/invoices/${x.priorInvoiceId}`)! as typeof x.f.invoice;
    const invoice = {
      ...prior,
      id: invoiceId,
      subscription: providerId,
      lines: {
        ...prior.lines,
        data: [
          {
            ...prior.lines.data[0]!,
            subscription: providerId,
            subscription_item: `si_${id.replaceAll("-", "")}`,
          },
        ],
      },
    };
    objects.set(`/v1/invoices/${invoiceId}`, invoice);
    const event = JSON.parse(
      JSON.stringify({
        id: `evt_${id.replaceAll("-", "")}`,
        object: "event",
        type: "invoice.paid",
        api_version: "2024-11-20.acacia",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        data: { object: invoice },
      }),
    );
    const { reconcileStripePaidRenewal } = await import(
      "../../../lib/services/stripe-paid-renewal"
    );
    await expect(
      reconcileStripePaidRenewal({
        kind: "stripe.event",
        eventId: event.id,
        eventType: event.type,
        event,
        receivedAt: Date.now(),
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE" });
    await x.operations.createFence({
      organizationId: x.owner.organizationId,
      subscriptionId: id,
      providerEventId: null,
      providerEventCreatedAt: null,
      providerObjectDigest: "f".repeat(64),
      nextReconcileAt: null,
      now: new Date(),
    });
    await database.query(
      "UPDATE subscription_billing_fences SET state='quarantined',fence_revision=fence_revision+1 WHERE subscription_id=$1",
      [id],
    );
    const result = await x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe);
    expect(result.observation.observation.kind).toBe("observed_original_invoice_debt");
    if (result.observation.observation.kind !== "observed_original_invoice_debt")
      throw new Error("Expected debt attribution");
    expect(result.observation.observation.originals.map((row) => row.invoiceId)).toEqual([
      x.priorInvoiceId!,
    ]);
    expect(await allowanceCount(x.owner.organizationId)).toBe(0);
  });
  test("saved attribution replay rechecks its contributing subscription fence without provider reads", async () => {
    const x = await prepareInvoiceObservation(undefined, true);
    await x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe);
    const count = requests.length;
    await database.query(
      "UPDATE subscription_billing_fences SET state='quarantined',fence_revision=fence_revision+1 WHERE subscription_id=$1",
      [x.priorSourceId],
    );
    await expect(
      x.journal.observeAndRecordOriginalInvoice(x.input, x.stripe),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_INVOICE_DEBT_SOURCES_UNAVAILABLE" });
    expect(requests).toHaveLength(count);
    expect(await x.rows()).toHaveLength(1);
  });
  test("maintenance records collecting capture through the original receipt lane", async () => {
    const x = await prepareInvoiceMaintenance(true);
    expect(await x.recover()).toMatchObject({
      status: "ok",
      attempts: expect.arrayContaining([{ receiptId: x.owner.receiptId, disposition: "recorded" }]),
    });
    expect((await x.rows())[0]!.observation).toMatchObject({
      kind: "observed_original_invoice_debt",
    });
    expect(await allowanceCount(x.owner.organizationId)).toBe(0);
    expect(writes).toBe(0);
  });
  test("original invoice maintenance bounds each run to five claims and leaves remaining work discoverable", async () => {
    const entries = [];
    for (let i = 0; i < 6; i++) entries.push(await prepareInvoiceMaintenance());
    const first = await entries[0]!.recover();
    expect(first.attempts).toHaveLength(5);
    expect(first.attempts.every((a) => a.disposition === "recorded")).toBe(true);
    const second = await entries[0]!.recover();
    expect(second.attempts).toHaveLength(1);
    expect(second.attempts[0]!.disposition).toBe("recorded");
    for (const x of entries) {
      expect(await x.rows()).toHaveLength(1);
      expect(await allowanceCount(x.owner.organizationId)).toBe(0);
    }
    expect(writes).toBe(0);
  });
  test("unavailable original invoice records one durable incident and does not starve a later candidate", async () => {
    const unavailable = await prepareInvoiceMaintenance();
    const valid = await prepareInvoiceMaintenance();
    objects.delete(`/v1/invoices/${unavailable.f.invoice.id}`);
    const first = await valid.recover();
    expect(first.status).toBe("degraded");
    expect(first.attempts).toContainEqual({
      receiptId: unavailable.owner.receiptId,
      disposition: "unavailable",
    });
    expect(first.attempts).toContainEqual({
      receiptId: valid.owner.receiptId,
      disposition: "recorded",
    });
    expect(await unavailable.rows()).toHaveLength(0);
    expect(await valid.rows()).toHaveLength(1);
    expect((await valid.recover()).attempts).toEqual([]);
    await database.query(
      "UPDATE billing_subscription_event_receipts SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
      [unavailable.owner.receiptId],
    );
    expect((await valid.recover()).attempts).toContainEqual({
      receiptId: unavailable.owner.receiptId,
      disposition: "unavailable",
    });
    const incidents = (
      await database.query(
        "SELECT subscription_id,event_receipt_id,context FROM billing_subscription_incidents WHERE event_receipt_id=$1",
        [unavailable.owner.receiptId],
      )
    ).rows;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      subscription_id: unavailable.f.source.id,
      event_receipt_id: unavailable.owner.receiptId,
      context: { reason: "observation_unavailable", observedBy: "original_invoice_maintenance" },
    });
    expect(writes).toBe(0);
  });
  test("original invoice maintenance cannot release a superseding receipt lease", async () => {
    const x = await prepareInvoiceMaintenance();
    const replacement = randomUUID();
    beforeInvoiceResponse = async () => {
      await database.query(
        "UPDATE billing_subscription_event_receipts SET lease_token=$2 WHERE id=$1",
        [x.owner.receiptId, replacement],
      );
    };
    expect(await x.recover()).toMatchObject({
      status: "degraded",
      attempts: [{ receiptId: x.owner.receiptId, disposition: "lease_lost" }],
    });
    expect(await x.rows()).toHaveLength(0);
    expect(
      (
        await database.query(
          "SELECT status,lease_token FROM billing_subscription_event_receipts WHERE id=$1",
          [x.owner.receiptId],
        )
      ).rows,
    ).toEqual([{ status: "processing", lease_token: replacement }]);
    expect(await allowanceCount(x.owner.organizationId)).toBe(0);
  });
  test("original invoice maintenance surfaces journal infrastructure failure without false unavailable evidence", async () => {
    const x = await prepareInvoiceMaintenance();
    await database.exec(`CREATE FUNCTION reject_maintenance_invoice_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled database outage'; END $$;
      CREATE TRIGGER reject_maintenance_invoice_journal BEFORE INSERT ON subscription_invoice_observations FOR EACH ROW EXECUTE FUNCTION reject_maintenance_invoice_journal();`);
    try {
      await expect(x.recover()).rejects.toThrow();
      expect(await x.rows()).toHaveLength(0);
      expect(
        (
          await database.query(
            "SELECT id FROM billing_subscription_incidents WHERE event_receipt_id=$1",
            [x.owner.receiptId],
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await database.query(
            "SELECT status FROM billing_subscription_event_receipts WHERE id=$1",
            [x.owner.receiptId],
          )
        ).rows,
      ).toEqual([{ status: "processing" }]);
    } finally {
      await database.exec(
        "DROP TRIGGER reject_maintenance_invoice_journal ON subscription_invoice_observations; DROP FUNCTION reject_maintenance_invoice_journal();",
      );
    }
  });
  test("original invoice discovery includes terminal sources and replaced current items without a grant", async () => {
    const { f, owner, recovery } = await retainUnfunded();
    await database.query(
      "UPDATE billing_subscriptions SET status='canceled',stripe_subscription_item_id='si_replaced' WHERE id=$1",
      [f.source.id],
    );
    expect(await recovery.listDueOriginalInvoiceEvents(5)).toEqual([owner]);
    const claim = await recovery.claimOriginalInvoiceEvent(owner);
    expect(claim?.evidence.event.data.object.lines.data[0]?.subscription_item).toBe(
      f.invoice.lines.data[0]!.subscription_item,
    );
    expect(await allowanceCount(owner.organizationId)).toBe(0);
    expect(writes).toBe(0);
  });
  test("original invoice claims share one existing receipt lease across concurrent workers", async () => {
    const { owner, recovery } = await retainUnfunded();
    const claims = await Promise.all([
      recovery.claimOriginalInvoiceEvent(owner),
      recovery.claimOriginalInvoiceEvent(owner),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.attempt).toBe(1);
    expect(await recovery.listDueOriginalInvoiceEvents(5)).toEqual([]);
    expect(
      await recovery.claimOriginalInvoiceEvent({ ...owner, organizationId: randomUUID() }),
    ).toBeNull();
  });
  test("original invoice retry backoff uses the existing receipt counter and database time", async () => {
    const { owner, recovery, operations } = await retainUnfunded();
    const first = (await recovery.claimOriginalInvoiceEvent(owner))!;
    await operations.releaseEventForRetry(first);
    expect(await recovery.listDueOriginalInvoiceEvents(5)).toEqual([]);
    expect(await recovery.claimOriginalInvoiceEvent(owner)).toBeNull();
    await database.query(
      "UPDATE billing_subscription_event_receipts SET updated_at=clock_timestamp()-interval '61 seconds' WHERE id=$1",
      [owner.receiptId],
    );
    expect(await recovery.listDueOriginalInvoiceEvents(5)).toEqual([owner]);
    const second = (await recovery.claimOriginalInvoiceEvent(owner))!;
    expect(second.attempt).toBe(2);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    await operations.releaseEventForRetry(first);
    expect(await recovery.claimOriginalInvoiceEvent(owner)).toBeNull();
  });
  test("expired original invoice lease is reclaimed without mutating retained evidence", async () => {
    const { owner, recovery } = await retainUnfunded();
    const first = (await recovery.claimOriginalInvoiceEvent(owner))!;
    await database.query(
      "UPDATE billing_subscription_event_receipts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [owner.receiptId],
    );
    const second = (await recovery.claimOriginalInvoiceEvent(owner))!;
    expect(second.evidence).toEqual(first.evidence);
    expect(second.attempt).toBe(2);
    expect(second.leaseToken).not.toBe(first.leaseToken);
  });
  for (const field of ["paid_work_fenced_at", "is_active"] as const)
    test(`original invoice recovery respects organization ${field}`, async () => {
      const { owner, recovery } = await retainUnfunded();
      await database.query(
        `UPDATE organizations SET ${field}=${field === "is_active" ? "false" : "clock_timestamp()"} WHERE id=$1`,
        [owner.organizationId],
      );
      expect(await recovery.listDueOriginalInvoiceEvents(5)).toEqual([]);
      expect(await recovery.claimOriginalInvoiceEvent(owner)).toBeNull();
    });
  test("original invoice recovery respects an independent subscription billing fence", async () => {
    const { f, owner, recovery, operations } = await retainUnfunded();
    await operations.createFence({
      organizationId: owner.organizationId,
      subscriptionId: f.source.id,
      providerEventId: null,
      providerEventCreatedAt: null,
      providerObjectDigest: "f".repeat(64),
      nextReconcileAt: null,
      now: new Date(),
    });
    expect(await recovery.listDueOriginalInvoiceEvents(5)).toEqual([owner]);
    await database.query(
      "UPDATE subscription_billing_fences SET state='quarantined',fence_revision=fence_revision+1 WHERE organization_id=$1",
      [owner.organizationId],
    );
    expect(await recovery.listDueOriginalInvoiceEvents(5)).toEqual([]);
    expect(await recovery.claimOriginalInvoiceEvent(owner)).toBeNull();
  });
  test("original invoice fences stay bound to their subscription when an organization has multiple sources", async () => {
    const { f, owner, recovery, operations } = await retainUnfunded();
    const otherId = randomUUID();
    await database.query(
      `INSERT INTO billing_subscriptions SELECT (jsonb_populate_record(NULL::billing_subscriptions,
        to_jsonb(s) || jsonb_build_object('id',$2::text,'status','canceled',
          'stripe_subscription_id',$3::text,'stripe_subscription_item_id',$4::text))).*
        FROM billing_subscriptions s WHERE id=$1`,
      [
        f.source.id,
        otherId,
        `sub_${otherId.replaceAll("-", "")}`,
        `si_${otherId.replaceAll("-", "")}`,
      ],
    );
    for (const subscriptionId of [f.source.id, otherId])
      await operations.createFence({
        organizationId: owner.organizationId,
        subscriptionId,
        providerEventId: null,
        providerEventCreatedAt: null,
        providerObjectDigest: "f".repeat(64),
        nextReconcileAt: null,
        now: new Date(),
      });
    expect(await recovery.listDueOriginalInvoiceEvents(5)).toEqual([owner]);
    await database.query(
      "UPDATE subscription_billing_fences SET state='quarantined',fence_revision=fence_revision+1 WHERE subscription_id=$1",
      [f.source.id],
    );
    expect(await recovery.listDueOriginalInvoiceEvents(5)).toEqual([]);
    expect(await recovery.claimOriginalInvoiceEvent(owner)).toBeNull();
  });
  test("original invoice discovery excludes terminal receipt outcomes", async () => {
    const { owner, recovery, operations } = await retainUnfunded();
    const claim = (await recovery.claimOriginalInvoiceEvent(owner))!;
    await operations.failEvent({
      ...claim,
      status: "quarantined",
      errorCode: "controlled_quarantine",
    });
    expect(await recovery.listDueOriginalInvoiceEvents(5)).toEqual([]);
    expect(await recovery.claimOriginalInvoiceEvent(owner)).toBeNull();
  });
  test("original invoice recovery cannot infer original debt from a later provider balance", async () => {
    const { owner, recovery } = await retainUnfunded(false);
    expect(await recovery.listDueOriginalInvoiceEvents(5)).toEqual([]);
    expect(await recovery.claimOriginalInvoiceEvent(owner)).toBeNull();
  });
  test("original invoice discovery and claim bounds fail explicitly", async () => {
    const { owner, recovery } = await retainUnfunded();
    for (const limit of [0, 6, 1.5, Number.NaN])
      await expect(recovery.listDueOriginalInvoiceEvents(limit)).rejects.toMatchObject({
        code: "SUBSCRIPTION_INVOICE_RECOVERY_UNAVAILABLE",
      });
    for (const leaseDurationMs of [0, 60_001])
      await expect(
        recovery.claimOriginalInvoiceEvent({ ...owner, leaseDurationMs }),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_INVOICE_RECOVERY_UNAVAILABLE" });
  });

  return {
    seed,
    retainUnfunded,
    prepareInvoiceObservation,
    recover: () => service.recoverMissedSubscriptionEvents(),
    allowanceCount,
    sourceRevision,
    makeDue,
    writes: () => writes,
    beforeChargeResponse: (action: () => Promise<void>) => {
      beforeChargeResponse = action;
    },
  };
}
