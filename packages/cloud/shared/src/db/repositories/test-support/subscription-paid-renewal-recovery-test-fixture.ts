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
  let writes = 0;
  let beforeChargeResponse: (() => Promise<void>) | null = null;
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method !== "GET") writes++;
    response.setHeader("Content-Type", "application/json");
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
    service = await import("../../../lib/services/subscription-reconciliation");
  });
  beforeEach(async () => {
    await database.exec("UPDATE organizations SET is_active=false");
    objects.clear();
    objectSequences.clear();
    requests.length = 0;
    writes = 0;
    beforeChargeResponse = null;
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
  test("missed paid renewal heals through the existing cron without a webhook delivery", async () => {
    const f = await seed();
    expect(await allowanceCount(f.source.organization_id)).toBe(0);
    const result = await service.recoverMissedSubscriptionEvents();
    expect(await allowanceCount(f.source.organization_id)).toBe(1);
    expect(result.status).toBe("ok");
    expect(result.attempts[0]?.disposition).toBe("applied");
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

  test("a later invoice-paid delivery reuses the recovered grant", async () => {
    const f = await seed();
    expect((await service.recoverMissedSubscriptionEvents()).status).toBe("ok");
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

  return {
    seed,
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
