/** Full internal dispatch through PostgreSQL authority with a synthetic provider. No live requests. */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { upgradePaidObjects } from "../../db/repositories/organization-upgrade-paid-test-fixture";
import { installOrganizationUpgradeTestSchema } from "../../db/repositories/organization-upgrade-test-fixture";
import { seedCancellationTestAccount } from "../../db/repositories/subscription-cancellation-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `upgrade_dispatch_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
let afterWrite = async () => {};
let writeFailure = false;
let pending = false;
let objects: ReturnType<typeof upgradePaidObjects>;
let dispatched = false;
let originalKey = "";

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
mock.module("../stripe", () => ({
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

let close: typeof import("../../db/client").closeDatabaseConnectionsForTests;
let dispatch: typeof import("./organization-upgrade-dispatch").dispatchOrganizationUpgrade;
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
  const { createOrganizationUpgradeQuote } = await import("./organization-upgrade-preview");
  const quote = await createOrganizationUpgradeQuote(
    { ...fixtureData.input, targetPlanKey: "pro_monthly" },
    async () => {},
  );
  const { readOrganizationPlanChangeSource } = await import(
    "../../db/repositories/organization-plan-change"
  );
  const captured = await readOrganizationPlanChangeSource(fixtureData.input);
  const { writeTransaction } = await import("../../db/helpers");
  const { subscriptionAllowanceRepository } = await import(
    "../../db/repositories/subscription-allowance"
  );
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
  const { prepareOrganizationUpgrade } = await import(
    "../../db/repositories/organization-upgrade-commands"
  );
  const { claimOrganizationUpgrade } = await import(
    "../../db/repositories/organization-upgrade-execution"
  );
  const { command } = await prepareOrganizationUpgrade({ ...fixtureData.input, quoteId: quote.id });
  originalKey = command.provider_idempotency_key;
  const identity = { ...fixtureData.input, commandId: command.id };
  const claim = await claimOrganizationUpgrade(identity);
  if (!claim) throw new Error("Missing claim");
  return { identity, claim, quote };
}
async function state(commandId: string) {
  return (
    await db.query(
      "SELECT status,organization_upgrade_dispatch_state AS dispatch FROM billing_subscription_commands WHERE id=$1",
      [commandId],
    )
  ).rows[0];
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
      ({ closeDatabaseConnectionsForTests: close } = await import("../../db/client"));
      ({ dispatchOrganizationUpgrade: dispatch } = await import("./organization-upgrade-dispatch"));
    }, 120000);
    afterAll(async () => {
      if (db) {
        await close?.();
        await db.query(`DROP SCHEMA ${schema} CASCADE`);
        await db.end();
      }
      mock.restore();
    });
    test("one provider attempt saves original receipt and publishes paid source and allowance", async () => {
      const f = await seed();
      const result = await dispatch(f.identity, f.claim, async () => {});
      expect(result.command.status).toBe("APPLIED");
      expect(mutation).toHaveBeenCalledTimes(1);
      expect(mutation.mock.calls[0]![2].idempotencyKey).toBe(originalKey);
      const receipt = await db.query(
        "SELECT invoice_id FROM organization_upgrade_invoice_origins WHERE command_id=$1",
        [f.identity.commandId],
      );
      expect(receipt.rows[0].invoice_id).toBe(objects.rawInvoice.id);
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("lost update response retains started unknown and never repeats the write", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow(
        "Lost provider response",
      );
      expect(await state(f.identity.commandId)).toEqual({
        status: "OUTCOME_UNKNOWN",
        dispatch: "started",
      });
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("pending payment retains original invoice without publishing paid source", async () => {
      const f = await seed();
      pending = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      expect(await state(f.identity.commandId)).toEqual({
        status: "OUTCOME_UNKNOWN",
        dispatch: "started",
      });
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM organization_upgrade_invoice_origins WHERE command_id=$1",
            [f.identity.commandId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await db.query("SELECT plan_key FROM billing_subscriptions WHERE id=$1", [
            f.identity.subscriptionId,
          ])
        ).rows[0].plan_key,
      ).toBe("plus_monthly");
    });
    test("manager revocation during preview prevents dispatch", async () => {
      const f = await seed();
      afterPreview = async () => {
        await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
      };
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      expect(mutation).not.toHaveBeenCalled();
      expect((await state(f.identity.commandId)).dispatch).toBe("ready");
    });
    test("actor removal after provider effect does not discard paid financial publication", async () => {
      const f = await seed();
      afterWrite = async () => {
        await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
      };
      const result = await dispatch(f.identity, f.claim, async () => {});
      expect(result.command.status).toBe("APPLIED");
      expect(mutation).toHaveBeenCalledTimes(1);
    });
  },
);
