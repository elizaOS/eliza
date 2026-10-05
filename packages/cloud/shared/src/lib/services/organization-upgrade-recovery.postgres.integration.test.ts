/** Provider-observed upgrade review through migrated authority and quote persistence. No live requests. */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { upgradePaidObjects } from "../../db/repositories/organization-upgrade-paid-test-fixture";
import { installOrganizationUpgradeTestSchema } from "../../db/repositories/organization-upgrade-test-fixture";
import { seedCancellationTestAccount } from "../../db/repositories/subscription-cancellation-test-fixture";
import { renewalPaidObjects } from "../../db/repositories/subscription-renewal-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `upgrade_dispatch_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
let afterWrite = async () => {};
let writeFailure = false;
let pending = false;
let renewal: ReturnType<typeof renewalPaidObjects> | null = null;
let objects: ReturnType<typeof upgradePaidObjects>;
let dispatched = false;
let originalKey = "";
let voidIntent: unknown = null;
let historicalTargetEvent: unknown = null;
let afterTargetSearch = async () => {};
let afterSubscriptionRead = async () => {};

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
      list: async (input: { types?: string[] }) => {
        if (input.types) await afterTargetSearch();
        return input.types
          ? {
              object: "list",
              has_more: false,
              data: historicalTargetEvent ? [historicalTargetEvent] : [],
            }
          : {
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
                  request: {
                    id: `req_${schema.replaceAll("_", "")}`,
                    idempotency_key: originalKey,
                  },
                  data: { object: objects.rawInvoice },
                },
              ],
            };
      },
    },
    customers: {
      retrieve: async () => {
        await afterCustomer();
        return { id: fixtureData.source.stripe_customer_id, object: "customer", livemode: false };
      },
    },
    subscriptions: {
      retrieve: async () => {
        if (dispatched) await afterSubscriptionRead();
        return dispatched ? objects.rawSubscription : fixtureData.provider;
      },
      update: mutation,
    },
    invoices: {
      createPreview: preview,
      retrieve: async (id: string) => {
        if (renewal?.invoice.id === id) return renewal.invoice;
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
    paymentIntents: {
      retrieve: async (id: string) =>
        id === objects.rawInvoice.payment_intent && voidIntent
          ? voidIntent
          : renewal?.paymentIntent,
    },
    charges: { retrieve: async () => renewal?.charge },
    prices: {
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
    },
    products: {
      retrieve: async (id: string) => ({ id, active: true, deleted: false, livemode: false }),
    },
  }),
}));

let close: typeof import("../../db/client").closeDatabaseConnectionsForTests;
let dispatch: typeof import("./organization-upgrade-dispatch").dispatchOrganizationUpgrade;
async function seed(period?: { start: Date; end: Date }) {
  fixtureData = await seedCancellationTestAccount((q, v) => db.query(q, v), period);
  historicalTargetEvent = null;
  voidIntent = null;
  renewal = null;
  afterTargetSearch = async () => {};
  afterSubscriptionRead = async () => {};
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
      const reconciliationMigration = await readFile(
        new URL("../../db/migrations/0385_subscription_reconciliation.sql", import.meta.url),
        "utf8",
      );
      for (const statement of reconciliationMigration.split("--> statement-breakpoint"))
        if (statement.trim()) await db.query(statement);

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
    async function publicCandidate() {
      const f = await seed();
      const { releaseOrganizationUpgrade } = await import(
        "../../db/repositories/organization-upgrade-execution"
      );
      await releaseOrganizationUpgrade(f.identity, f.claim);
      return {
        ...f,
        confirm: {
          organizationId: f.identity.organizationId,
          actorId: f.identity.actorId,
          quoteId: f.quote.id,
          idempotencyKey: f.identity.idempotencyKey,
        },
      };
    }
    async function paymentCandidate() {
      const f = await publicCandidate();
      pending = true;
      const { confirmOrganizationSubscriptionUpgrade } = await import(
        "./organization-upgrade-command"
      );
      const command = await confirmOrganizationSubscriptionUpgrade(f.confirm, async () => {});
      expect(command.status).toBe("OUTCOME_UNKNOWN");
      const paidObjects = structuredClone(objects);
      Object.assign(objects.rawInvoice, {
        status: "open",
        paid: false,
        amount_paid: 0,
        amount_remaining: 3500,
        charge: null,
        hosted_invoice_url: "https://invoice.stripe.com/i/acct_fixture/test_original?s=private",
        status_transitions: { ...objects.rawInvoice.status_transitions, paid_at: null },
      });
      objects.rawSubscription = structuredClone({
        ...fixtureData.provider,
        collection_method: "charge_automatically",
      });
      Object.assign(objects.rawSubscription, {
        pending_update: {
          billing_cycle_anchor: null,
          expires_at: f.quote.review.prorationDate + 3600,
          subscription_items: [
            { id: fixtureData.source.stripe_subscription_item_id, price: "price_pro", quantity: 1 },
          ],
          trial_end: null,
          trial_from_plan: false,
        },
      });
      voidIntent = {
        object: "payment_intent",
        id: objects.rawInvoice.payment_intent,
        invoice: objects.rawInvoice.id,
        customer: objects.rawInvoice.customer,
        livemode: false,
        currency: "usd",
        status: "requires_action",
        amount: 3500,
        amount_received: 0,
        amount_capturable: 0,
        capture_method: "automatic",
        canceled_at: null,
        on_behalf_of: null,
        transfer_data: null,
        application_fee_amount: null,
        client_secret: "pi_synthetic_secret_private",
      };
      return { ...f, paidObjects };
    }
    test("original payment continuation never redispatches and return reconciles once", async () => {
      const f = await paymentCandidate();
      const { continueOrganizationSubscriptionUpgradePayment: resume } = await import(
        "./organization-upgrade-payment"
      );
      const result = await resume(f.identity, async () => {});
      expect(result.command.status).toBe("OUTCOME_UNKNOWN");
      expect(result.continuation?.kind).toBe("hosted_invoice");
      expect(result.continuation?.paymentState).toBe("requires_action");
      expect(Object.keys(result.continuation!).sort()).toEqual([
        "amountDueCents",
        "currency",
        "expiresAt",
        "hostedInvoiceUrl",
        "kind",
        "paymentState",
      ]);
      expect(JSON.stringify(result)).not.toContain("pi_synthetic_secret_private");
      expect(mutation).toHaveBeenCalledTimes(1);
      objects = f.paidObjects;
      pending = false;
      const complete = await resume(f.identity, async () => {});
      expect(complete.command.status).toBe("APPLIED");
      expect(complete.continuation).toBeNull();
      expect(await resume(f.identity, async () => {})).toEqual(complete);
      expect(mutation).toHaveBeenCalledTimes(1);
    }, 20000);
    test("billing-manager revocation during provider reads prevents link release", async () => {
      const f = await paymentCandidate();
      const { continueOrganizationSubscriptionUpgradePayment: resume } = await import(
        "./organization-upgrade-payment"
      );
      afterSubscriptionRead = async () => {
        await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
      };
      await expect(resume(f.identity, async () => {})).rejects.toMatchObject({
        code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN",
      });
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("session revocation after observations prevents private continuation response", async () => {
      const f = await paymentCandidate();
      const { continueOrganizationSubscriptionUpgradePayment: resume } = await import(
        "./organization-upgrade-payment"
      );
      let checks = 0;
      const revoked = new Error("Session revoked");
      await expect(
        resume(f.identity, async () => {
          if (++checks > 1) throw revoked;
        }),
      ).rejects.toBe(revoked);
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("concurrent paid finalization returns durable completion instead of a stale link", async () => {
      const f = await paymentCandidate();
      const { continueOrganizationSubscriptionUpgradePayment: resume } = await import(
        "./organization-upgrade-payment"
      );
      const { reconcileOriginalOrganizationUpgrade: recover } = await import(
        "./organization-upgrade-recovery"
      );
      afterSubscriptionRead = async () => {
        afterSubscriptionRead = async () => {};
        objects = f.paidObjects;
        pending = false;
        await recover(f.identity);
      };
      const result = await resume(f.identity, async () => {});
      expect(result.command.status).toBe("APPLIED");
      expect(result.continuation).toBeNull();
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("pending expiry during provider reads withholds the payment link", async () => {
      const f = await paymentCandidate();
      const { continueOrganizationSubscriptionUpgradePayment: resume } = await import(
        "./organization-upgrade-payment"
      );
      afterSubscriptionRead = async () => {
        Object.assign(objects.rawSubscription, {
          pending_update: {
            billing_cycle_anchor: null,
            expires_at: Math.floor(Date.now() / 1000),
            subscription_items: [
              {
                id: fixtureData.source.stripe_subscription_item_id,
                price: "price_pro",
                quantity: 1,
              },
            ],
            trial_end: null,
            trial_from_plan: false,
          },
        });
      };
      await expect(resume(f.identity, async () => {})).rejects.toMatchObject({
        code: "SUBSCRIPTION_UPGRADE_PAYMENT_UNAVAILABLE",
      });
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("provider exceptions cannot expose the private payment URL", async () => {
      const f = await paymentCandidate();
      const { continueOrganizationSubscriptionUpgradePayment: resume } = await import(
        "./organization-upgrade-payment"
      );
      afterSubscriptionRead = async () => {
        throw new Error("https://invoice.stripe.com/i/private_secret");
      };
      let failure: unknown;
      try {
        await resume(f.identity, async () => {});
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "SUBSCRIPTION_UPGRADE_PAYMENT_UNAVAILABLE" });
      expect(String(failure)).not.toContain("private_secret");
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("foreign tenant cannot initiate payment continuation provider reads", async () => {
      const f = await paymentCandidate();
      const { continueOrganizationSubscriptionUpgradePayment: resume } = await import(
        "./organization-upgrade-payment"
      );
      const read = mock(async () => {});
      afterSubscriptionRead = read;
      await expect(
        resume({ ...f.identity, organizationId: randomUUID() }, async () => {}),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN" });
      expect(read).not.toHaveBeenCalled();
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("public confirmation applies once and status exposes only durable public fields", async () => {
      const f = await publicCandidate();
      const {
        confirmOrganizationSubscriptionUpgrade: confirm,
        readOrganizationSubscriptionUpgrade: read,
      } = await import("./organization-upgrade-command");
      const result = await confirm(f.confirm, async () => {});
      expect(result.status).toBe("APPLIED");
      expect(result.dispatchState).toBe("started");
      expect(Object.keys(result).sort()).toEqual([
        "commandId",
        "dispatchState",
        "expectedSubscriptionRevision",
        "failure",
        "resultSubscriptionRevision",
        "status",
        "subscriptionId",
        "targetPlanKey",
      ]);
      expect(await confirm({ ...f.confirm, idempotencyKey: randomUUID() }, async () => {})).toEqual(
        result,
      );
      expect(await read(f.identity, async () => {})).toEqual(result);
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("concurrent public confirmations dispatch the original quote only once", async () => {
      const f = await publicCandidate();
      const { confirmOrganizationSubscriptionUpgrade: confirm } = await import(
        "./organization-upgrade-command"
      );
      const results = await Promise.all([
        confirm(f.confirm, async () => {}),
        confirm({ ...f.confirm, idempotencyKey: randomUUID() }, async () => {}),
      ]);
      expect(results.some((x) => x.status === "APPLIED")).toBe(true);
      expect(new Set(results.map((x) => x.commandId)).size).toBe(1);
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("changed preview requires review before any public dispatch", async () => {
      const f = await publicCandidate();
      corrupt = (x) => ({ ...x, amount_due: 999 });
      const { confirmOrganizationSubscriptionUpgrade: confirm } = await import(
        "./organization-upgrade-command"
      );
      expect(await confirm(f.confirm, async () => {})).toMatchObject({
        status: "FAILED",
        dispatchState: "ready",
        failure: "review_required",
      });
      expect(mutation).not.toHaveBeenCalled();
    });
    test("revocation after dispatch does not undo an applied effect or reveal its result", async () => {
      const f = await publicCandidate();
      afterWrite = async () => {
        await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
      };
      const { confirmOrganizationSubscriptionUpgrade: confirm } = await import(
        "./organization-upgrade-command"
      );
      await expect(confirm(f.confirm, async () => {})).rejects.toMatchObject({
        code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN",
      });
      expect((await state(f.identity.commandId)).status).toBe("APPLIED");
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("public lost-response retry reconciles the original command without another mutation", async () => {
      const f = await publicCandidate();
      const { confirmOrganizationSubscriptionUpgrade: confirm } = await import(
        "./organization-upgrade-command"
      );
      writeFailure = true;
      const first = await confirm(f.confirm, async () => {});
      expect(first.status).toBe("OUTCOME_UNKNOWN");
      expect(first.failure).toBeNull();
      expect((await confirm(f.confirm, async () => {})).status).toBe("APPLIED");
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("public confirmation retains pending payment instead of reporting failure or resubmitting", async () => {
      const f = await publicCandidate();
      pending = true;
      const { confirmOrganizationSubscriptionUpgrade: confirm } = await import(
        "./organization-upgrade-command"
      );
      expect((await confirm(f.confirm, async () => {})).status).toBe("OUTCOME_UNKNOWN");
      expect((await confirm(f.confirm, async () => {})).status).toBe("OUTCOME_UNKNOWN");
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("public pre-dispatch session revocation retires only its ready intent and preserves the auth error", async () => {
      const f = await publicCandidate();
      const { confirmOrganizationSubscriptionUpgrade: confirm } = await import(
        "./organization-upgrade-command"
      );
      let calls = 0;
      await expect(
        confirm(f.confirm, async () => {
          if (++calls === 2) {
            await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
            throw new Error("session revoked");
          }
        }),
      ).rejects.toThrow("session revoked");
      expect(await state(f.identity.commandId)).toEqual({ status: "FAILED", dispatch: "ready" });
      expect(mutation).not.toHaveBeenCalled();
    });
    test("public status requires current tenant authority and final session validation", async () => {
      const f = await publicCandidate();
      const { readOrganizationSubscriptionUpgrade: read } = await import(
        "./organization-upgrade-command"
      );
      await expect(
        read(f.identity, async () => {
          throw new Error("expired session");
        }),
      ).rejects.toThrow("expired session");
      const other = await publicCandidate();
      await expect(
        read({ ...other.identity, commandId: f.identity.commandId }, async () => {}),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_UPGRADE_NOT_FOUND" });
      await db.query("UPDATE users SET role='member' WHERE id=$1", [other.identity.actorId]);
      await expect(read(other.identity, async () => {})).rejects.toMatchObject({
        code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN",
      });
      expect(mutation).not.toHaveBeenCalled();
    });

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
    async function voidOriginal(period?: { start: Date; end: Date }) {
      const f = await seed(period);
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await expiredLease(f.identity.commandId);
      Object.assign(objects.rawInvoice, {
        status: "void",
        paid: false,
        amount_paid: 0,
        amount_remaining: 3500,
        status_transitions: {
          finalized_at: objects.rawInvoice.created,
          paid_at: null,
          voided_at: objects.rawInvoice.created,
          marked_uncollectible_at: null,
        },
      });
      objects.rawSubscription = {
        ...structuredClone(fixtureData.provider),
        collection_method: "charge_automatically",
      };
      voidIntent = {
        id: objects.rawInvoice.payment_intent,
        object: "payment_intent",
        invoice: objects.rawInvoice.id,
        customer: fixtureData.source.stripe_customer_id,
        livemode: false,
        currency: "usd",
        status: "canceled",
        amount_received: 0,
        amount_capturable: 0,
        canceled_at: objects.rawInvoice.created,
        on_behalf_of: null,
        transfer_data: null,
        application_fee_amount: null,
      };
      return f;
    }
    async function financialState() {
      const org = fixtureData.input.organizationId;
      const result: unknown[] = [];
      for (const table of [
        "billing_subscriptions",
        "billing_subscription_revisions",
        "organization_entitlements",
        "subscription_allowance_periods",
        "subscription_allowance_transactions",
      ])
        result.push(
          (
            await db.query(
              `SELECT to_jsonb(t) AS value FROM ${table} t WHERE organization_id=$1 ORDER BY to_jsonb(t)::text`,
              [org],
            )
          ).rows,
        );
      return result;
    }
    test("original void closes incident, preserves money and authority, replays immutably, and releases renewal hold", async () => {
      const f = await voidOriginal();
      const { recordOrganizationUpgradeRecoveryOutcome: record } = await import(
        "../../db/repositories/organization-upgrade-recovery-incidents"
      );
      await record({ ...f.identity, issueCode: "UPGRADE_RECOVERY_UNAVAILABLE" });
      const before = await financialState();
      const { reconcileOriginalOrganizationUpgrade: recover } = await import(
        "./organization-upgrade-recovery"
      );
      expect((await recover(f.identity)).status).toBe("failed");
      expect(await financialState()).toEqual(before);
      expect((await state(f.identity.commandId)).status).toBe("FAILED");
      expect(
        (
          await db.query("SELECT status FROM billing_subscription_incidents WHERE command_id=$1", [
            f.identity.commandId,
          ])
        ).rows,
      ).toEqual([{ status: "resolved" }]);
      expect((await recover(f.identity)).status).toBe("failed");
      const { reconcileOrganizationUpgradesBeforeRenewal: beforeRenewal } = await import(
        "./organization-upgrade-renewal-ordering"
      );
      await beforeRenewal({
        organizationId: f.identity.organizationId,
        subscriptionId: fixtureData.source.id,
      });
      expect(await financialState()).toEqual(before);
      for (const change of [
        "organization_upgrade_failure_evidence=NULL",
        "status='OUTCOME_UNKNOWN',completed_at=NULL,error_code=NULL,provider_response_digest=NULL,organization_upgrade_failure_evidence=NULL",
        "organization_upgrade_failure_evidence=jsonb_set(organization_upgrade_failure_evidence,'{invoiceId}','\"in_other\"')",
      ])
        await expect(
          db.query(`UPDATE billing_subscription_commands SET ${change} WHERE id=$1`, [
            f.identity.commandId,
          ]),
        ).rejects.toThrow();
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    for (const [label, corruptVoid] of [
      [
        "payment still processing",
        () => {
          Object.assign(voidIntent as object, { status: "processing" });
        },
      ],
      [
        "payment received",
        () => {
          Object.assign(voidIntent as object, { amount_received: 1 });
        },
      ],
      [
        "foreign intent",
        () => {
          Object.assign(voidIntent as object, { customer: "cus_other" });
        },
      ],
      [
        "source price changed",
        () => {
          objects.rawSubscription.items.data[0]!.price.id = "price_pro";
        },
      ],
      [
        "pending update",
        () => {
          Object.assign(objects.rawSubscription, { pending_update: {} });
        },
      ],
      [
        "scheduled cancellation",
        () => {
          objects.rawSubscription.cancel_at_period_end = true;
        },
      ],
      [
        "creation changed",
        () => {
          objects.rawInvoice.created--;
        },
      ],
    ] as const)
      test(`void refuses ${label}`, async () => {
        const f = await voidOriginal();
        // Retain the original attribution before corrupting the fresh provider response.
        const { reconcileOrganizationUpgradeInvoiceEvent } = await import(
          "./organization-upgrade-invoice-event"
        );
        await reconcileOrganizationUpgradeInvoiceEvent(invoiceDelivery("invoice.created"));
        corruptVoid();
        const before = await financialState();
        const { reconcileOriginalOrganizationUpgrade: recover } = await import(
          "./organization-upgrade-recovery"
        );
        await expect(recover(f.identity)).rejects.toThrow();
        expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
        expect(await financialState()).toEqual(before);
        expect(mutation).toHaveBeenCalledTimes(1);
      });

    test("void without a PaymentIntent requires no unattributed charge", async () => {
      const f = await voidOriginal();
      Object.assign(objects.rawInvoice, { payment_intent: null, charge: null });
      const { reconcileOriginalOrganizationUpgrade: recover } = await import(
        "./organization-upgrade-recovery"
      );
      expect((await recover(f.identity)).status).toBe("failed");
      expect(
        (
          await db.query(
            "SELECT organization_upgrade_failure_evidence->'paymentIntentId' AS intent FROM billing_subscription_commands WHERE id=$1",
            [f.identity.commandId],
          )
        ).rows,
      ).toEqual([{ intent: null }]);
      const g = await voidOriginal();
      Object.assign(objects.rawInvoice, { payment_intent: null });
      await expect(recover(g.identity)).rejects.toMatchObject({
        context: { reason: "unattributed_payment_evidence" },
      });
    });

    test("void proof and incident resolution roll back together", async () => {
      const f = await voidOriginal();
      const { recordOrganizationUpgradeRecoveryOutcome: record } = await import(
        "../../db/repositories/organization-upgrade-recovery-incidents"
      );
      await record({ ...f.identity, issueCode: "UPGRADE_RECOVERY_UNAVAILABLE" });
      await db.query(
        "CREATE FUNCTION reject_void_incident_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='resolved' THEN RAISE EXCEPTION 'fixture incident resolution failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_void_incident_fixture BEFORE UPDATE ON billing_subscription_incidents FOR EACH ROW EXECUTE FUNCTION reject_void_incident_fixture();",
      );
      const before = await financialState();
      const { reconcileOriginalOrganizationUpgrade: recover } = await import(
        "./organization-upgrade-recovery"
      );
      try {
        await expect(recover(f.identity)).rejects.toThrow();
        expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
        expect(
          (
            await db.query(
              "SELECT organization_upgrade_failure_evidence AS proof FROM billing_subscription_commands WHERE id=$1",
              [f.identity.commandId],
            )
          ).rows,
        ).toEqual([{ proof: null }]);
        expect(await financialState()).toEqual(before);
      } finally {
        await db.query(
          "DROP TRIGGER reject_void_incident_fixture ON billing_subscription_incidents; DROP FUNCTION reject_void_incident_fixture()",
        );
      }
      expect((await recover(f.identity)).status).toBe("failed");
    });
    test("void result requires live original lease and cannot override applied target evidence", async () => {
      const f = await voidOriginal();
      const { reconcileOrganizationUpgradeInvoiceEvent: route } = await import(
        "./organization-upgrade-invoice-event"
      );
      await route(invoiceDelivery("invoice.created"));
      const { finalizeVoidedOrganizationUpgrade: finalize } = await import(
        "../../db/repositories/organization-upgrade-void-finalization"
      );
      await expect(
        finalize({
          ...f.identity,
          leaseToken: f.claim.command.lease_token!,
          executionGeneration: f.claim.command.execution_generation,
          rawInvoice: objects.rawInvoice,
          rawSubscription: objects.rawSubscription,
          rawPaymentIntent: voidIntent,
        }),
      ).rejects.toMatchObject({ context: { reason: "original_lease_unavailable" } });
      const before = await financialState();
      const oldSubscription = objects.rawSubscription;
      objects.rawSubscription = structuredClone(oldSubscription);
      Object.assign(objects.rawSubscription.items.data[0]!.price, {
        id: f.quote.provider_binding!.targetPriceId,
        product: f.quote.provider_binding!.targetProductId,
        unit_amount: f.quote.review.targetBaseAmountCents,
      });
      const { recordOrganizationUpgradeHistoricalTarget: retain } = await import(
        "../../db/repositories/organization-upgrade-historical-targets"
      );
      await retain({ ...f.identity, raw: historicalEvent() });
      objects.rawSubscription = oldSubscription;
      const { reconcileOriginalOrganizationUpgrade: recover } = await import(
        "./organization-upgrade-recovery"
      );
      await expect(recover(f.identity)).rejects.toMatchObject({
        context: { reason: "missing_origin_or_conflicting_target" },
      });
      expect(await financialState()).toEqual(before);
      await expect(
        db.query(
          "UPDATE billing_subscription_commands SET status='FAILED',error_code='ORIGINAL_UPGRADE_INVOICE_VOID',completed_at=clock_timestamp() WHERE id=$1",
          [f.identity.commandId],
        ),
      ).rejects.toThrow();
    });
    test("renewal resolves the void original and grants only the unchanged plan's next period", async () => {
      const second = Math.floor(Date.now() / 1000);
      const f = await voidOriginal({
        start: new Date((second - 86400) * 1000),
        end: new Date((second + 5) * 1000),
      });
      await Bun.sleep(
        Math.max(0, fixtureData.source.current_period_end.getTime() - Date.now() + 20),
      );
      renewal = renewalPaidObjects(fixtureData.source, objects.rawSubscription, {
        start: second + 5,
        end: second + 86405,
      });
      objects.rawSubscription = renewal.subscription;
      const { reconcileStripePaidRenewal: renew } = await import("./stripe-paid-renewal");
      const event = {
        id: `evt_voidrenewal${f.identity.subscriptionId.replaceAll("-", "")}`,
        object: "event",
        type: "invoice.paid",
        api_version: "2024-11-20.acacia",
        created: second + 5,
        livemode: false,
        data: { object: renewal.invoice },
      };
      const message = {
        kind: "stripe.event",
        eventId: event.id,
        eventType: event.type,
        event,
        receivedAt: Date.now(),
      } as Parameters<typeof renew>[0];
      await renew(message);
      expect((await state(f.identity.commandId)).status).toBe("FAILED");
      expect(
        (
          await db.query(
            "SELECT plan_key,lifecycle_revision FROM billing_subscriptions WHERE id=$1",
            [f.identity.subscriptionId],
          )
        ).rows,
      ).toEqual([{ plan_key: "plus_monthly", lifecycle_revision: "2" }]);
      const balances = async () =>
        (
          await db.query(
            "SELECT available_amount, expires_at<=clock_timestamp() AS expired FROM subscription_allowance_periods WHERE organization_id=$1 ORDER BY period_start",
            [f.identity.organizationId],
          )
        ).rows;
      expect(await balances()).toEqual([
        { available_amount: "25.000000", expired: true },
        { available_amount: "25.000000", expired: false },
      ]);
      await renew(message);
      expect(await balances()).toEqual([
        { available_amount: "25.000000", expired: true },
        { available_amount: "25.000000", expired: false },
      ]);
      expect(mutation).toHaveBeenCalledTimes(1);
    }, 15000);

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
      expect(
        (
          await db.query("SELECT status FROM billing_subscription_incidents WHERE command_id=$1", [
            f.identity.commandId,
          ])
        ).rows,
      ).toEqual([{ status: "resolved" }]);
      expect((await record({ ...issue, issueCode: null })).resolved).toBe(0);
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

    function invoiceDelivery(type: "invoice.created" | "invoice.paid") {
      const event = {
        id: `evt_${type.replaceAll(".", "")}${fixtureData.input.subscriptionId.replaceAll("-", "")}`,
        object: "event",
        type,
        api_version: "2024-11-20.acacia",
        created: objects.rawInvoice.created,
        livemode: false,
        request:
          type === "invoice.created"
            ? { id: `req_${schema.replaceAll("_", "")}`, idempotency_key: originalKey }
            : null,
        data: { object: objects.rawInvoice },
      };
      return {
        kind: "stripe.event",
        eventId: event.id,
        eventType: type,
        receivedAt: Date.now(),
        event,
      } as import("../../types/stripe-queue-message").StripeEventMessage;
    }
    test("invoice webhooks persist original attribution then recover once, including revoked actor and duplicate delivery", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await expiredLease(f.identity.commandId);
      await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
      const { reconcileOrganizationUpgradeInvoiceEvent: route } = await import(
        "./organization-upgrade-invoice-event"
      );
      const { recordOrganizationUpgradeRecoveryOutcome: record } = await import(
        "../../db/repositories/organization-upgrade-recovery-incidents"
      );
      await record({ ...f.identity, issueCode: "UPGRADE_RECOVERY_UNAVAILABLE" });
      expect(await route(invoiceDelivery("invoice.created"))).toEqual({ owned: true });
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect(await route(invoiceDelivery("invoice.created"))).toEqual({ owned: true });
      expect(await route(invoiceDelivery("invoice.paid"))).toEqual({ owned: true });
      expect(await route(invoiceDelivery("invoice.paid"))).toEqual({ owned: true });
      expect((await state(f.identity.commandId)).status).toBe("APPLIED");
      expect(
        (
          await db.query("SELECT status FROM billing_subscription_incidents WHERE command_id=$1", [
            f.identity.commandId,
          ])
        ).rows[0].status,
      ).toBe("resolved");
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("paid before creation remains retryable until the original receipt arrives", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await expiredLease(f.identity.commandId);
      const { reconcileOrganizationUpgradeInvoiceEvent: route } = await import(
        "./organization-upgrade-invoice-event"
      );
      await expect(route(invoiceDelivery("invoice.paid"))).rejects.toThrow(
        "requires reconciliation",
      );
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      await route(invoiceDelivery("invoice.created"));
      expect(await route(invoiceDelivery("invoice.paid"))).toEqual({ owned: true });
      expect(mutation).toHaveBeenCalledTimes(1);
    });
    test("event identity, platform and version mismatches cannot attribute a command", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      const { reconcileOrganizationUpgradeInvoiceEvent: route } = await import(
        "./organization-upgrade-invoice-event"
      );
      const valid = invoiceDelivery("invoice.created");
      for (const changes of [
        { account: "acct_foreign" },
        { context: "acct_foreign" },
        { api_version: "2025-03-31.basil" },
        { livemode: true },
      ]) {
        await expect(
          route({ ...valid, event: { ...valid.event, ...changes } } as typeof valid),
        ).rejects.toThrow();
      }
      await expect(route({ ...valid, eventId: "evt_wrong" })).rejects.toThrow();
      await expect(route({ ...valid, eventType: "invoice.paid" })).rejects.toThrow();
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM organization_upgrade_invoice_origins WHERE command_id=$1",
            [f.identity.commandId],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    test("wrong request, customer, subscription or mode never bind another tenant's command", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      const { reconcileOrganizationUpgradeInvoiceEvent: route } = await import(
        "./organization-upgrade-invoice-event"
      );
      const valid = invoiceDelivery("invoice.created");
      for (const changes of [
        { customer: "cus_foreign" },
        { subscription: "sub_foreign" },
        { livemode: true },
      ]) {
        const event = {
          ...valid.event,
          livemode: changes.livemode ?? false,
          data: { object: { ...objects.rawInvoice, ...changes } },
        };
        expect(await route({ ...valid, event } as typeof valid)).toEqual({ owned: false });
      }
      expect(
        await route({
          ...valid,
          event: {
            ...valid.event,
            request: { id: "req_foreign", idempotency_key: "foreign-request" },
          },
        }),
      ).toEqual({ owned: false });
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
    });
    test("an attributed paid event cannot steal an active observation lease", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      const { reconcileOrganizationUpgradeInvoiceEvent: route } = await import(
        "./organization-upgrade-invoice-event"
      );
      await route(invoiceDelivery("invoice.created"));
      expect(await route(invoiceDelivery("invoice.paid"))).toEqual({ owned: true });
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect(mutation).toHaveBeenCalledTimes(1);
    });

    test("a paid payload cannot replace receipt identity or override the retrieved unpaid state", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await expiredLease(f.identity.commandId);
      const { reconcileOrganizationUpgradeInvoiceEvent: route } = await import(
        "./organization-upgrade-invoice-event"
      );
      await route(invoiceDelivery("invoice.created"));
      const created = invoiceDelivery("invoice.created");
      const paid = invoiceDelivery("invoice.paid");
      const foreignObject = { ...objects.rawInvoice, id: "in_unrelated" };
      await expect(
        route({
          ...created,
          event: { ...created.event, data: { object: foreignObject } },
        } as typeof created),
      ).rejects.toThrow();
      await expect(
        route({
          ...paid,
          event: { ...paid.event, data: { object: foreignObject } },
        } as typeof paid),
      ).rejects.toThrow();
      pending = true;
      expect(await route(paid)).toEqual({ owned: true });
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect(mutation).toHaveBeenCalledTimes(1);
      pending = false;
      expect(await route(paid)).toEqual({ owned: true });
      expect((await state(f.identity.commandId)).status).toBe("APPLIED");
    });
    test("a real second tenant cannot use the first tenant's original request key", async () => {
      const first = await seed();
      writeFailure = true;
      await expect(dispatch(first.identity, first.claim, async () => {})).rejects.toThrow();
      const firstKey = originalKey;
      const second = await seed();
      writeFailure = true;
      await expect(dispatch(second.identity, second.claim, async () => {})).rejects.toThrow();
      const { reconcileOrganizationUpgradeInvoiceEvent: route } = await import(
        "./organization-upgrade-invoice-event"
      );
      originalKey = firstKey;
      expect(await route(invoiceDelivery("invoice.created"))).toEqual({ owned: false });
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM organization_upgrade_invoice_origins WHERE command_id IN ($1,$2)",
            [first.identity.commandId, second.identity.commandId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect((await state(first.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect((await state(second.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
    });

    function historicalEvent() {
      return {
        id: `evt_target${fixtureData.input.subscriptionId.replaceAll("-", "")}`,
        object: "event",
        type: "customer.subscription.pending_update_applied",
        api_version: "2024-11-20.acacia",
        created: objects.rawInvoice.created,
        livemode: false,
        data: { object: { ...objects.rawSubscription, latest_invoice: objects.rawInvoice.id } },
      };
    }
    test("historical target receipt is immutable, idempotent and performs no financial publication", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      const { reconcileOrganizationUpgradeInvoiceEvent: route } = await import(
        "./organization-upgrade-invoice-event"
      );
      await route(invoiceDelivery("invoice.created"));
      const { recordOrganizationUpgradeHistoricalTarget: record } = await import(
        "../../db/repositories/organization-upgrade-historical-targets"
      );
      const input = { ...f.identity, raw: historicalEvent() };
      expect((await record(input)).created).toBe(true);
      expect((await record(input)).created).toBe(false);
      expect(
        (await record({ ...input, raw: { ...input.raw, id: `${input.raw.id}second` } })).created,
      ).toBe(false);
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM subscription_allowance_transactions WHERE organization_id=$1",
            [f.identity.organizationId],
          )
        ).rows[0].n,
      ).toBe(1);
      await expect(
        db.query(
          "UPDATE organization_upgrade_historical_targets SET invoice_id='in_other' WHERE command_id=$1",
          [f.identity.commandId],
        ),
      ).rejects.toThrow();
      await expect(
        db.query("DELETE FROM organization_upgrade_historical_targets WHERE command_id=$1", [
          f.identity.commandId,
        ]),
      ).rejects.toThrow();
      await expect(
        record({
          ...input,
          raw: {
            ...input.raw,
            data: { object: { ...input.raw.data.object, metadata: { changed: "payload" } } },
          },
        }),
      ).rejects.toThrow();
    });
    test("historical target persistence rejects missing origin, foreign tenant and conflicting invoice", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      const { recordOrganizationUpgradeHistoricalTarget: record } = await import(
        "../../db/repositories/organization-upgrade-historical-targets"
      );
      const input = { ...f.identity, raw: historicalEvent() };
      await expect(record(input)).rejects.toThrow();
      const { reconcileOrganizationUpgradeInvoiceEvent: route } = await import(
        "./organization-upgrade-invoice-event"
      );
      await route(invoiceDelivery("invoice.created"));
      await expect(record({ ...input, organizationId: randomUUID() })).rejects.toThrow();
      await expect(
        record({
          ...input,
          raw: {
            ...input.raw,
            data: { object: { ...input.raw.data.object, latest_invoice: "in_other" } },
          },
        }),
      ).rejects.toThrow();
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM organization_upgrade_historical_targets WHERE command_id=$1",
            [f.identity.commandId],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    test("late target evidence validates against original revision after the command applies", async () => {
      const f = await seed();
      await dispatch(f.identity, f.claim, async () => {});
      expect((await state(f.identity.commandId)).status).toBe("APPLIED");
      const { recordOrganizationUpgradeHistoricalTarget: record } = await import(
        "../../db/repositories/organization-upgrade-historical-targets"
      );
      const receipt = await record({ ...f.identity, raw: historicalEvent() });
      expect(receipt.created).toBe(true);
      expect(receipt.receipt.raw_subscription.latest_invoice).toBe(objects.rawInvoice.id);
      expect(mutation).toHaveBeenCalledTimes(1);
    });

    test("database receipt guard rejects incomplete identity and an altered reviewed period", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      const { reconcileOrganizationUpgradeInvoiceEvent: route } = await import(
        "./organization-upgrade-invoice-event"
      );
      await route(invoiceDelivery("invoice.created"));
      const event = historicalEvent();
      for (const raw of [
        { ...event.data.object, customer: null },
        { ...event.data.object, current_period_end: event.data.object.current_period_end + 1 },
        { ...event.data.object, pending_update: { expires_at: event.created + 60 } },
      ]) {
        await expect(
          db.query(
            `INSERT INTO organization_upgrade_historical_targets(command_id,organization_id,provider_event_id,event_type,api_version,livemode,invoice_id,event_created_at,observed_at,evidence_digest,raw_subscription) VALUES($1,$2,$3,$4,$5,false,$6,to_timestamp($7),clock_timestamp(),$8,$9::jsonb)`,
            [
              f.identity.commandId,
              f.identity.organizationId,
              event.id,
              event.type,
              event.api_version,
              objects.rawInvoice.id,
              event.created,
              "a".repeat(64),
              JSON.stringify(raw),
            ],
          ),
        ).rejects.toThrow();
      }
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM organization_upgrade_historical_targets WHERE command_id=$1",
            [f.identity.commandId],
          )
        ).rows[0].n,
      ).toBe(0);
    });

    test("subscription target delivery retains evidence, recovers payment and replays without hiding later updates", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await expiredLease(f.identity.commandId);
      const { reconcileOrganizationUpgradeInvoiceEvent: invoiceRoute } = await import(
        "./organization-upgrade-invoice-event"
      );
      const { reconcileOrganizationUpgradeSubscriptionEvent: route } = await import(
        "./organization-upgrade-subscription-event"
      );
      const event = historicalEvent();
      const message = {
        kind: "stripe.event",
        eventId: event.id,
        eventType: event.type,
        event,
        receivedAt: Date.now(),
      } as Parameters<typeof route>[0];
      await expect(route(message, objects.rawSubscription)).rejects.toMatchObject({
        context: { reason: "original_invoice_receipt_pending" },
      });
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      await invoiceRoute(invoiceDelivery("invoice.created"));
      const { recordOrganizationUpgradeRecoveryOutcome: record } = await import(
        "../../db/repositories/organization-upgrade-recovery-incidents"
      );
      await record({ ...f.identity, issueCode: "UPGRADE_RECOVERY_UNAVAILABLE" });

      expect(await route(message, objects.rawSubscription)).toEqual({ owned: true });
      expect((await state(f.identity.commandId)).status).toBe("APPLIED");
      expect(
        (
          await db.query("SELECT status FROM billing_subscription_incidents WHERE command_id=$1", [
            f.identity.commandId,
          ])
        ).rows,
      ).toEqual([{ status: "resolved" }]);

      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM organization_upgrade_historical_targets WHERE command_id=$1",
            [f.identity.commandId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(await route(message, objects.rawSubscription)).toEqual({ owned: true });
      const update = { ...event, id: `${event.id}update`, type: "customer.subscription.updated" };
      // A later ordinary edit is not original target evidence and must reach the current lifecycle owner.
      update.data = {
        object: {
          ...event.data.object,
          current_period_end: event.data.object.current_period_end + 1,
        },
      };

      expect(
        await route(
          { ...message, eventId: update.id, event: update, eventType: update.type } as Parameters<
            typeof route
          >[0],
          objects.rawSubscription,
        ),
      ).toEqual({ owned: false });
      expect(mutation).toHaveBeenCalledTimes(1);
    });

    test("subscription event identity and target mismatches cannot retain evidence or publish", async () => {
      const f = await seed();
      const { reconcileOrganizationUpgradeSubscriptionEvent: beforeDispatch } = await import(
        "./organization-upgrade-subscription-event"
      );
      const unrelated = { ...historicalEvent(), api_version: null };
      expect(
        await beforeDispatch(
          {
            kind: "stripe.event",
            eventId: unrelated.id,
            eventType: unrelated.type,
            event: unrelated,
            receivedAt: Date.now(),
          } as Parameters<typeof beforeDispatch>[0],
          objects.rawSubscription,
        ),
      ).toEqual({ owned: false });
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await expiredLease(f.identity.commandId);
      const { reconcileOrganizationUpgradeInvoiceEvent: invoiceRoute } = await import(
        "./organization-upgrade-invoice-event"
      );
      const { reconcileOrganizationUpgradeSubscriptionEvent: route } = await import(
        "./organization-upgrade-subscription-event"
      );
      await invoiceRoute(invoiceDelivery("invoice.created"));
      const original = historicalEvent();
      for (const event of [
        { ...original, api_version: "2025-03-31.basil" },
        { ...original, api_version: null },
        { ...original, account: "acct_other" },
        { ...original, data: { object: { ...original.data.object, latest_invoice: "in_other" } } },
        {
          ...original,
          data: {
            object: {
              ...original.data.object,
              current_period_end: original.data.object.current_period_end + 1,
            },
          },
        },
      ]) {
        const message = {
          kind: "stripe.event",
          eventId: event.id,
          eventType: event.type,
          event,
          receivedAt: Date.now(),
        } as Parameters<typeof route>[0];
        await expect(route(message, objects.rawSubscription)).rejects.toThrow();
      }
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM organization_upgrade_historical_targets WHERE command_id=$1",
            [f.identity.commandId],
          )
        ).rows[0].n,
      ).toBe(0);
    });

    test("pending and old-price subscription updates remain owned without invented target evidence", async () => {
      const f = await seed();
      pending = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await expiredLease(f.identity.commandId);
      const { reconcileOrganizationUpgradeInvoiceEvent: invoiceRoute } = await import(
        "./organization-upgrade-invoice-event"
      );
      const { reconcileOrganizationUpgradeSubscriptionEvent: route } = await import(
        "./organization-upgrade-subscription-event"
      );
      await invoiceRoute(invoiceDelivery("invoice.created"));
      const original = historicalEvent();
      const old = structuredClone(original.data.object);
      old.items.data[0]!.price.id = "price_plus";
      for (const object of [
        { ...original.data.object, pending_update: { expires_at: original.created + 60 } },
        old,
      ]) {
        const event = { ...original, type: "customer.subscription.updated", data: { object } };
        const message = {
          kind: "stripe.event",
          eventId: event.id,
          eventType: event.type,
          event,
          receivedAt: Date.now(),
        } as Parameters<typeof route>[0];
        expect(await route(message, objects.rawSubscription)).toEqual({ owned: true });
      }
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM organization_upgrade_historical_targets WHERE command_id=$1",
            [f.identity.commandId],
          )
        ).rows[0].n,
      ).toBe(0);
    });

    test("historical target capture cannot override live cancellation or unpaid invoice", async () => {
      const f = await seed();
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await expiredLease(f.identity.commandId);
      const { reconcileOrganizationUpgradeInvoiceEvent: invoiceRoute } = await import(
        "./organization-upgrade-invoice-event"
      );
      const { reconcileOrganizationUpgradeSubscriptionEvent: route } = await import(
        "./organization-upgrade-subscription-event"
      );
      await invoiceRoute(invoiceDelivery("invoice.created"));
      const event = historicalEvent();
      const message = {
        kind: "stripe.event",
        eventId: event.id,
        eventType: event.type,
        event,
        receivedAt: Date.now(),
      } as Parameters<typeof route>[0];
      expect(
        await route(message, { ...objects.rawSubscription, cancel_at_period_end: true }),
      ).toEqual({ owned: false });
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      pending = true;
      expect(await route(message, objects.rawSubscription)).toEqual({ owned: true });
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect(mutation).toHaveBeenCalledTimes(1);
    });

    test("renewal delivery first settles the lost original upgrade then grants the new period once", async () => {
      const second = Math.floor(Date.now() / 1000);
      const f = await seed({
        start: new Date((second - 86400) * 1000),
        end: new Date((second + 5) * 1000),
      });
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      historicalTargetEvent = historicalEvent();
      const { recordOrganizationUpgradeRecoveryOutcome: record } = await import(
        "../../db/repositories/organization-upgrade-recovery-incidents"
      );
      await record({ ...f.identity, issueCode: "UPGRADE_RECOVERY_UNAVAILABLE" });

      await expiredLease(f.identity.commandId);
      await Bun.sleep(
        Math.max(0, fixtureData.source.current_period_end.getTime() - Date.now() + 20),
      );
      renewal = renewalPaidObjects(
        { ...fixtureData.source, plan_key: "pro_monthly" },
        objects.rawSubscription,
        { start: second + 5, end: second + 86405 },
      );
      objects.rawSubscription = renewal.subscription;
      const { reconcileStripePaidRenewal: renew } = await import("./stripe-paid-renewal");
      const event = {
        id: `evt_renewal${f.identity.subscriptionId.replaceAll("-", "")}`,
        object: "event",
        type: "invoice.paid",
        api_version: "2024-11-20.acacia",
        created: second + 5,
        livemode: false,
        data: { object: renewal.invoice },
      };
      const message = {
        kind: "stripe.event",
        eventId: event.id,
        eventType: event.type,
        event,
        receivedAt: Date.now(),
      } as Parameters<typeof renew>[0];
      await renew(message);
      expect((await state(f.identity.commandId)).status).toBe("APPLIED");
      expect(
        (
          await db.query("SELECT status FROM billing_subscription_incidents WHERE command_id=$1", [
            f.identity.commandId,
          ])
        ).rows,
      ).toEqual([{ status: "resolved" }]);

      const rows = (
        await db.query(
          "SELECT plan_key, lifecycle_revision, current_period_start FROM billing_subscriptions WHERE id=$1",
          [f.identity.subscriptionId],
        )
      ).rows;
      expect(rows[0].plan_key).toBe("pro_monthly");
      expect(rows[0].lifecycle_revision).toBe("3");
      expect(rows[0].current_period_start.getTime()).toBe((second + 5) * 1000);
      const balances = async () =>
        (
          await db.query(
            "SELECT available_amount FROM subscription_allowance_periods WHERE organization_id=$1 ORDER BY period_start",
            [f.identity.organizationId],
          )
        ).rows;
      expect(await balances()).toEqual([
        { available_amount: "0.000000" },
        { available_amount: "90.000000" },
      ]);
      await renew(message);
      expect(await balances()).toEqual([
        { available_amount: "0.000000" },
        { available_amount: "90.000000" },
      ]);
      expect(mutation).toHaveBeenCalledTimes(1);
    }, 15000);

    test("applied renewal replay ignores a later unsettled upgrade", async () => {
      const second = Math.floor(Date.now() / 1000);
      const f = await seed({
        start: new Date((second - 86400) * 1000),
        end: new Date((second + 5) * 1000),
      });
      await expiredLease(f.identity.commandId);
      await Bun.sleep(
        Math.max(0, fixtureData.source.current_period_end.getTime() - Date.now() + 20),
      );
      renewal = renewalPaidObjects(fixtureData.source, fixtureData.provider, {
        start: second + 5,
        end: second + 86405,
      });
      objects.rawSubscription = renewal.subscription;
      fixtureData.provider = renewal.subscription;
      const { reconcileStripePaidRenewal: renew } = await import("./stripe-paid-renewal");
      const event = {
        id: `evt_replay${f.identity.subscriptionId.replaceAll("-", "")}`,
        object: "event",
        type: "invoice.paid",
        api_version: "2024-11-20.acacia",
        created: second + 5,
        livemode: false,
        data: { object: renewal.invoice },
      };
      const message = {
        kind: "stripe.event",
        eventId: event.id,
        eventType: event.type,
        event,
        receivedAt: Date.now(),
      } as Parameters<typeof renew>[0];
      await renew(message);
      const { readOrganizationPlanChangeSource } = await import(
        "../../db/repositories/organization-plan-change"
      );
      fixtureData.input = {
        ...fixtureData.input,
        expectedSubscriptionRevision: 2,
        idempotencyKey: randomUUID(),
      };
      const captured = await readOrganizationPlanChangeSource(fixtureData.input);
      fixtureData.source = captured.source;
      fixtureData.provider = renewal.subscription;
      const { createOrganizationUpgradeQuote } = await import("./organization-upgrade-preview");
      const quote = await createOrganizationUpgradeQuote(
        { ...fixtureData.input, targetPlanKey: "pro_monthly" },
        async () => {},
      );
      objects = upgradePaidObjects({
        ...fixtureData,
        captured,
        review: quote.review,
        providerBinding: quote.provider_binding!,
      });
      const { prepareOrganizationUpgrade } = await import(
        "../../db/repositories/organization-upgrade-commands"
      );
      const { claimOrganizationUpgrade } = await import(
        "../../db/repositories/organization-upgrade-execution"
      );
      const { command } = await prepareOrganizationUpgrade({
        ...fixtureData.input,
        quoteId: quote.id,
      });
      originalKey = command.provider_idempotency_key;
      const later = { ...fixtureData.input, commandId: command.id };
      const claim = await claimOrganizationUpgrade(later);
      if (!claim) throw new Error("Expected later upgrade claim");
      pending = true;
      await expect(dispatch(later, claim, async () => {})).rejects.toThrow();
      expect((await state(later.commandId)).status).toBe("OUTCOME_UNKNOWN");
      const before = (
        await db.query(
          "SELECT count(*)::int n FROM subscription_allowance_periods WHERE organization_id=$1",
          [later.organizationId],
        )
      ).rows[0].n;
      await renew(message);
      expect((await state(later.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM subscription_allowance_periods WHERE organization_id=$1",
            [later.organizationId],
          )
        ).rows[0].n,
      ).toBe(before);
      expect(mutation).toHaveBeenCalledTimes(1);
    }, 15000);

    for (const started of [true, false])
      test(`renewal publication serializes against upgrade dispatch: started=${started}`, async () => {
        const second = Math.floor(Date.now() / 1000);
        const f = await seed({
          start: new Date((second - 86400) * 1000),
          end: new Date((second + 5) * 1000),
        });
        if (started) {
          pending = true;
          await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
        }
        await Bun.sleep(
          Math.max(0, fixtureData.source.current_period_end.getTime() - Date.now() + 20),
        );
        const paid = renewalPaidObjects(fixtureData.source, fixtureData.provider, {
          start: second + 5,
          end: second + 86405,
        });
        const { subscriptionBillingOperationsRepository: operations } = await import(
          "../../db/repositories/subscription-billing-operations"
        );
        const eventId = `evt_renewal${f.identity.subscriptionId.replaceAll("-", "")}`;
        const created = new Date();
        const receipt = await operations.recordEvent({
          organizationId: f.identity.organizationId,
          subscriptionId: f.identity.subscriptionId,
          providerEventId: eventId,
          eventType: "invoice.paid",
          providerObjectType: "invoice",
          providerObjectId: paid.invoice.id,
          livemode: false,
          eventCreatedAt: created,
          payloadDigest: "a".repeat(64),
          now: created,
        });
        const leaseToken = randomUUID();
        expect(
          await operations.claimEvent({
            organizationId: f.identity.organizationId,
            receiptId: receipt.value.id,
            leaseToken,
            leaseDurationMs: 60000,
          }),
        ).toBeTruthy();
        const { finalizePaidRenewal } = await import(
          "../../db/repositories/subscription-renewal-finalization"
        );
        const publication = finalizePaidRenewal({
          ...paid,
          organizationId: f.identity.organizationId,
          subscriptionId: f.identity.subscriptionId,
          invoiceId: paid.invoice.id,
          receiptId: receipt.value.id,
          leaseToken,
          expectedSubscriptionRevision: 1,
          expectedProjectionRevision: 1,
          providerEventId: eventId,
          eventCreatedAt: created,
        });
        if (started)
          await expect(publication).rejects.toMatchObject({
            code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
            context: { reason: "original_upgrade_unsettled" },
          });
        else {
          expect((await publication).replayed).toBe(false);
          await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
          expect(mutation).not.toHaveBeenCalled();
        }
        if (started) {
          const { claimSubscriptionReconciliation, finalizeSubscriptionReconciliation } =
            await import("../../db/repositories/subscription-reconciliation");
          const scan = await claimSubscriptionReconciliation(f.identity);
          if (!scan) throw new Error("Expected fresh reconciliation claim");
          await expect(
            finalizeSubscriptionReconciliation(scan, {
              kind: "paid_renewal",
              invoiceId: paid.invoice.id,
              objects: paid,
            }),
          ).rejects.toMatchObject({
            code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
            context: { reason: "original_upgrade_unsettled" },
          });
        }
        expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
        expect(
          (
            await db.query("SELECT lifecycle_revision FROM billing_subscriptions WHERE id=$1", [
              f.identity.subscriptionId,
            ])
          ).rows[0].lifecycle_revision,
        ).toBe(started ? "1" : "2");
        expect(
          (
            await db.query(
              "SELECT count(*)::int n FROM subscription_allowance_periods WHERE organization_id=$1",
              [f.identity.organizationId],
            )
          ).rows[0].n,
        ).toBe(started ? 1 : 2);
      }, 10000);

    test("renewal ordering retains an unpaid upgrade without new allowance", async () => {
      const f = await seed();
      pending = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      await expiredLease(f.identity.commandId);
      const { reconcileOrganizationUpgradesBeforeRenewal: order } = await import(
        "./organization-upgrade-renewal-ordering"
      );
      await expect(order(f.identity)).rejects.toThrow();
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM subscription_allowance_periods WHERE organization_id=$1",
            [f.identity.organizationId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(mutation).toHaveBeenCalledTimes(1);
    });

    test("expired observation lease retains historical evidence for a new claimant", async () => {
      const second = Math.floor(Date.now() / 1000);
      const f = await seed({
        start: new Date((second - 86400) * 1000),
        end: new Date((second + 5) * 1000),
      });
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      historicalTargetEvent = historicalEvent();
      await expiredLease(f.identity.commandId);
      await Bun.sleep(
        Math.max(0, fixtureData.source.current_period_end.getTime() - Date.now() + 20),
      );
      objects.rawSubscription = {
        ...objects.rawSubscription,
        current_period_start: second + 5,
        current_period_end: second + 86405,
      };
      afterTargetSearch = async () => {
        await expiredLease(f.identity.commandId);
      };
      const { reconcileOriginalOrganizationUpgrade: recover } = await import(
        "./organization-upgrade-recovery"
      );
      await expect(recover(f.identity)).rejects.toThrow();
      expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM organization_upgrade_historical_targets WHERE command_id=$1",
            [f.identity.commandId],
          )
        ).rows[0].n,
      ).toBe(1);
      historicalTargetEvent = null;
      voidIntent = null;
      afterTargetSearch = async () => {
        throw new Error("Retained target must prevent a repeated search");
      };
      expect((await recover(f.identity)).status).toBe("applied");
      expect(mutation).toHaveBeenCalledTimes(1);
    }, 10000);

    test("lost response after renewal searches and retains historical target before original settlement", async () => {
      const second = Math.floor(Date.now() / 1000);
      const f = await seed({
        start: new Date((second - 86400) * 1000),
        end: new Date((second + 5) * 1000),
      });
      writeFailure = true;
      await expect(dispatch(f.identity, f.claim, async () => {})).rejects.toThrow();
      historicalTargetEvent = historicalEvent();
      await expiredLease(f.identity.commandId);
      await Bun.sleep(
        Math.max(0, fixtureData.source.current_period_end.getTime() - Date.now() + 20),
      );
      objects.rawSubscription = {
        ...objects.rawSubscription,
        current_period_start: second + 5,
        current_period_end: second + 86405,
      };
      const { reconcileOriginalOrganizationUpgrade: recover } = await import(
        "./organization-upgrade-recovery"
      );
      expect((await recover(f.identity)).status).toBe("applied");
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM organization_upgrade_historical_targets WHERE command_id=$1",
            [f.identity.commandId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await db.query(
            "SELECT available_amount FROM subscription_allowance_periods WHERE organization_id=$1",
            [f.identity.organizationId],
          )
        ).rows[0].available_amount,
      ).toBe("0.000000");
      expect(mutation).toHaveBeenCalledTimes(1);
      historicalTargetEvent = null;
      voidIntent = null;
      expect((await recover(f.identity)).status).toBe("applied");
    }, 10000);
  },
);
