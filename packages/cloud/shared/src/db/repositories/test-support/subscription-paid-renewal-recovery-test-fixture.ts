/** Defines the shared real-database recovery contract with an actual Stripe SDK loopback boundary; adapters own database lifecycle only. */
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type Stripe from "stripe";
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
