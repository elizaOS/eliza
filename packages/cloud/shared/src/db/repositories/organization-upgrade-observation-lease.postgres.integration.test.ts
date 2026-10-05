/** Provider-observed upgrade review through migrated authority and quote persistence. No live requests. */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { upgradePaidObjects } from "./organization-upgrade-paid-test-fixture";
import { installOrganizationUpgradeTestSchema } from "./organization-upgrade-test-fixture";
import { seedCancellationTestAccount } from "./subscription-cancellation-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `upgrade_dispatch_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
let afterWrite = async () => {};
let writeFailure = false;
let pending = false;
let objects: ReturnType<typeof upgradePaidObjects>;
let dispatched = false;

process.env.ENVIRONMENT = "local";
process.env.STRIPE_SECRET_KEY = ["sk", "test", "upgradepreview"].join("_");
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
let fixtureData: Awaited<ReturnType<typeof seedCancellationTestAccount>>;
let afterPreview = async () => {};
let afterCustomer = async () => {};
let corrupt = (value: Record<string, unknown>) => value;
const mutation = mock(
  async (_id: string, _params: unknown, options: { idempotencyKey: string }) => {
    dispatched = true;
    if (writeFailure) throw new Error("Lost provider response");
    await afterWrite();
    const response = { ...objects.rawSubscription, latest_invoice: objects.rawInvoice };
    Object.defineProperty(response, "lastResponse", {
      enumerable: false,
      value: {
        requestId: `req_${schema.replaceAll("_", "")}`,
        statusCode: 200,
        apiVersion: "2024-11-20.acacia",
        idempotencyKey: options.idempotencyKey,
      },
    });
    return response;
  },
);
const preview = mock(
  async (
    input: { preview_mode: string; subscription_details: { proration_date?: number } },
    _options: unknown,
  ) => {
    const recurring = input.preview_mode === "recurring";
    const source = fixtureData.source;
    const start =
      input.subscription_details.proration_date ??
      Math.floor(source.current_period_end.getTime() / 1000);
    const line = (price: string, amount: number) => ({
      id: `il_${price}`,
      type: "subscription",
      subscription: source.stripe_subscription_id,
      subscription_item: source.stripe_subscription_item_id,
      price: { id: price },
      quantity: 1,
      currency: "usd",
      amount,
      discount_amounts: [],
      tax_amounts: [],
      period: {
        start,
        end: recurring
          ? start + 30 * 86400
          : Math.floor(source.current_period_end.getTime() / 1000),
      },
      proration: !recurring,
    });
    const total = recurring ? 10000 : 3500;
    const invoice = {
      id: "upcoming_in_upgrade",
      object: "invoice",
      status: "draft",
      livemode: false,
      customer: source.stripe_customer_id,
      subscription: source.stripe_subscription_id,
      currency: "usd",
      charge: null,
      payment_intent: null,
      paid: false,
      paid_out_of_band: false,
      amount_paid: 0,
      amount_due: total,
      billing_reason: "subscription_update",
      subtotal: total,
      subtotal_excluding_tax: total,
      total,
      tax: 0,
      total_discount_amounts: [],
      total_tax_amounts: [],
      period_start: start,
      period_end: Math.floor(source.current_period_end.getTime() / 1000),
      hosted_invoice_url: null,
      collection_method: "charge_automatically",
      on_behalf_of: null,
      transfer_data: null,
      application_fee_amount: null,
      starting_balance: 0,
      automatic_tax: { enabled: false, status: null },
      lines: {
        has_more: false,
        data: recurring
          ? [line("price_pro", 10000)]
          : [line("price_plus", -1500), line("price_pro", 5000)],
      },
    };
    if (recurring) await afterPreview();
    return corrupt(invoice);
  },
);
mock.module("../../lib/stripe", () => ({
  requireStripe: () => ({
    customers: {
      retrieve: async () => {
        await afterCustomer();
        return { id: fixtureData.source.stripe_customer_id, object: "customer", livemode: false };
      },
    },
    subscriptions: {
      retrieve: async () => (dispatched ? objects.rawSubscription : fixtureData.provider),
      update: mutation,
    },
    invoices: {
      createPreview: preview,
      retrieve: async (id: string) => {
        if (id !== objects.rawInvoice.id) throw new Error("Wrong invoice");
        return pending
          ? { ...objects.rawInvoice, paid: false, status: "open", amount_paid: 0 }
          : objects.rawInvoice;
      },
    },
    prices: {
      retrieve: async (id: string) => ({
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
    },
    products: { retrieve: async () => ({ active: true, deleted: false, livemode: false }) },
  }),
}));

let close: typeof import("../client").closeDatabaseConnectionsForTests;
let dispatch: typeof import("../../lib/services/organization-upgrade-dispatch").dispatchOrganizationUpgrade;
async function seed() {
  fixtureData = await seedCancellationTestAccount((q, v) => db.query(q, v));
  dispatched = false;
  pending = false;
  writeFailure = false;
  afterWrite = async () => {};
  afterPreview = async () => {};
  afterCustomer = async () => {};
  corrupt = (x) => x;
  mutation.mockClear();
  preview.mockClear();
  const { createOrganizationUpgradeQuote } = await import(
    "../../lib/services/organization-upgrade-preview"
  );
  const quote = await createOrganizationUpgradeQuote(
    { ...fixtureData.input, targetPlanKey: "pro_monthly" },
    async () => {},
  );
  const { readOrganizationPlanChangeSource } = await import("./organization-plan-change");
  const captured = await readOrganizationPlanChangeSource(fixtureData.input);
  const { writeTransaction } = await import("../helpers");
  const { subscriptionAllowanceRepository } = await import("./subscription-allowance");
  await writeTransaction((tx) =>
    subscriptionAllowanceRepository.grantRenewalInTransaction(tx, {
      source: captured.source,
      invoiceId: `in_base${schema.replaceAll("_", "")}${fixtureData.input.subscriptionId.replaceAll("-", "")}`,
      requestDigest: "a".repeat(64),
      databaseNow: new Date(),
    }),
  );
  objects = upgradePaidObjects({
    ...fixtureData,
    captured,
    review: quote.review,
    providerBinding: quote.provider_binding!,
  });
  objects.rawInvoice.id = `in_${fixtureData.input.subscriptionId.replaceAll("-", "")}`;
  const { prepareOrganizationUpgrade } = await import("./organization-upgrade-commands");
  const { claimOrganizationUpgrade } = await import("./organization-upgrade-execution");
  const { command } = await prepareOrganizationUpgrade({ ...fixtureData.input, quoteId: quote.id });
  const identity = { ...fixtureData.input, commandId: command.id };
  const claim = await claimOrganizationUpgrade(identity);
  if (!claim) throw new Error("Missing claim");
  return { identity, claim, quote };
}
(url ? describe : describe.skip)(
  "original upgrade provider execution with PostgreSQL authority",
  () => {
    beforeAll(async () => {
      db = new Client({ connectionString: url });
      await db.connect();
      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`SET search_path TO ${schema},public`);
      await installOrganizationUpgradeTestSchema((q) => db.query(q));
      const target = new URL(url!);
      target.searchParams.set("options", `-c search_path=${schema},public`);
      process.env.DATABASE_URL = target.toString();
      process.env.TEST_DATABASE_URL = target.toString();
      process.env.LOCAL_PG_POOL_MAX = "4";
      ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
      ({ dispatchOrganizationUpgrade: dispatch } = await import(
        "../../lib/services/organization-upgrade-dispatch"
      ));
    }, 120000);
    afterAll(async () => {
      if (db) {
        await close?.();
        await db.query(`DROP SCHEMA ${schema} CASCADE`);
        await db.end();
      }
      mock.restore();
    });

    async function releaseOld(commandId: string) {
      await db.query(
        "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second',updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
        [commandId],
      );
    }
    test("missing original receipt still permits one exclusive read-only recovery lease", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await releaseOld(f.identity.commandId);
      const { claimOrganizationUpgradeObservation: claim } = await import(
        "./organization-upgrade-observation-lease"
      );
      const results = await Promise.all([claim(f.identity), claim(f.identity)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.find(Boolean)?.canDispatch).toBe(false);
      expect(results.find(Boolean)?.command.execution_generation).toBe(
        f.claim.command.execution_generation + 1,
      );
    });
    test("ready commands and foreign tenants have no system observation lease", async () => {
      const f = await seed();
      const { claimOrganizationUpgradeObservation: claim } = await import(
        "./organization-upgrade-observation-lease"
      );
      await releaseOld(f.identity.commandId);
      expect(await claim(f.identity)).toBeNull();
      expect(await claim({ ...f.identity, organizationId: randomUUID() })).toBeNull();
    });
    test("due selection honors active leases and exponential retry delay", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      const { listOrganizationUpgradeRecovery: list } = await import(
        "./organization-upgrade-observation-lease"
      );
      expect((await list(25)).some((x) => x.id === f.identity.commandId)).toBe(false);
      await releaseOld(f.identity.commandId);
      expect((await list(25)).some((x) => x.id === f.identity.commandId)).toBe(true);
      await db.query(
        "UPDATE billing_subscription_commands SET attempt_count=8,updated_at=clock_timestamp()-interval '59 minutes' WHERE id=$1",
        [f.identity.commandId],
      );
      expect((await list(25)).some((x) => x.id === f.identity.commandId)).toBe(false);
      await db.query(
        "UPDATE billing_subscription_commands SET updated_at=clock_timestamp()-interval '61 minutes' WHERE id=$1",
        [f.identity.commandId],
      );
      expect((await list(25)).some((x) => x.id === f.identity.commandId)).toBe(true);
    });
    test("deletion-fenced organization cannot claim observation", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await releaseOld(f.identity.commandId);
      await db.query("UPDATE organizations SET paid_work_fenced_at=clock_timestamp() WHERE id=$1", [
        f.identity.organizationId,
      ]);
      const { claimOrganizationUpgradeObservation: claim, listOrganizationUpgradeRecovery: list } =
        await import("./organization-upgrade-observation-lease");
      expect(await claim(f.identity)).toBeNull();
      expect((await list(25)).some((x) => x.id === f.identity.commandId)).toBe(false);
    });
  },
);
