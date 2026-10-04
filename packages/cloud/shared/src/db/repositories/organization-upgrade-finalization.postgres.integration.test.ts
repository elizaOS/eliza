/** Real PostgreSQL atomic paid upgrade publication and concurrent allowance use. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
});
