/** Provider-observed upgrade review through migrated authority and quote persistence. No live requests. */
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
    events: {
      list: async () => ({
        object: "list",
        has_more: false,
        data: [
          {
            id: `evt_${fixtureData.input.subscriptionId.replaceAll("-", "")}`,
            object: "event",
            type: "invoice.created",
            api_version: "2024-11-20.acacia",
            created: objects.rawInvoice.created,
            livemode: false,
            request: { id: `req_${schema.replaceAll("_", "")}`, idempotency_key: originalKey },
            data: { object: objects.rawInvoice },
          },
        ],
      }),
    },
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
          ? {
              ...objects.rawInvoice,
              paid: false,
              status: "open",
              amount_paid: 0,
              amount_remaining: 3500,
            }
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

    async function expiredLease(commandId: string) {
      await db.query(
        "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [commandId],
      );
    }
    test("lost-response recovery attributes original event and finalizes without another POST", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await expiredLease(f.identity.commandId);
      const { reconcileOriginalOrganizationUpgrade: recover } = await import(
        "./organization-upgrade-recovery"
      );
      const result = await recover(f.identity);
      expect(result.status).toBe("applied");
      expect(mutation).toHaveBeenCalledTimes(1);
      expect((await state(f.identity.commandId)).status).toBe("APPLIED");
    });
    test("actor revocation does not prevent original paid recovery", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
      await expiredLease(f.identity.commandId);
      const { reconcileOriginalOrganizationUpgrade: recover } = await import(
        "./organization-upgrade-recovery"
      );
      expect((await recover(f.identity)).status).toBe("applied");
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("unpaid original invoice stays unknown through read-only recovery", async () => {
      const f = await seed();
      pending = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await expiredLease(f.identity.commandId);
      const { reconcileOriginalOrganizationUpgrade: recover } = await import(
        "./organization-upgrade-recovery"
      );
      expect(await recover(f.identity)).toEqual({ status: "pending", reason: "awaiting_payment" });
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect(mutation).toHaveBeenCalledTimes(1);
      expect(
        (
          await db.query("SELECT lease_token FROM billing_subscription_commands WHERE id=$1", [
            f.identity.commandId,
          ])
        ).rows[0].lease_token,
      ).toBeNull();
    });
    test("live original lease cannot be stolen by recovery", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      const { reconcileOriginalOrganizationUpgrade: recover } = await import(
        "./organization-upgrade-recovery"
      );
      expect((await recover(f.identity)).status).toBe("pending");
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect(mutation).toHaveBeenCalledTimes(1);
    });

    test("stale recovery lease cannot release the replacement owner", async () => {
      const f = await seed();
      pending = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await expiredLease(f.identity.commandId);
      const { claimOrganizationUpgradePaidReconciliation: claim } = await import(
        "../../db/repositories/organization-upgrade-finalization"
      );
      const first = await claim(f.identity);
      if (!first) throw new Error("Missing first recovery lease");
      await expiredLease(f.identity.commandId);
      const second = await claim(f.identity);
      if (!second) throw new Error("Missing second recovery lease");
      const { releaseOrganizationUpgradeRecovery: release } = await import(
        "../../db/repositories/organization-upgrade-recovery-release"
      );
      expect(
        await release({
          ...f.identity,
          leaseToken: first.command.lease_token!,
          executionGeneration: first.command.execution_generation,
        }),
      ).toBe(false);
      expect(
        await release({
          ...f.identity,
          leaseToken: second.command.lease_token!,
          executionGeneration: second.command.execution_generation,
        }),
      ).toBe(true);
      expect((await state(f.identity.commandId)).dispatch).toBe("started");
    });
    test("repeated recovery returns immutable applied result without fresh provider reads", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await expiredLease(f.identity.commandId);
      const { reconcileOriginalOrganizationUpgrade: recover } = await import(
        "./organization-upgrade-recovery"
      );
      const original = await recover(f.identity);
      expect(original.status).toBe("applied");
      objects.rawInvoice.id = "in_wrong";
      const replay = await recover(f.identity);
      expect(replay).toEqual(original);
      expect(mutation).toHaveBeenCalledTimes(1);
    });

    test("failed original-event search releases only its lease and retains started unknown", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await expiredLease(f.identity.commandId);
      originalKey = "foreign-request-key";
      const { reconcileOriginalOrganizationUpgrade: recover } = await import(
        "./organization-upgrade-recovery"
      );
      await expect(recover(f.identity)).rejects.toThrow();
      const row = (
        await db.query(
          "SELECT status,lease_token,attempt_count,organization_upgrade_dispatch_state AS dispatch FROM billing_subscription_commands WHERE id=$1",
          [f.identity.commandId],
        )
      ).rows[0];
      expect(row).toEqual({
        status: "OUTCOME_UNKNOWN",
        lease_token: null,
        attempt_count: 2,
        dispatch: "started",
      });
      expect(mutation).toHaveBeenCalledTimes(1);
    });

    test("recovery incidents deduplicate and only applied authority resolves them", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      const { recordOrganizationUpgradeRecoveryOutcome: record } = await import(
        "../../db/repositories/organization-upgrade-recovery-incidents"
      );
      const issue = { ...f.identity, issueCode: "UPGRADE_RECOVERY_UNAVAILABLE" };
      expect((await record(issue)).recorded).toBe(true);
      await record(issue);
      expect((await record({ ...issue, issueCode: null })).resolved).toBe(0);
      const incidents = await db.query(
        "SELECT occurrence_count,status,context FROM billing_subscription_incidents WHERE command_id=$1",
        [f.identity.commandId],
      );
      expect(incidents.rows).toHaveLength(1);
      expect(incidents.rows[0].occurrence_count).toBe(2);
      expect(incidents.rows[0].status).toBe("open");
      expect(incidents.rows[0].context).toEqual({
        owner: "organization_upgrade_recovery",
        code: "UPGRADE_RECOVERY_UNAVAILABLE",
      });
      await expiredLease(f.identity.commandId);
      const { reconcileOriginalOrganizationUpgrade: recover } = await import(
        "./organization-upgrade-recovery"
      );
      expect((await recover(f.identity)).status).toBe("applied");
      expect((await record({ ...issue, issueCode: null })).resolved).toBe(1);
      expect((await record(issue)).recorded).toBe(false);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM billing_subscription_incidents WHERE command_id=$1 AND status='open'",
            [f.identity.commandId],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    test("incident ownership rejects foreign tenant and unbounded raw error content", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      const { recordOrganizationUpgradeRecoveryOutcome: record } = await import(
        "../../db/repositories/organization-upgrade-recovery-incidents"
      );
      await expect(
        record({ ...f.identity, organizationId: randomUUID(), issueCode: "UPGRADE_UNAVAILABLE" }),
      ).rejects.toThrow();
      await expect(
        record({ ...f.identity, issueCode: "raw provider body must not be stored" }),
      ).rejects.toThrow();
    });

    test("maintenance records failure and resolves it after a later paid recovery", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      const original = originalKey;
      originalKey = "unattributed-request";
      await db.query(
        "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second',updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
        [f.identity.commandId],
      );
      const { recoverOrganizationUpgrades: run } = await import(
        "./organization-upgrade-maintenance"
      );
      const failed = await run(5);
      expect(failed.unavailable).toBe(1);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM billing_subscription_incidents WHERE command_id=$1 AND status='open'",
            [f.identity.commandId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect((await run(5)).inspected).toBe(0);
      originalKey = original;
      await db.query(
        "UPDATE billing_subscription_commands SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
        [f.identity.commandId],
      );
      expect((await run(5)).applied).toBe(1);
      expect(
        (
          await db.query("SELECT status FROM billing_subscription_incidents WHERE command_id=$1", [
            f.identity.commandId,
          ])
        ).rows[0].status,
      ).toBe("resolved");
      expect(mutation).toHaveBeenCalledTimes(1);
    });
  },
);
